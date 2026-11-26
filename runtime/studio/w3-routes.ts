import {
  isFactNotFound, isFactReadDenied, isFactUnavailable, type Db, type FactId, type Json,
} from '../../kernel/src/index.ts';
import { generateMasteryBridgeAnalogy, generateSpotTheFlawActivity, type MasteryBridgeResult, type SpotTheFlawResult } from '../../executors/teaching/adversarial-activity.ts';
import type { BackgroundLlmTransport } from '../../executors/teaching/background-llm.ts';
import type { ProviderSettings } from '../../executors/teaching/provider-settings.ts';
import { parseAdversarialInput, prepareAdversarialInput } from '../../modules/activity/adversarial-inputs.ts';
import { excludeAttemptIdOf, loadPaperItemBacktrace } from '../../modules/activity/backtrace-evidence.ts';
import { scanNearMissVerify } from '../../modules/activity/near-miss-scan.ts';
import { nearMissPoolEmpty, nearMissPoolHit } from '../../modules/content/near-miss-pool.ts';
import {
  confirmedEndpointCall, endpointEffectIdentity, finishEndpointResult, preConfirmNotionDispatch,
  readJsonBody, resolveAuthorizedProvider, rethrowEndpointError, runEndpointEffect, type EndpointFailure, type RoutePack,
} from './endpoint-kit.ts';
import { purpose, stableId, storageRead, studioHost, ulidExact } from './identity.ts';
import { inspectQuestion, loadExposedQuestionIds, type IssueBank } from './iqdb.ts';
import { loadAuthorizedRecordFlowSnapshot } from './record-flow.ts';
import { isPracticeWorkbook } from './sealed-practice.ts';
import { clientRequest, RequestError } from './sessions.ts';

type W3Deps = {
  readonly loadProvider?: () => Promise<ProviderSettings>;
  readonly transport?: BackgroundLlmTransport;
};

/** W3 thin host routes: workbook dual backtrace, adversarial activities and 0-LLM near-miss verification. */
export function w3RoutePack(db: Db, issueBank: IssueBank, deps: W3Deps = {}): RoutePack {
  const host = studioHost(db);
  const ulid = (value: string, label: string) =>
    ulidExact.test(value) ? value as FactId : (() => { throw new RequestError(400, `${label}无效。`); })();
  const unavailable = (error: unknown) => isFactNotFound(error) || isFactReadDenied(error) || isFactUnavailable(error);

  return kit => {
    kit.get('/api/papers/:ulid/items/:item/backtrace', async ([rawPaper, rawItem], url) => host.snapshot(async tx => {
      const paperId = ulid(rawPaper!, '试卷标识');
      const excludeAttemptId = excludeAttemptIdOf(url.searchParams.get('attemptId'));
      const { snap, snapshots } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose: 'storage' });
      const loaded = await loadPaperItemBacktrace({
        tx, read: storageRead(tx), paperId, itemId: rawItem!, snap, snapshots, unavailable,
        ...(excludeAttemptId !== undefined ? { excludeAttemptId } : {}),
        practice: await isPracticeWorkbook(tx, paperId),
      });
      return loaded.result;
    }));

    kit.raw('POST', '/api/activities/adversarial', async (req, res) => {
      const raw = await readJsonBody(req);
      const requestId = clientRequest(raw.requestId);
      const request = parseAdversarialInput(raw);
      await kit.runAbortable(res, async signal => {
        const resolution = (await resolveAuthorizedProvider({ loadProvider: deps.loadProvider }))!;
        const prepared = await host.snapshot(async tx => {
          const { snap, snapshots } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose, maySend: resolution.maySend });
          return { preparedInput: prepareAdversarialInput(snap, request), snapshots };
        });
        await preConfirmNotionDispatch(db, prepared.snapshots.values(), resolution.maySend, purpose).catch(rethrowEndpointError);
        const preparedInput = prepared.preparedInput;
        const sourceIds = 'sourceIds' in preparedInput.input ? preparedInput.input.sourceIds : [preparedInput.input.targetConceptId];
        const effectInput = { kind: preparedInput.kind, sourceIds, provider: resolution.provider.model };
        const result = await runEndpointEffect(db, endpointEffectIdentity(`adversarial-${preparedInput.kind}`, requestId, effectInput as Json),
          async (providerEffectId, checkDispatch) => {
            const failure: { current?: EndpointFailure } = {};
            const generated = await confirmedEndpointCall(db, checkDispatch, prepared.snapshots.values(), resolution.maySend,
              (): Promise<SpotTheFlawResult | MasteryBridgeResult> => {
                const options = {
                  provider: resolution.provider, requestId: providerEffectId,
                  ...(deps.transport ? { transport: deps.transport } : {}), signal,
                };
                return preparedInput.kind === 'spot_the_flaw'
                  ? generateSpotTheFlawActivity(preparedInput.input, options)
                  : generateMasteryBridgeAnalogy(preparedInput.input, options);
              }, failure, undefined, purpose, undefined, signal);
            if (!generated) {
              if (failure.current) return { failed: failure.current } as unknown as Json;
              throw new RequestError(502, '模型未返回有效活动内容。');
            }
            return generated as unknown as Json;
          }, { signal });
        return finishEndpointResult(result);
      });
    });

    kit.offline('/api/papers/:ulid/items/:item/near-miss-verify', async (input, watermark, [rawPaper, rawItem]) => {
      const requestId = clientRequest(input.requestId);
      const paperId = ulid(rawPaper!, '试卷标识');
      const scanned = await host.snapshot(async tx => {
        const { snap, snapshots } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose });
        return scanNearMissVerify({
          read: storageRead(tx), paperId, itemId: rawItem!, requestId, snap, snapshots,
          replayStableId: value => stableId('workbook-paper', value),
          exposed: () => loadExposedQuestionIds(tx),
          isPoolQuestion: async id => {
            const inspection = await inspectQuestion(tx, id);
            return Boolean(inspection && inspection.public.status === 'release_ready');
          },
        });
      });
      if ('replay' in scanned)
        return nearMissPoolHit({ questionId: scanned.replay.questionId }, scanned.replay.paperId, scanned.errorStage);
      const candidate = scanned.hit && scanned.candidate ? scanned.candidate : undefined;
      if (scanned.hit && candidate) {
        const issued = await host.lockedTx(async tx => issueBank(tx, {
          requestId, questionRefs: [{ id: candidate.id, rev: candidate.rev }], deletionWatermark: watermark,
        }));
        return nearMissPoolHit(scanned.hit, issued.id, scanned.errorStage);
      }
      return nearMissPoolEmpty(scanned.sourceQuestionId, scanned.errorStage);
    }, (result: unknown) => (result as { source: string }).source === 'variant_pool' ? 201 : 200);
  };
}
