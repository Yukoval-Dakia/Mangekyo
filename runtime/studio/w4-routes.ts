import { createHash } from 'node:crypto';
import { readable, type Db, type FactSnapshot, type Json, type ReadTransaction } from '../../kernel/src/index.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { assertDeletionWatermark } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { buildKbGardeningPlan } from '../../modules/content/kb-gardening.ts';
import {
  bindEffectiveSlotRead, executeGardeningCommands, GardeningRejection, loadGardeningInbox, makeContentVerifier, readQuestionStateRev,
  runGardeningActions, runGardeningUndo, scanKbHostContent, type GardeningCommandSpec,
  type VerifyContentUse } from '../../modules/content/kb-gardening-host.ts';
import {
  buildLivingMineRadarHost, evaluatePlaybookHost, playbookRetireProposals, scanForegroundActive, scanLivingMineInputs,
  scanPlaybookEntries } from '../../modules/companion/living-mine-host.ts';
import { captureSourceType } from '../../modules/capture/source.ts';
import type { RoutePack } from './endpoint-kit.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { studioHost, studioLearner } from './identity.ts';
import { notionReadScope, verifyNotionFact, type CheckNotionRead } from './notion.ts';
import { loadAuthorizedRecordFlowSnapshot } from './record-flow.ts';
import { clientRequest, RequestError } from './sessions.ts';

type W4Deps = {
  readonly carePause: { paused: (tx: ReadTransaction, now?: number) => Promise<boolean> };
  readonly content: LoadedModule; readonly learner: LoadedModule;
};

/** W4 thin host routes: kb gardening inbox/actions/undo plus living-mine radar and playbook effectiveness reads. */
export function w4RoutePack(db: Db, deps: W4Deps): RoutePack {
  const host = studioHost(db);
  const digest = (input: unknown) => createHash('sha256').update(canonicalJsonString(input as Json)).digest('hex');

  // Notion/purpose gating: the double-package instanceof checks live in this runtime layer.
  const verifierFor = (tx: ReadTransaction, check: CheckNotionRead | undefined): VerifyContentUse =>
    makeContentVerifier({
      captureSourceType,
      openFact: async (id, rev) => (await tx.query<{ type: string; accessEpoch: string; retracted: boolean }>(
        `SELECT f.type, f.access_epoch::text AS "accessEpoch", (f.retracted_rev IS NOT NULL) AS retracted
           FROM facts f WHERE f.learner_id=$1 AND f.id=$2
             AND EXISTS(SELECT 1 FROM fact_revs r WHERE (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,$3))`,
        [tx.learner, id, rev])).rows[0] ?? null,
      verifyRemote: snapshot =>
        readable(() => verifyNotionFact(tx, snapshot as FactSnapshot, 'storage', check, true)).then(Boolean) });

  const loadInboxResolved = async (tx: ReadTransaction, check: CheckNotionRead | undefined) =>
    loadGardeningInbox(tx, verifierFor(tx, check),
      playbookRetireProposals(evaluatePlaybookHost(await scanPlaybookEntries(tx), false)), buildKbGardeningPlan);

  const executeCommands = (tx: ReadTransaction, requestKey: string, specs: readonly GardeningCommandSpec[]) =>
    executeGardeningCommands(host.boundHandler([deps.content, deps.learner], createStudioCommandHooks({}), tx as never,
      { bindCommandRead: (inner, _req, base) => bindEffectiveSlotRead(inner as never, base as never) as never }) as never,
      requestKey, specs, () => { throw new RequestError(409, '园艺命令未落定，已整体回滚。', 'command_not_done'); });

  const lockedWrite = <T>(run: (tx: never, check: CheckNotionRead | undefined) => Promise<T>) =>
    (_raw: unknown, watermark: string) => notionReadScope(db, studioLearner).read((_readTx, check) => host.lockedTx(async tx => {
        await assertDeletionWatermark(tx, watermark);
        try {
          return await run(tx as never, check);
        } catch (error) {
          if (error instanceof GardeningRejection) throw new RequestError(error.status, error.message, error.code);
          throw error;
        }
      }));

  return kit => {
    const readScope = () => notionReadScope(db, studioLearner, { readOnly: true });
    kit.get('/api/kb/gardening', async () => readScope().read(async (tx, check) => (await loadInboxResolved(tx, check)).plan));
    kit.offline('/api/kb/gardening/actions', async (raw, watermark) => {
      const requestId = clientRequest(raw.requestId), batch = raw.batch === true;
      const items: Record<string, unknown>[] = batch
        ? (Array.isArray(raw.proposals) ? raw.proposals as Record<string, unknown>[] : []) : [raw];
      if (!items.length || items.length > 64) throw new RequestError(400, '批量园艺请求为空或超出上限 64。');
      const batchAction = typeof raw.action === 'string' ? raw.action : '';
      const effectInput = { batch,
        items: items.map(item => Object.fromEntries(Object.entries({
          action: batch ? batchAction : item.action, proposalId: item.proposalId, actionId: item.actionId,
          proposalKind: item.proposalKind, suggestedCommand: item.suggestedCommand, targetIds: item.targetIds,
          children: item.children }).filter(([, value]) => value !== undefined))) as unknown as Json,
      };
      return lockedWrite((tx, check) => runGardeningActions(tx, { loadInbox: inner => loadInboxResolved(inner, check), executeCommands },
        { requestId, effectDigest: digest(effectInput), effectInput, batch, batchAction, items }))(raw, watermark);
    });

    kit.offline('/api/kb/gardening/undo', async (raw, watermark) => {
      const requestId = clientRequest(raw.requestId),
        actionId = typeof raw.actionId === 'string' ? raw.actionId : '',
        undoToken = typeof raw.undo_token === 'string' ? raw.undo_token : '';
      if (!actionId || !undoToken) throw new RequestError(400, '缺少撤回动作标识或凭据。');
      const effectInput = { actionId, undoToken };
      return lockedWrite((tx, check) => runGardeningUndo(tx, { executeCommands, questionStateRev: readQuestionStateRev },
        async inner => new Map((await scanKbHostContent(inner, verifierFor(inner, check))).entries) as never,
        { requestId, effectDigest: digest(effectInput), effectInput, actionId, undoToken }))(raw, watermark);
    });

    kit.get('/api/research/radar', async () =>
      readScope().read(async (tx, check) => {
        const kbRadar = buildKbGardeningPlan((await scanKbHostContent(tx, verifierFor(tx, check))).snapshot).radar;
        const { snap } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose: 'storage' });
        return buildLivingMineRadarHost({
          snap, generatedAt: new Date().toISOString(), carePaused: await deps.carePause.paused(tx),
          ...(await scanLivingMineInputs(tx, kbRadar)), kbEntropyRadar: kbRadar }, await scanForegroundActive(tx));
      }));

    kit.get('/api/research/playbooks/effectiveness', async () => readScope().read(async tx =>
      evaluatePlaybookHost(await scanPlaybookEntries(tx), await deps.carePause.paused(tx))));
  };
}
