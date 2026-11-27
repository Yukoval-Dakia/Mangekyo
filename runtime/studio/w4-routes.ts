import { createHash } from 'node:crypto';
import {
  factId, readable, type Db, type DbTransaction, type Json, type ReadTransaction, type Revision, type Tick,
} from '../../kernel/src/index.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { assertDeletionWatermark } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { buildKbGardeningPlan } from '../../modules/content/kb-gardening.ts';
import {
  bindEffectiveSlotRead, executeGardeningCommands, GardeningRejection, loadGardeningInbox, makeContentVerifier,
  parseGardeningActionRequest, parseGardeningUndoRequest, readQuestionStateRev, runGardeningActions, runGardeningUndo,
  scanKbHostContent, type GardeningCommandSpec, type VerifyContentUse,
} from '../../modules/content/kb-gardening-host.ts';
import {
  evaluatePlaybookHost, playbookRetireProposals, readLivingMineRadarHost, scanPlaybookEntries,
} from '../../modules/companion/living-mine-host.ts';
import { captureSourceType } from '../../modules/capture/source.ts';
import type { RoutePack } from './endpoint-kit.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { studioHost, studioLearner } from './identity.ts';
import { createNotionReader, notionReadScope, verifyNotionFact, type CheckNotionRead } from './notion.ts';
import { loadAuthorizedRecordFlowSnapshot } from './record-flow.ts';
import { clientRequest, RequestError } from './sessions.ts';

type W4Deps = {
  readonly carePause: { paused: (tx: ReadTransaction, now?: number) => Promise<boolean> };
  readonly content: LoadedModule;
  readonly learner: LoadedModule;
};

/** W4 thin host routes: kb gardening inbox/actions/undo plus living-mine radar and playbook effectiveness reads. */
export function w4RoutePack(db: Db, deps: W4Deps): RoutePack {
  const host = studioHost(db);
  const digest = (input: unknown) => createHash('sha256').update(canonicalJsonString(input as Json)).digest('hex');

  const verifierFor = (tx: ReadTransaction, check: CheckNotionRead): VerifyContentUse => {
    const reader = createNotionReader(tx, { purpose: 'storage', check, remoteOnly: true });
    return makeContentVerifier({
      captureSourceType,
      factTypeOf: async id => (await tx.query<{ type: string }>('SELECT type FROM facts WHERE learner_id=$1 AND id=$2', [tx.learner, id])).rows[0]?.type ?? null,
      checkCapture: async use => Boolean(await readable(() =>
        reader.reopen({ id: factId(use.id), rev: use.rev as Revision, accessEpoch: String(use.accessEpoch) as Tick, mode: 'pinned', type: captureSourceType }))),
    });
  };

  const loadInboxResolved = async (tx: ReadTransaction, check: CheckNotionRead) => {
    const verify = verifierFor(tx, check);
    return loadGardeningInbox(tx, verify,
      playbookRetireProposals(evaluatePlaybookHost(await scanPlaybookEntries(tx, verify), false)), buildKbGardeningPlan);
  };

  const executeCommands = (tx: ReadTransaction, requestKey: string, specs: readonly GardeningCommandSpec[]) =>
    executeGardeningCommands(host.boundHandler([deps.content, deps.learner], createStudioCommandHooks({}), tx as never,
      { bindCommandRead: (inner, _req, base) => bindEffectiveSlotRead(inner as never, base as never) as never }) as never,
      requestKey, specs, () => { throw new RequestError(409, '园艺命令未落定，已整体回滚。', 'command_not_done'); });

  const translateReject = (error: unknown): never => {
    if (error instanceof GardeningRejection) throw new RequestError(error.status, error.message, error.code);
    throw error;
  };

  // Two-phase Notion read fence: probe remotely outside the learner lock, then commit inside one lockedTx.
  const lockedWrite = <T>(
    probe: (tx: ReadTransaction, check: CheckNotionRead) => Promise<void>,
    run: (tx: DbTransaction, check: CheckNotionRead) => Promise<T>,
  ) => (watermark: string) => notionReadScope(db, studioLearner).read(
    async (tx, check) => { await assertDeletionWatermark(tx, watermark); await probe(tx, check); },
    async (tx, check) => { await assertDeletionWatermark(tx, watermark); return run(tx, check).catch(translateReject); });

  return kit => {
    const readScope = () => notionReadScope(db, studioLearner, { readOnly: true });
    kit.get('/api/kb/gardening', () => readScope().read(async (tx, check) => (await loadInboxResolved(tx, check)).plan));

    kit.offline('/api/kb/gardening/actions', (raw, watermark) => {
      const parsed = (() => { try { return parseGardeningActionRequest(raw, clientRequest(raw.requestId)); } catch (e) { return translateReject(e); } })();
      return lockedWrite(
        async (tx, check) => { await loadInboxResolved(tx, check); },
        (tx, check) => runGardeningActions(tx as never,
          { loadInbox: inner => loadInboxResolved(inner, check), executeCommands, questionStateRev: readQuestionStateRev },
          { ...parsed, effectDigest: digest(parsed.effectInput) }),
      )(watermark);
    });

    kit.offline('/api/kb/gardening/undo', (raw, watermark) => {
      const parsed = (() => { try { return parseGardeningUndoRequest(raw, clientRequest(raw.requestId)); } catch (e) { return translateReject(e); } })();
      return lockedWrite(
        async (tx, check) => { await scanKbHostContent(tx, verifierFor(tx, check)); },
        (tx, check) => runGardeningUndo(tx as never, { executeCommands, questionStateRev: readQuestionStateRev },
          async inner => new Map((await scanKbHostContent(inner, verifierFor(inner, check))).entries) as never,
          { ...parsed, effectDigest: digest(parsed.effectInput) }),
      )(watermark);
    });

    kit.get('/api/research/radar', () => readScope().read(async (tx, check) => {
      const verify = verifierFor(tx, check);
      const kbEntropyRadar = buildKbGardeningPlan((await scanKbHostContent(tx, verify)).snapshot).radar;
      const { snap } = await loadAuthorizedRecordFlowSnapshot(tx, {
        purpose: 'storage',
        include: async (_, fact) => Boolean(await readable(() => verifyNotionFact(tx, fact, 'storage', check, true))),
      });
      return readLivingMineRadarHost(tx, { snap, carePaused: await deps.carePause.paused(tx), kbEntropyRadar, verifyContent: verify });
    }));

    kit.get('/api/research/playbooks/effectiveness', () => readScope().read(async (tx, check) =>
      evaluatePlaybookHost(await scanPlaybookEntries(tx, verifierFor(tx, check)), await deps.carePause.paused(tx))));
  };
}
