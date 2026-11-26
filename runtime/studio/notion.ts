import { openNotionReadTransport } from '@mangekyo/executor-document-extraction/notion';
import type { NotionReadHostOutcome, NotionReadInput } from '../../executors/teaching/notion-read-tool.ts';
import type { WorkFailureCause } from '../../executors/temporal/src/work-failure.ts';
import { sealCandidate, submitCandidate } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { manifestFactInputs } from '../../kernel/src/derivations/revalidate.ts';
import {
  classifyKernelError, commandId, createAuthorizedFactReader, createCommandReadContext, factId, FactReadDeniedError,
  isFactUnavailable, LifecycleError, listFactsStatus, parseManifest, type CommandHooks, type Db, type DbTransaction,
  type FactId, type FactReadOptions, type FactSnapshot, type Json, type LearnerId, type Manifest, type ReadTransaction,
} from '../../kernel/src/index.ts';
import { assertDeletionWatermark, deletionWatermark } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { blockRoutedWork, cancelWork, readReadyWork, requestCatalogedWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { readRoutedWorkForRecovery, reconcileRoutedWork } from '../../kernel/src/work/route-recovery.ts';
import type { studyTurn } from '../../modules/activity/values.ts';
import { notionConfirmPageAccess, NotionSourceChanged, NotionSourceUnavailable, NotionTemporaryFailure, notionVersion } from '../../modules/capture/notion-api.ts';
import { changedNotionBlockWork, gatherNotionBlock, notionBlockDeriver, notionBlockRecoveryPages, NotionBlockResolverUnavailable, notionBlockSlot, notionBlockWorkKey, parseNotionBlockWorkKey, planNotionBlockRecovery } from '../../modules/capture/notion-block-work.ts';
import { NotionBlockUnavailable, openCurrentNotionBlock } from '../../modules/capture/notion-blocks.ts';
import { checkNotionDenial, notionReadTool, notionSources, openNotionRead, openNotionSettings, retireNotionChanges } from '../../modules/capture/notion-host-support.ts';
import { notionPageKey, notionPageReadFence, type CheckNotionRead } from '../../modules/capture/notion-read-plan.ts';
import { buildNotionPresets, checkNotionPresetGrant, grantNotionSelectionCommand, notionLearningReader as learningReader, readNotionSelection, revokeNotionSelectionCommand, selectionChange, selectionGrant, type NotionReadOptions, type NotionSelection } from '../../modules/capture/notion-selection.ts';
import { NotionSelectionUnavailable, notionSourceTarget, openSelectedNotionSource, prepareNotionRefreshInput, prepareSelectedNotionPages, refreshNotionSourceCommand, revokeNotionSourceCommand, setNotionPurposeCommand } from '../../modules/capture/notion-source.ts';
import { submittedWatermark } from '../../modules/capture/request.ts';
import { captureSourceCommand, captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import {
  modelRecipientId, notionModelRecipient, purpose as teaching, purposeReader,
  slotType as teachingSlotType, stableId, storageRead, studioHost, studioLearner,
} from './identity.ts';
import { teachingMemoryBasis } from './memory-claims.ts';
import { questionReceiptsCurrent } from './question-exposure.ts';
import { teachingTurnAllowed } from './reading.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { notionTeachingRecipients } from './workspace-access.ts';
function notionConnection() {
  const local = process.env.MANGEKYO_NOTION_TEST_ORIGIN;
  if (local && !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(local)) throw new Error('Invalid local Notion test origin');
  return openNotionReadTransport(local || 'https://api.notion.com', local ? 'isolated-notion-fixture' : process.env.MANGEKYO_NOTION_TOKEN,
    notionVersion, (status, message) => status === 502 ? new NotionTemporaryFailure(status) : new RequestError(status, message));
}
type Access = { purpose: string; recipientId: string; maySend: (fact: FactSnapshot) => boolean };
type Basis = { id: string; rev: number; epoch: string; type: string };
type Projection<T, Tx = ReadTransaction> = (tx: Tx, check: CheckNotionRead) => Promise<T>;
const availablePresets = async () => buildNotionPresets(await notionTeachingRecipients());
const selectionAt = (tx: ReadTransaction, id: string) => readNotionSelection(storageRead(tx), tx.learner, id);
const denialOwner = (id: string, epoch: string) => stableId('notion-access-denial', id, epoch);
const checkDenial = (tx: ReadTransaction, id: string, epoch: string, page?: string, since = epoch) =>
  checkNotionDenial(RequestError, tx, id, epoch, page, since);
const selectedAccess = (tx: ReadTransaction, access: Access, requireCurrentSelection = false) => ({
  learner: tx.learner, purpose: access.purpose, recipientId: access.recipientId, selectionRead: storageRead(tx),
  sourceRead: createAuthorizedFactReader(tx, access.purpose, access.maySend),
  async checkSelection(selection: NotionSelection, source: ReturnType<typeof sourceEnvelope>) {
    if (requireCurrentSelection && selection.selectionEpoch !== source.sourceSelectionEpoch) throw new NotionSelectionUnavailable();
    await checkDenial(tx, selection.id, selection.selectionEpoch, source.externalId, source.sourceSelectionEpoch);
  },
});
export const readStudioNotionSource = (tx: ReadTransaction, sourceId: FactId, options: NotionReadOptions, access: Access) =>
  openSelectedNotionSource(selectedAccess(tx, access), sourceId, options);
export type NotionRecipient = ((fact: FactSnapshot) => boolean) & { notionRecipientId?: string };
export const hasRemoteNotion = () => Boolean(process.env.MANGEKYO_NOTION_TEST_ORIGIN || process.env.MANGEKYO_NOTION_TOKEN);
export const notionRecipient = (
  recipientId?: string, maySend: (fact: FactSnapshot) => boolean = () => true,
): NotionRecipient => recipientId ? Object.assign(maySend, { notionRecipientId: recipientId }) : maySend;
export async function checkStudioNotionFact(tx: ReadTransaction, fact: FactSnapshot, purpose: string, recipient: NotionRecipient | 'learner', reopen?: (fact: FactSnapshot) => Promise<FactSnapshot>) {
  if (fact.type !== captureSourceType || sourceEnvelope(fact.value).kind !== 'notion') return;
  if (reopen) return reopen(fact);
  try {
    return await readStudioNotionSource(tx, fact.ref.id, { mode: 'pinned', rev: fact.ref.rev },
      recipient === 'learner' ? { purpose, recipientId: tx.learner, maySend: () => true } : { purpose, recipientId: recipient.notionRecipientId ?? '', maySend: recipient });
  } catch { throw new FactReadDeniedError('recipient', 'Notion 来源或选源对当前接收人已不可用。'); }
}
export async function verifyNotionFact(
  tx: ReadTransaction, fact: FactSnapshot, use: string,
  check?: CheckNotionRead, remoteOnly = false, recipient: NotionRecipient | 'learner' = 'learner',
) {
  if (fact.type !== captureSourceType || sourceEnvelope(fact.value).kind !== 'notion') return fact;
  const authorized = await checkStudioNotionFact(tx, fact, use, recipient);
  if (authorized && check && (!remoteOnly || hasRemoteNotion())) await check(authorized);
  return authorized ?? fact;
}
export function createNotionReader<
  Base extends ReturnType<typeof createAuthorizedFactReader> = ReturnType<typeof createAuthorizedFactReader>,
>(tx: ReadTransaction, options: {
  purpose: string;
  recipient?: NotionRecipient | 'learner';
  check?: CheckNotionRead;
  remoteOnly?: boolean;
  base?: Base;
  track?: (fact: FactSnapshot, mode?: 'pinned' | 'following') => void;
}) {
  const { purpose: use, recipient = 'learner', check, remoteOnly = false, track } = options;
  const reader = options.base ?? createAuthorizedFactReader(tx, use, recipient === 'learner' ? () => true : recipient);
  const gate = async (fact: FactSnapshot, mode?: 'pinned' | 'following') => {
    await verifyNotionFact(tx, fact, use, check, remoteOnly, recipient);
    track?.(fact, mode);
    return fact;
  };
  return {
    ...createCommandReadContext(tx, use),
    ...(reader as Base),
    fact: async <Value = Json>(id: FactId, opts: FactReadOptions) =>
      gate(await reader.fact(id, opts), opts.mode) as Promise<FactSnapshot<Value>>,
    reopen: async (witness: Parameters<typeof reader.reopen>[0]) =>
      gate(await reader.reopen(witness), witness.mode),
  };
}
class FetchRequired extends Error {}
const stale = () => new RequestError(409, '选源或原件版本已变更，请刷新后重试。');
const parseSettings = <T>(read: () => T) => { try { return read(); } catch { throw new RequestError(400, 'Notion 选源格式无效。'); } };
const notionPageAuthority = async (tx: ReadTransaction, source: ReturnType<typeof sourceEnvelope>) =>
  ({ selection: (await selectionAt(tx, source.sourceSelectionId!))!, pageId: source.externalId!, watermark: await deletionWatermark(tx) });
function notionHost(db: Db, learner: LearnerId = studioLearner) {
  const connection = notionConnection(), host = studioHost(db, { learner });
  async function live(tx: ReadTransaction, id: string, epoch: string, watermark: string, page?: string) {
    await assertDeletionWatermark(tx, watermark);
    const selection = await selectionAt(tx, id);
    if (!selection?.active || selection.selectionEpoch !== epoch) throw stale();
    await checkDenial(tx, id, epoch, page);
    return selection;
  }
  async function provider<T>(selection: NotionSelection, watermark: string, stream: Parameters<typeof connection.read<T>>[0],
    page?: string, signal?: AbortSignal, rememberDenial = true, preserveTemporary = false) {
    const { id, selectionEpoch: epoch } = selection;
    try { return await connection.read(stream, () => host.snapshot(tx => live(tx, id, epoch, watermark, page)), signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (error instanceof NotionSourceUnavailable && error.invalidated) {
        if (!rememberDenial) throw error;
        const stepKey = error.invalidated.kind === 'selection' ? 'root' : error.invalidated.pageId;
        await host.lockedTx(async tx => {
          await live(tx, id, epoch, watermark);
          await recordLocalRead(host.boundDb(tx), { learner: tx.learner, ownerKind: 'session', ownerId: denialOwner(id, epoch),
            stepKey, label: 'notion-access-denial', input: {} }, async () => 'denied', async () => {});
        });
        throw new RequestError(403, 'Notion 已撤回该来源的访问。');
      }
      if ((preserveTemporary && error instanceof NotionTemporaryFailure) || error instanceof RequestError ||
          error instanceof LifecycleError || error instanceof NotionSourceChanged) throw error;
      throw new RequestError(502, '未能完整核实 Notion 来源，请重试。');
    }
  }
  return { connection, host, live, provider };
}
export async function savedNotionWitnesses(tx: ReadTransaction, inputs: Manifest['inputs']) {
  const facts = await manifestFactInputs(tx, inputs);
  if (!facts.length) return [];
  const { rows } = await tx.query<{ id: string; rev: number }>(
    `SELECT f.id,r.rev FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id)=(f.learner_id,f.id)
     WHERE f.learner_id=$1 AND f.type=$2 AND f.id=ANY($3) AND r.data->>'kind'='notion'`, [tx.learner, captureSourceType, facts.map(i => i.id)]);
  const ids = new Set(rows.map(r => `${r.id}:${r.rev}`));
  return facts.filter(f => ids.has(`${f.id}:${f.rev}`)).map(f => ({ id: f.id, rev: f.rev, epoch: f.accessEpoch, type: captureSourceType }));
}
export async function notionSendBasis(tx: ReadTransaction, witnesses: Iterable<Basis>, recipient: NotionRecipient, check?: CheckNotionRead) {
  const pages = [];
  let unconfirmed: NotionReadUnconfirmed | undefined;
  for (const w of witnesses) {
    if (w.type !== captureSourceType) continue;
    const fact = await purposeReader(tx, recipient)
      .reopen({ ...w, id: factId(w.id), accessEpoch: w.epoch as FactSnapshot['accessEpoch'], mode: 'pinned' });
    if (!await checkStudioNotionFact(tx, fact, 'teaching', recipient)) continue;
    if (!check) pages.push(await notionPageAuthority(tx, sourceEnvelope(fact.value)));
    else try { await check(fact); } catch (error) { if (error instanceof NotionReadUnconfirmed) unconfirmed = error; else throw error; }
  }
  if (unconfirmed) throw unconfirmed;
  return pages;
}
export async function teachingResultAuthority(tx: ReadTransaction, turnId: string, turn: ReturnType<typeof studyTurn>,
  rawManifest: unknown, grantCurrent: (turn: ReturnType<typeof studyTurn>) => Promise<boolean>, check: CheckNotionRead,
  origin?: ReturnType<typeof studyTurn>, use: 'publish' | 'history' = 'publish') {
  try {
    const manifest = parseManifest(rawManifest);
    if (manifest.purpose !== teaching || !await teachingTurnAllowed(tx, turn, grantCurrent, origin)) return { state: 'withdrawn' } as const;
    const recipient = notionRecipient(
      turn.providerId && turn.protocol && turn.workspaceRevision ? modelRecipientId(turn, turn.workspaceRevision) : undefined);
    const memoryBasis = await teachingMemoryBasis(tx, manifest, turnId, recipient);
    if (!memoryBasis || (turn.learningToolsVersion === 1 && !await questionReceiptsCurrent(tx, turnId, use))) return { state: 'withdrawn' } as const;
    await notionSendBasis(tx, [...await savedNotionWitnesses(tx, manifest.inputs), ...memoryBasis.objects], recipient, check);
    return { state: 'authorized', memoryBasis } as const;
  } catch (error) { return error instanceof NotionReadUnconfirmed ? { state: 'unconfirmed' } as const : { state: 'withdrawn' } as const; }
}
const notionUnconfirmedReason = '暂时无法确认 Notion 来源。';
export class NotionReadUnconfirmed extends FactReadDeniedError { constructor() { super('recipient', notionUnconfirmedReason); } }
export class NotionReadUnchecked extends NotionReadUnconfirmed {}
export class NotionReadTemporaryFailure extends NotionReadUnconfirmed {}
export type { CheckNotionRead } from '../../modules/capture/notion-read-plan.ts';
export function notionReadScope(db: Db, learner: LearnerId, { readOnly = false, signal }: { readOnly?: boolean; signal?: AbortSignal } = {}) {
  const { host, provider } = notionHost(db, learner);
  const lockedReadOnly = readOnly ? <T>(project: (tx: ReadTransaction) => Promise<T>) => host.snapshot(project, { lockLearner: true })
    .catch(error => Promise.reject(error instanceof Error && 'code' in error && error.code === '40001' ? new RequestError(503, '课堂依据正在更新，请重试。') : error)) : undefined;
  return notionPageReadFence<ReadTransaction, DbTransaction>(notionPageAuthority,
    ({ selection, pageId, watermark }, stream, abort) => provider(selection, watermark, stream, pageId, abort, !readOnly, true),
    error => error instanceof RequestError ? (error.status === 403 ? 'withdrawn' : 'unconfirmed') : error instanceof LifecycleError ? 'unconfirmed' : undefined,
    status => status === undefined ? new NotionReadUnchecked() : status === 'withdrawn'
      ? new FactReadDeniedError('recipient', '未能确认 Notion 来源。')
      : status === 'temporary-failure' ? new NotionReadTemporaryFailure() : new NotionReadUnconfirmed(),
    { snapshot: host.snapshot, locked: host.lockedTx, lockedReadOnly, signal });
}
export type NotionReadScope = ReturnType<typeof notionReadScope>;
export const confirmNotionRead = <T>(db: Db, learner: LearnerId, read: Projection<T>, publish?: Projection<T, DbTransaction>) => {
  const scope = notionReadScope(db, learner);
  return publish ? scope.read(read, publish) : scope.read(read);
};
export async function confirmNotionDispatch(db: Db, pages: Awaited<ReturnType<typeof notionSendBasis>>) {
  const { provider } = notionHost(db);
  for (const { selection, pageId, watermark } of new Map(pages.map(p => [notionPageKey(p), p])).values())
    await provider(selection, watermark, notionConfirmPageAccess(selection.root, pageId), pageId);
}
const blockPolicy = { slot: { type: notionBlockSlot }, deriver: notionBlockDeriver, purpose: learningReader.purpose };
export const notionBlockRoute = { deriver: notionBlockDeriver };
const blockRecovery = { slotType: notionBlockSlot, deriver: notionBlockDeriver, code: 'notion-remote-unconfirmed', migrateDefaultLane: true };
const blockAccess = (tx: ReadTransaction) => selectedAccess(tx, { purpose: learningReader.purpose, recipientId: learningReader.id, maySend: () => true }, true);
const exhaustBlock = (db: Db, ref: WorkRef, remote: boolean) =>
  blockRoutedWork(db, ref, remote ? blockRecovery.code : 'notion-execution-exhausted', remote ? notionUnconfirmedReason : 'Notion 块处理重试已耗尽。');
const blockWithdrawn = (error: unknown) => !(error instanceof NotionReadUnconfirmed) &&
  (error instanceof NotionBlockUnavailable || error instanceof NotionSelectionUnavailable || isFactUnavailable(error) || (error instanceof RequestError && error.status === 403));
const blockScopeKeys = JSON.stringify({ purpose: blockPolicy.purpose, recipientId: learningReader.id });
const createNotionHooks = (afterFactsChanged?: CommandHooks['onFactsChanged']) => createStudioCommandHooks({
  async afterFactsChanged(tx, tick, changes) {
    await retireNotionChanges({ teachingSlotType, notionModelRecipient }, tx, tick, changes);
    for await (const basis of changedNotionBlockWork(storageRead(tx), blockPolicy.purpose, changes))
      await requestCatalogedWork(tx, tick, { slotType: notionBlockSlot, slotKey: notionBlockWorkKey(basis), deriver: notionBlockDeriver }, blockScopeKeys, { pendingState: 'routed_pending' });
    await afterFactsChanged?.(tx, tick, changes);
  },
});
const notionHooks = createNotionHooks();
export async function executeNotionBlockWork(db: Db, ref: WorkRef, terminal: boolean, cause?: WorkFailureCause) {
  const host = studioHost(db);
  await notionReadScope(db, studioLearner).publishAfterChecks(async (tx, check) => {
    const work = await readReadyWork(tx, ref);
    if (!work || work.slotType !== notionBlockSlot || work.deriver !== notionBlockDeriver) return;
    try { await openCurrentNotionBlock(blockAccess(tx), parseNotionBlockWorkKey(work.slotKey), check); return work; }
    catch (error) {
      const bound = host.boundDb(tx);
      if (blockWithdrawn(error)) await cancelWork(bound, ref);
      else if (terminal && error instanceof NotionReadUnconfirmed)
        await exhaustBlock(bound, ref, cause === 'remote-unavailable' && error instanceof NotionReadTemporaryFailure);
      else throw error;
      return;
    }
  }, async (tx, work) => {
    if (!work) return;
    const bound = host.boundDb(tx);
    if (terminal) return void await exhaustBlock(bound, ref, cause === 'remote-unavailable');
    const input = await gatherSnapshot(bound, { learner: tx.learner, purpose: blockPolicy.purpose }, ctx => gatherNotionBlock(ctx, work.slotKey));
    const sealed = await sealCandidate(bound, ref, blockPolicy, input);
    if (sealed.kind === 'sealed') await submitCandidate(
      bound, ref, blockPolicy, sealed.id, { kind: 'failed', reason: new NotionBlockResolverUnavailable().message }, notionHooks);
  });
}
export function openStudioNotion(db: Db, capture: LoadedModule, afterFactsChanged?: CommandHooks['onFactsChanged']) {
  const { connection, host, live, provider } = notionHost(db);
  const hooks = afterFactsChanged ? createNotionHooks(afterFactsChanged) : notionHooks;
  const runCmd = (tx: DbTransaction, input: { type: string; id: ReturnType<typeof commandId>; input: Json; actor?: 'companion' },
    deletionWatermark: string) => host.boundHandler([capture], hooks, tx)({ purpose: 'storage', deletionWatermark, ...input });
  const ownerAccess = { purpose: 'storage', recipientId: studioLearner, maySend: (s: FactSnapshot) => s.ref.learner === studioLearner };
  const readOwn = (tx: ReadTransaction, id: FactId) => readStudioNotionSource(tx, id, { mode: 'following' }, ownerAccess);
  const openFollowing = (tx: ReadTransaction, id: FactId, access: Access) =>
    readStudioNotionSource(tx, id, { mode: 'following' }, access)
      .catch(() => { throw new RequestError(403, '这份 Notion 来源未获当前接收人授权。'); });
  const record = (tx: DbTransaction, reqId: string, input: Json, save: () => Promise<string>, authorize: () => Promise<void>) =>
    recordLocalRead(host.boundDb(tx), { learner: tx.learner, ownerKind: 'session',
      ownerId: stableId('notion-request', reqId), stepKey: 'result', label: 'notion-request', input }, save, authorize)
      .catch(e => Promise.reject(e instanceof Error && e.message === 'Workspace read receipt does not match the request' ? stale() : e));
  async function mutate(action: string, raw: Record<string, unknown>, sourceId?: string) {
    const requestId = clientRequest(raw.requestId);
    if (raw.deletionWatermark === undefined) throw new RequestError(400, '需要设备原始删除水位。');
    const watermark = submittedWatermark(raw), { requestId: _r, deletionWatermark: _w, ...fields } = raw;
    if ((action === 'purpose' || action === 'retract') && sourceId) {
      const { expectedRev, accessEpoch, preset, ...selectionFields } = fields, isPurpose = action === 'purpose';
      const { selectionId, expectedEpoch, recipient } = parseSettings(() => selectionChange(selectionFields));
      if (recipient || (isPurpose ? preset !== 'storage' : preset !== undefined))
        throw new RequestError(400, isPurpose ? '此操作只将该原件收窄为本人存储。' : '此操作仅撤回单个原件。');
      const target = parseSettings(() => notionSourceTarget({ id: sourceId, selectionId, expectedRev, accessEpoch }));
      return host.lockedTx(async tx => {
        const read = () => openFollowing(tx, target.id, ownerAccess);
        const saved = await record(tx, requestId, { action, target, ...(isPurpose && { preset: 'storage' }), expectedEpoch, watermark },
          async () => {
            const fact = await read();
            if (sourceEnvelope(fact.value).sourceSelectionId !== selectionId || fact.ref.rev !== expectedRev || fact.accessEpoch !== accessEpoch)
              throw stale();
            const receipt = await runCmd(tx, { type: isPurpose ? setNotionPurposeCommand : revokeNotionSourceCommand,
              id: commandId(stableId(isPurpose ? 'notion-purpose' : 'notion-retract', requestId)),
              input: (isPurpose ? { ...target, preset: 'storage' } : target) as Json }, watermark);
            return String(receipt.wrote[0]?.rev ?? expectedRev);
          }, async () => { await live(tx, selectionId, expectedEpoch, watermark); });
        if (!isPurpose) {
          const [row] = await listFactsStatus(tx, [target.id]);
          if (!row || String(row.retractedRev) !== saved) throw stale();
          return { id: sourceId, rev: row.retractedRev, accessEpoch: row.accessEpoch, retracted: true };
        }
        const fact = await read();
        if (String(fact.ref.rev) !== saved || fact.purpose.length !== 1 || fact.purpose[0] !== 'storage') throw stale();
        return { id: sourceId, rev: fact.ref.rev, accessEpoch: fact.accessEpoch, purpose: fact.purpose };
      });
    }
    const change = parseSettings(() => action === 'grant' ? selectionGrant(fields) : selectionChange(fields));
    const { selectionId, expectedEpoch } = change;
    if (action === 'sync') {
      if ('recipient' in change) throw new RequestError(400, '同步仅接受选源标识与代次。');
      return sync(requestId, selectionId, expectedEpoch, watermark);
    }
    if (action !== 'revoke' && action !== 'grant') throw new RequestError(400, '无效的选源操作。');
    const type = action === 'grant' ? grantNotionSelectionCommand : revokeNotionSelectionCommand;
    return host.lockedTx(async tx => {
      const epoch = await record(tx, requestId, { action, fields: fields as Json, watermark }, async () => {
        if ('settings' in change) {
          const bad = checkNotionPresetGrant(await availablePresets(), change.settings);
          if (bad) throw new RequestError(bad.status, bad.message);
        }
        const current = await selectionAt(tx, selectionId);
        if ((current?.selectionEpoch ?? '0') !== expectedEpoch) throw stale();
        if (!current && action === 'revoke') throw new RequestError(404, '没有该选源。');
        const saved = await runCmd(tx, { type, id: commandId(stableId('notion-choice', requestId)), input: fields as Json }, watermark);
        return String(saved.wrote[0]?.rev ?? expectedEpoch);
      }, () => assertDeletionWatermark(tx, watermark));
      const next = await selectionAt(tx, selectionId);
      if (next?.selectionEpoch !== epoch) throw stale();
      return { selectionId, epoch, active: next.active };
    });
  }
  async function sync(requestId: string, selectionId: string, epoch: string, watermark: string) {
    type Receipt = { selectionId: string; epoch: string; sources: { id: FactId; rev: number }[] };
    async function receipt(tx: DbTransaction, save: () => Promise<Receipt>) {
      const encoded = await record(tx, requestId, { action: 'sync', selectionId, epoch, watermark }, async () => JSON.stringify(await save()),
        async () => { await live(tx, selectionId, epoch, watermark); });
      const result = JSON.parse(encoded) as Receipt;
      for (const ref of result.sources) await readOwn(tx, ref.id);
      return result;
    }
    try { return await host.lockedTx(tx => receipt(tx, async () => { throw new FetchRequired(); })); }
    catch (error) { if (!(error instanceof FetchRequired)) throw error; }
    const { selection, before, deniedPages, recoveryPages } = await host.snapshot(async tx => {
      const selection = await live(tx, selectionId, epoch, watermark);
      if (selection.preset !== 'storage' && selection.preset !== 'learning') throw new RequestError(422, '短期材料不能同步为长期原件。');
      const denied = await tx.query<{ step_key: string }>(
        `SELECT step_key FROM effects WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2 AND label='notion-access-denial'`,
        [tx.learner, denialOwner(selectionId, epoch)]);
      const before = await notionSources(tx, selection);
      return {
        selection, before, deniedPages: new Set(denied.rows.map(r => r.step_key)),
        recoveryPages: selection.root.kind === 'data-source'
          ? notionBlockRecoveryPages(before, await readRoutedWorkForRecovery(tx, blockRecovery)) : [],
      };
    });
    const prepared = await prepareSelectedNotionPages(selection, before[0], deniedPages, () => new Date().toISOString(),
      (stream, pageId, supplemental) => provider(selection, watermark, stream, pageId, undefined, true, supplemental),
      { pages: recoveryPages, defer: reason => console.warn('Notion 补查延后', reason) })
      .catch(error => Promise.reject(error instanceof NotionSourceChanged ? stale() : error));
    return host.lockedTx(tx => receipt(tx, async () => {
      const refs = [], current = await notionSources(tx, selection);
      for (const item of prepared) {
        const prior = current.find((s: { id: FactId; rev: number }) => s.id === item.id);
        if (prior?.rev !== before.find((s: { id: FactId; rev: number }) => s.id === item.id)?.rev) throw stale();
        await checkDenial(tx, selectionId, epoch, item.envelope.externalId);
        const fact = prior && await readOwn(tx, item.id);
        const input = fact
          ? await prepareNotionRefreshInput({ id: item.id, expectedRev: fact.ref.rev, accessEpoch: fact.accessEpoch, selectionId },
              sourceEnvelope(fact.value), item.envelope)
          : { ...item, purpose: [...new Set(['storage', ...selection.recipients.map(r => r.purpose)])] };
        const saved = await runCmd(tx, { actor: 'companion', type: fact ? refreshNotionSourceCommand : captureSourceCommand,
          id: commandId(stableId('notion-sync-row', requestId, item.id)), input: input as Json }, watermark)
          .catch(error => Promise.reject(error instanceof Error && error.message === 'Notion 页面观测已过时或同一版本不一致。' ? stale() : error));
        refs.push({ id: item.id, rev: saved.wrote.find(row => row.id === item.id)?.rev ?? fact!.ref.rev });
      }
      await reconcileRoutedWork(tx, blockRecovery, planNotionBlockRecovery(blockAccess(tx), new Set(refs.map(r => r.id)), blockWithdrawn));
      return { selectionId, epoch, sources: refs };
    }));
  }
  return {
    mutate,
    settings: () => openNotionSettings({ snapshot: host.snapshot, connection, availablePresets, selectionAt, sources: notionSources,
      deletionWatermark, readSource: readOwn }),
    read: (id: string, view: string | null, send: (data: unknown) => void) =>
      openNotionRead({ snapshot: host.snapshot, locked: host.lockedTx, live, provider, stale, selectionAt, deletionWatermark,
        ownerAccess, learningReader, openFollowing, RequestError }, id, view, send),
    readTool: (input: NotionReadInput, step: number, access: Access, authorize: (tx: ReadTransaction) => Promise<void>) =>
      notionReadTool({
        notionReadScope: () => notionReadScope(db, studioLearner), notionPageAuthority, provider, RequestError, stale,
        open: readStudioNotionSource, classifyKernelError, isLifecycleError: (e: unknown) => e instanceof LifecycleError,
        runRefresh: (tx: DbTransaction, watermark: string, id: ReturnType<typeof commandId>, refresh: Json) =>
          runCmd(tx, { actor: 'companion', type: refreshNotionSourceCommand, id, input: refresh }, watermark),
      }, input, step, access, authorize) as Promise<NotionReadHostOutcome>,
  };
}
