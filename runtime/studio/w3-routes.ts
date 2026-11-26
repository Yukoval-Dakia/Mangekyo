import { createHash } from 'node:crypto';
import {
  isFactNotFound, isFactReadDenied, isFactUnavailable, readable, type Db, type FactId, type Json,
} from '../../kernel/src/index.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { assertDeletionWatermark } from '../../kernel/src/lifecycle.ts';
import { recordCompletedEffect } from '../../kernel/src/work/effects.ts';
import { generateMasteryBridgeAnalogy, generateSpotTheFlawActivity, type MasteryBridgeResult, type SpotTheFlawResult } from '../../executors/teaching/adversarial-activity.ts';
import type { BackgroundLlmTransport } from '../../executors/teaching/background-llm.ts';
import type { ProviderSettings } from '../../executors/teaching/provider-settings.ts';
import { parseAdversarialInput, prepareAdversarialInput } from '../../modules/activity/adversarial-inputs.ts';
import { excludeAttemptIdOf, loadPaperItemBacktrace } from '../../modules/activity/backtrace-evidence.ts';
import {
  nearMissPoolEmpty, nearMissPoolHit, readPaperItem, reopenNearMissReceipt, scanNearMissVerify,
} from '../../modules/activity/near-miss-scan.ts';
import {
  confirmedEndpointCall, endpointEffectIdentity, finishEndpointResult, preConfirmNotionDispatch,
  readJsonBody, resolveAuthorizedProvider, rethrowEndpointError, runEndpointEffect, type EndpointFailure, type RoutePack,
} from './endpoint-kit.ts';
import { purpose, stableId, storageRead, studioHost, studioLearner, ulidExact } from './identity.ts';
import { inspectQuestion, loadExposedQuestionIds, type IssueBank } from './iqdb.ts';
import { notionReadScope, notionSendBasis, verifyNotionFact } from './notion.ts';
import { loadAuthorizedRecordFlowSnapshot } from './record-flow.ts';
import { isPracticeWorkbook } from './sealed-practice.ts';
import { clientRequest, RequestError } from './sessions.ts';

type W3Deps = {
  readonly loadProvider?: () => Promise<ProviderSettings | null>;
  readonly transport?: BackgroundLlmTransport;
};

/** W3 thin host routes: workbook dual backtrace, adversarial activities and 0-LLM near-miss verification. */
export function w3RoutePack(db: Db, issueBank: IssueBank, deps: W3Deps = {}): RoutePack {
  const host = studioHost(db), nearMissOwner = stableId('studio-near-miss-verify');
  const ulid = (value: string, label: string) =>
    ulidExact.test(value) ? value as FactId : (() => { throw new RequestError(400, `${label}无效。`); })();
  const unavailable = (error: unknown) => isFactNotFound(error) || isFactReadDenied(error) || isFactUnavailable(error);
  const readChecks = { isReadDenied: isFactReadDenied, isNotFound: isFactNotFound, isUnavailable: unavailable };

  return kit => {
    kit.get('/api/papers/:ulid/items/:item/backtrace', async ([rawPaper, rawItem], url) =>
      notionReadScope(db, studioLearner, { readOnly: true }).read(async (tx, check) => {
        const paperId = ulid(rawPaper!, '试卷标识'), excludeAttemptId = excludeAttemptIdOf(url.searchParams.get('attemptId'));
        const { snap, snapshots } = await loadAuthorizedRecordFlowSnapshot(tx, {
          purpose: 'storage',
          include: async (_, fact) => Boolean(await readable(() => verifyNotionFact(tx, fact, 'storage', check, true))),
        });
        return (await loadPaperItemBacktrace({
          tx, read: storageRead(tx), paperId, itemId: rawItem!, snap, snapshots, unavailable, readChecks,
          ...(excludeAttemptId !== undefined ? { excludeAttemptId } : {}), practice: await isPracticeWorkbook(tx, paperId),
        })).result;
      }));

    kit.raw('POST', '/api/activities/adversarial', async (req, res) => {
      const raw = await readJsonBody(req), requestId = clientRequest(raw.requestId), request = parseAdversarialInput(raw);
      await kit.runAbortable(res, async signal => {
        const resolution = (await resolveAuthorizedProvider({ loadProvider: deps.loadProvider }))!;
        const prepared = await host.snapshot(async tx => {
          const { snap, snapshots } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose, maySend: resolution.maySend });
          return { preparedInput: prepareAdversarialInput(snap, request), snapshots };
        });
        const notionWitnesses = await preConfirmNotionDispatch(db, prepared.snapshots.values(), resolution.maySend, purpose)
          .catch(rethrowEndpointError);
        const preparedInput = prepared.preparedInput;
        const effectInput = { ...request, provider: resolution.provider.model };
        const result = await runEndpointEffect(db, endpointEffectIdentity('adversarial', requestId, effectInput as Json),
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
          }, { ...(notionWitnesses.length ? { authorize: async tx => { await notionSendBasis(tx, notionWitnesses, resolution.maySend, undefined, purpose); } } : {}),
            signal });
        return finishEndpointResult(result);
      });
    });

    kit.offline('/api/papers/:ulid/items/:item/near-miss-verify', async (raw, watermark, [rawPaper, rawItem]) => {
      const requestId = clientRequest(raw.requestId), paperId = ulid(rawPaper!, '试卷标识'), itemId = rawItem!;
      const effectInput = { paperId, itemId } as Json;
      const digest = createHash('sha256').update(canonicalJsonString(effectInput)).digest('hex');
      return host.lockedTx(async tx => {
        await assertDeletionWatermark(tx, watermark);
        const read = storageRead(tx), opened = await readPaperItem(read, paperId, itemId, readChecks);
        const { rows: [saved] } = await tx.query<{ state: string; result: unknown; input_digest: string }>(
          `SELECT state, result, input_digest FROM effects
           WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2 AND step_key=$3 AND label='near-miss-verify'`,
          [tx.learner, nearMissOwner, requestId]);
        if (saved) {
          if (saved.input_digest !== digest || saved.state !== 'done')
            throw new RequestError(409, '同一请求标识已用于不同题项。', 'duplicate_request_conflict');
          return reopenNearMissReceipt(read, saved.result, readChecks);
        }
        const { snap, snapshots } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose });
        const scanned = await scanNearMissVerify({
          opened, paperId, itemId, snap, snapshots, exposed: () => loadExposedQuestionIds(tx),
          isPoolQuestion: async id => { const i = await inspectQuestion(tx, id); return Boolean(i && i.public.status === 'release_ready'); },
        });
        const outcome = scanned.hit && scanned.candidate
          ? nearMissPoolHit(scanned.hit, (await issueBank(tx, {
            requestId: stableId('near-miss-paper', requestId),
            questionRefs: [{ id: scanned.candidate.id, rev: scanned.candidate.rev }], deletionWatermark: watermark,
          })).id, scanned.errorStage)
          : nearMissPoolEmpty(scanned.sourceQuestionId, scanned.errorStage);
        await tx.withLearnerWrite(tick => recordCompletedEffect(tx, tick, {
          ownerKind: 'session', ownerId: nearMissOwner, stepKey: requestId, label: 'near-miss-verify',
          input: effectInput, result: outcome as Json,
        }));
        return outcome;
      });
    }, (result: unknown) => (result as { source: string }).source === 'variant_pool' ? 201 : 200);
  };
}
