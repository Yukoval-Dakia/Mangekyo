import { createHash } from 'node:crypto';
import {
  factId, isFactUnavailable, type Db, type DbTransaction, type FactSnapshot, type Json,
  type ReadTransaction, type Revision, type Tick,
} from '../../kernel/src/index.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { assertDeletionWatermark } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { buildKbGardeningPlan } from '../../modules/content/kb-gardening.ts';
import {
  bindEffectiveSlotRead, classifyGardeningError, executeGardeningCommands, loadGardeningInbox, makeContentVerifier,
  parseGardeningActionRequest, parseGardeningUndoRequest, readQuestionStateRev, runGardeningActions, runGardeningUndo,
  scanKbHostContent, type GardeningCommandSpec, type VerifyContentUse,
} from '../../modules/content/kb-gardening-host.ts';
import {
  createNotionFlowInclude, evaluatePlaybookHost, loadPlaybookRetireContext, readLivingMineRadarHost, scanPlaybookEntries,
} from '../../modules/companion/living-mine-host.ts';
import { captureSourceType } from '../../modules/capture/source.ts';
import type { RoutePack } from './endpoint-kit.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { studioHost, studioLearner } from './identity.ts';
import { createNotionReader, notionReadScope, NotionReadUnconfirmed, verifyNotionFact, type CheckNotionRead } from './notion.ts';
import { loadAuthorizedRecordFlowSnapshot } from './record-flow.ts';
import { clientRequest, RequestError } from './sessions.ts';

/** W4 thin host routes: kb gardening inbox/actions/undo plus living-mine radar and playbook effectiveness reads. */
export function w4RoutePack(
  db: Db,
  deps: { readonly carePause: { paused: (tx: ReadTransaction, now?: number) => Promise<boolean> }; readonly content: LoadedModule; readonly learner: LoadedModule },
): RoutePack {
  const host = studioHost(db);
  const digest = (input: unknown) => createHash('sha256').update(canonicalJsonString(input as Json)).digest('hex');
  const errChecks = { isUnavailable: isFactUnavailable, isNotionUnconfirmed: (e: unknown) => e instanceof NotionReadUnconfirmed };
  const translateError = (error: unknown): never => {
    const mapped = classifyGardeningError(error, errChecks);
    if (mapped) throw new RequestError(mapped.status, mapped.message, mapped.code);
    throw error;
  };

  const verifierFor = (tx: ReadTransaction, check: CheckNotionRead): VerifyContentUse => {
    const reader = createNotionReader(tx, { purpose: 'storage', check, remoteOnly: true });
    return makeContentVerifier(tx, {
      captureSourceType, ...errChecks,
      reopenCapture: use => reader.reopen({
        id: factId(use.id), rev: use.rev as Revision, accessEpoch: String(use.accessEpoch) as Tick, mode: 'pinned', type: captureSourceType,
      }),
    });
  };

  const loadInboxResolved = async (tx: ReadTransaction, check: CheckNotionRead) => {
    const verify = verifierFor(tx, check);
    const pb = await loadPlaybookRetireContext(tx, verify, await deps.carePause.paused(tx));
    return loadGardeningInbox(tx, verify, pb.proposals, pb.stickyIds, buildKbGardeningPlan);
  };

  const executeCommands = (tx: ReadTransaction, requestKey: string, specs: readonly GardeningCommandSpec[]) =>
    executeGardeningCommands(host.boundHandler([deps.content, deps.learner], createStudioCommandHooks({}), tx as never,
      { bindCommandRead: (inner, _req, base) => bindEffectiveSlotRead(inner as never, base as never) as never }) as never,
      requestKey, specs, () => { throw new RequestError(409, '园艺命令未落定，已整体回滚。', 'command_not_done'); });

  const offlineWrite = <P, T>(
    parse: (raw: Record<string, unknown>, requestId: string) => P,
    probe: (tx: ReadTransaction, check: CheckNotionRead) => Promise<void>,
    run: (tx: DbTransaction, check: CheckNotionRead, parsed: P) => Promise<T>,
  ) => (raw: Record<string, unknown>, watermark: string) => Promise.resolve()
    .then(() => parse(raw, clientRequest(raw.requestId)))
    .then(parsed => notionReadScope(db, studioLearner).read(
      async (tx, check) => { await assertDeletionWatermark(tx, watermark); await probe(tx, check); },
      async (tx, check) => { await assertDeletionWatermark(tx, watermark); return run(tx, check, parsed); },
    ))
    .catch(translateError);

  return kit => {
    const readScope = <T>(run: (tx: ReadTransaction, check: CheckNotionRead) => Promise<T>) =>
      notionReadScope(db, studioLearner, { readOnly: true }).read(run).catch(translateError);

    kit.get('/api/kb/gardening', () => readScope(async (tx, check) => (await loadInboxResolved(tx, check)).plan));

    kit.offline('/api/kb/gardening/actions', offlineWrite(
      parseGardeningActionRequest,
      async (tx, check) => { await loadInboxResolved(tx, check); },
      (tx, check, parsed) => runGardeningActions(tx as never,
        { loadInbox: inner => loadInboxResolved(inner, check), executeCommands, questionStateRev: readQuestionStateRev },
        { ...parsed, effectDigest: digest(parsed.effectInput) }),
    ));

    kit.offline('/api/kb/gardening/undo', offlineWrite(
      parseGardeningUndoRequest,
      async (tx, check) => { await scanKbHostContent(tx, verifierFor(tx, check)); },
      (tx, check, parsed) => runGardeningUndo(tx as never,
        { executeCommands, questionStateRev: readQuestionStateRev, verifyContent: verifierFor(tx, check) },
        async inner => new Map((await scanKbHostContent(inner, verifierFor(inner, check))).entries) as never,
        { ...parsed, effectDigest: digest(parsed.effectInput) }),
    ));

    kit.get('/api/research/radar', () => readScope(async (tx, check) => {
      const verify = verifierFor(tx, check);
      const kbEntropyRadar = buildKbGardeningPlan((await scanKbHostContent(tx, verify)).snapshot).radar;
      const gate = createNotionFlowInclude<FactSnapshot>(fact => verifyNotionFact(tx, fact, 'storage', check, true), errChecks);
      const { snap } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose: 'storage', include: gate.include });
      gate.assertConfirmed();
      return readLivingMineRadarHost(tx, { snap, carePaused: await deps.carePause.paused(tx), kbEntropyRadar, verifyContent: verify });
    }));

    kit.get('/api/research/playbooks/effectiveness', () => readScope(async (tx, check) =>
      evaluatePlaybookHost(await scanPlaybookEntries(tx, verifierFor(tx, check)), await deps.carePause.paused(tx))));
  };
}
