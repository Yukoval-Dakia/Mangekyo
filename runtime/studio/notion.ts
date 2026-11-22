import { manifestFactInputs } from '../../kernel/src/derivations/revalidate.ts';
import { findManifestDependents } from '../../kernel/src/derivations/manifest-dependents.ts';
import { teachingMemoryBasis } from './memory-claims.ts';
import type { studyTurn } from '../../modules/activity/values.ts';
import { parseManifest, type Manifest } from '../../kernel/src/derivations/manifest.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { withLearnerLock, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import type { CommandHooks, FactChange } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createAuthorizedFactReader, createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { commandId, factId, type DerivationId, type FactId, type LearnerId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Json } from '../../kernel/src/declarations/types.ts';
import { assertDeletionWatermark, deletionWatermark, LifecycleError } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import type { WorkFailureCause } from '../../executors/temporal/src/work-failure.ts';
import { blockRoutedWork, cancelWork, readReadyWork, requestCatalogedWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { readRoutedWorkForRecovery, reconcileRoutedWork } from '../../kernel/src/work/route-recovery.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { sealCandidate, submitCandidate } from '../../kernel/src/derivations/candidate.ts';
import { notionPageKey, notionPageReadFence, type CheckNotionRead } from '../../modules/capture/notion-read-plan.ts';
import { notionConfirmPageAccess, notionReadPage, NotionSourceChanged, NotionSourceUnavailable, NotionTemporaryFailure } from '../../modules/capture/notion-api.ts';
import { checkNotionDenial, notionReadTool, notionSources, openNotionRead, openNotionSettings, retireNotionChanges } from '../../modules/capture/notion-host-support.ts';
import { grantNotionSelectionCommand, revokeNotionSelectionCommand, notionSelectionType, selectionChange, selectionGrant,
  notionSelectionWitness, readNotionSelection, type NotionSelection, type NotionReadOptions } from '../../modules/capture/notion-selection.ts';
import { buildNotionInvalidationTarget, filterInvalidatedNotionTargets, notionBlockRetirementMatchesSlot,
  notionPageObservationType, notionRecordPurpose, notionSelectionFromSnapshot, NotionSelectionUnavailable,
  notionSourceTarget, openSelectedNotionSource, parseNotionBlockSlotKey, planNotionBlockRetirements,
  planNotionSelectionInvalidation, prepareNotionRefreshInput, prepareNotionRevision, prepareSelectedNotionPages,
  reconstructNotionFactPair, refreshNotionSourceCommand, revokeNotionSourceCommand, setNotionPurposeCommand,
  notionRefreshHasChanges, notionRevisionDiff, UnchangedNotionSourceError,
  type NotionFactTransitionRow, type NotionInvalidationSourceRow } from '../../modules/capture/notion-source.ts';
import { NotionBlockUnavailable, openCurrentNotionBlock } from '../../modules/capture/notion-blocks.ts';
import { changedNotionBlockWork, gatherNotionBlock, notionBlockDeriver, notionBlockRecoveryPages, NotionBlockResolverUnavailable,
  notionBlockSlot, notionBlockWorkKey, parseNotionBlockWorkKey, planNotionBlockRecovery } from '../../modules/capture/notion-block-work.ts';
import { captureSourceCommand, captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { notionModelRecipient, purpose as teaching, slotType as teachingSlotType, stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { teachingTurnAllowed } from './reading.ts';
import { submittedWatermark } from '../../modules/capture/request.ts';
import { notionTeachingRecipients } from './workspace-access.ts';
import { notionConnection } from './notion-transport.ts';
import { questionReceiptsCurrent } from './question-exposure.ts';
import type { NotionReadDiff, NotionReadHostOutcome, NotionReadInput } from '../../executors/teaching/notion-read-tool.ts';

const learnerScope = {learner: studioLearner};
const learningReader = {id: 'studio:learning-reader', purpose: 'learning', label: '本机学习阅读器'} as const;
const availablePresets = async () => [
  {id: 'storage', available: true, allowedRecipients: []},
  {id: 'learning', available: true, allowedRecipients: [learningReader, ...await notionTeachingRecipients()]},
  {id: 'turn-only', available: false, allowedRecipients: [], reason: '当前会话尚无能复验本轮接收人和留存策略的出口。'},
  {id: 'temporary', available: false, allowedRecipients: [], reason: '临时材料尚无独立密钥、到期销毁和接收人复核出口。'},
];

const selectionAt = (tx: ReadTransaction, id: string) => readNotionSelection(createCommandReadContext(tx, 'storage'), tx.learner, id);
type Access = {purpose: string; recipientId: string; maySend: (fact: FactSnapshot) => boolean};
const denialOwner = (id: string, epoch: string) => stableId('notion-access-denial', id, epoch);

async function checkDenial(tx: ReadTransaction, id: string, epoch: string, page?: string, since = epoch) {
  return checkNotionDenial({RequestError, stableId, denialOwner}, tx, id, epoch, page, since);
}
function selectedAccess(tx: ReadTransaction, access: Access, requireCurrentSelection = false) {
  return {
    learner: tx.learner, purpose: access.purpose, recipientId: access.recipientId,
    selectionRead: createCommandReadContext(tx, 'storage'),
    sourceRead: createAuthorizedFactReader(tx, access.purpose, access.maySend),
    async checkSelection(selection: NotionSelection, source: ReturnType<typeof sourceEnvelope>) {
      if (requireCurrentSelection && selection.selectionEpoch !== source.sourceSelectionEpoch) throw new NotionSelectionUnavailable();
      await checkDenial(tx, selection.id, selection.selectionEpoch, source.externalId, source.sourceSelectionEpoch);
    },
  };
}

export function readStudioNotionSource(tx: ReadTransaction, sourceId: FactId, options: NotionReadOptions, access: Access) {
  return openSelectedNotionSource(selectedAccess(tx, access), sourceId, options);
}

export type NotionRecipient = ((fact: FactSnapshot) => boolean) & {notionRecipientId?: string};

export async function checkStudioNotionFact(tx: ReadTransaction, fact: FactSnapshot, purpose: string, recipient: NotionRecipient | 'learner', reopen?: (fact: FactSnapshot) => Promise<FactSnapshot>) {
  if (fact.type !== captureSourceType || sourceEnvelope(fact.value).kind !== 'notion') return;
  if (reopen) return reopen(fact);
  try {
    return await readStudioNotionSource(tx, fact.ref.id, {mode:'pinned', rev:fact.ref.rev},
      recipient === 'learner' ? {purpose,recipientId:tx.learner,maySend:() => true} : {purpose,recipientId:recipient.notionRecipientId ?? '',maySend:recipient});
  } catch {
    throw new FactReadDeniedError('recipient','Notion 来源或选源对当前接收人已不可用。');
  }
}

function sources(tx: ReadTransaction, selection: NotionSelection, allGenerations = false) {
  return notionSources({captureSourceType, notionPageObservationType}, tx, selection, allGenerations);
}
class FetchRequired extends Error {}
const stale = () => new RequestError(409, '选源或原件版本已变更，请刷新后重试。');
function parseSettings<T>(read: () => T) {
  try { return read(); } catch { throw new RequestError(400, 'Notion 选源格式无效。'); }
}

function notionHost(db: Db, scope = learnerScope) {
  const connection = notionConnection();
  const snapshot = <T>(read: (tx: ReadTransaction) => Promise<T>) => db.snapshot(scope, read);
  const locked = <T>(action: (tx: DbTransaction) => Promise<T>) => withLearnerLock(db, scope, action);

  async function live(tx: ReadTransaction, id: string, epoch: string, watermark: string, page?: string) {
    await assertDeletionWatermark(tx, watermark);
    const selection = await selectionAt(tx, id);
    if (!selection?.active || selection.selectionEpoch !== epoch) throw stale();
    await checkDenial(tx, id, epoch, page);
    return selection;
  }

  async function provider<T>(selection: NotionSelection, watermark: string, stream: Parameters<typeof connection.read<T>>[0],
    page?: string, signal?: AbortSignal, rememberDenial = true, preserveTemporary = false) {
    const {id, selectionEpoch: epoch} = selection;
    try {
      return await connection.read(stream, () => snapshot(tx => live(tx, id, epoch, watermark, page)), signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof NotionSourceUnavailable && error.invalidated) {
        if (!rememberDenial) throw error;
        const key = error.invalidated.kind === 'selection' ? 'root' : error.invalidated.pageId;
        await locked(async tx => {
          await live(tx, id, epoch, watermark);
          await recordLocalRead(withinLearnerTransaction(db, tx), {learner:tx.learner, ownerKind:'session',
            ownerId:denialOwner(id, epoch), stepKey:key, label:'notion-access-denial', input:{}}, async () => 'denied', async () => {});
        });
        throw new RequestError(403, 'Notion 已撤回该来源的访问。');
      }
      if (preserveTemporary && error instanceof NotionTemporaryFailure) throw error;
      if (error instanceof RequestError || error instanceof LifecycleError || error instanceof NotionSourceChanged) throw error;
      throw new RequestError(502, '未能完整核实 Notion 来源，请重试。');
    }
  }

  return {connection, snapshot, locked, live, provider};
}

type Basis = {id:string; rev:number; epoch:string; type:string};
export async function savedNotionWitnesses(tx: ReadTransaction, inputs: Manifest['inputs']) {
  const facts = await manifestFactInputs(tx, inputs);
  if (!facts.length) return [];
  const {rows} = await tx.query<{id:string; rev:number}>(`SELECT f.id,r.rev FROM facts f
    JOIN fact_revs r ON (r.learner_id,r.fact_id)=(f.learner_id,f.id)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.id=ANY($3) AND r.data->>'kind'='notion'`,
    [tx.learner,captureSourceType,facts.map(input => input.id)]);
  const ids = new Set(rows.map(r => r.id + ':' + r.rev));
  return facts.filter(f => ids.has(f.id + ':' + f.rev)).map(f => ({id:f.id,rev:f.rev,epoch:f.accessEpoch,type:captureSourceType}));
}

async function notionPageAuthority(tx: ReadTransaction, source: ReturnType<typeof sourceEnvelope>) {
  return {selection:(await selectionAt(tx,source.sourceSelectionId!))!, pageId:source.externalId!, watermark:await deletionWatermark(tx)};
}

export async function notionSendBasis(tx: ReadTransaction, witnesses: Iterable<Basis>, recipient: NotionRecipient, check?: CheckNotionRead) {
  const pages = [];
  let unconfirmed: NotionReadUnconfirmed | undefined;
  for (const witness of witnesses) {
    if (witness.type !== captureSourceType) continue;
    const fact = await createAuthorizedFactReader(tx,'teaching',recipient).reopen({...witness,id:factId(witness.id),
      accessEpoch:witness.epoch as FactSnapshot['accessEpoch'], mode:'pinned'});
    if (!await checkStudioNotionFact(tx,fact,'teaching',recipient)) continue;
    if (!check) pages.push(await notionPageAuthority(tx, sourceEnvelope(fact.value)));
    else try { await check(fact); }
    catch (error) {
      if (!(error instanceof NotionReadUnconfirmed)) throw error;
      // A withdrawn witness takes precedence over another witness's transient failure.
      unconfirmed = error;
    }
  }
  if (unconfirmed) throw unconfirmed;
  return pages;
}

export async function teachingResultAuthority(tx: ReadTransaction, turnId: string, turn: ReturnType<typeof studyTurn>,
  rawManifest: unknown, grantCurrent: (turn: ReturnType<typeof studyTurn>) => Promise<boolean>, check: CheckNotionRead,
  origin?: ReturnType<typeof studyTurn>, use: 'publish' | 'history' = 'publish') {
  try {
    const manifest = parseManifest(rawManifest);
    if (manifest.purpose !== teaching || !await teachingTurnAllowed(tx,turn,grantCurrent,origin))
      return {state:'withdrawn'} as const;
    const recipient: NotionRecipient = () => true;
    if (turn.providerId && turn.protocol && turn.workspaceRevision)
      recipient.notionRecipientId = notionModelRecipient(turn.providerId, turn.baseUrl, turn.protocol, turn.model, turn.workspaceRevision);
    const memoryBasis = await teachingMemoryBasis(tx, manifest, turnId, recipient);
    if (!memoryBasis || (turn.learningToolsVersion === 1 && !await questionReceiptsCurrent(tx,turnId,use)))
      return {state:'withdrawn'} as const;
    await notionSendBasis(tx, [...await savedNotionWitnesses(tx, manifest.inputs), ...memoryBasis.objects], recipient, check);
    return {state:'authorized', memoryBasis} as const;
  } catch (error) {
    return error instanceof NotionReadUnconfirmed ? {state:'unconfirmed'} as const : {state:'withdrawn'} as const;
  }
}

const notionUnconfirmedReason = '暂时无法确认 Notion 来源。';
export class NotionReadUnconfirmed extends FactReadDeniedError {
  constructor() { super('recipient', notionUnconfirmedReason); }
}

export class NotionReadUnchecked extends NotionReadUnconfirmed {}
export class NotionReadTemporaryFailure extends NotionReadUnconfirmed {}

export type { CheckNotionRead } from '../../modules/capture/notion-read-plan.ts';
type Projection<T, Tx = ReadTransaction> = (tx: Tx, check: CheckNotionRead) => Promise<T>;

// A scope lasts for one projection (including any recall it mounts). No remote
// authority carries over to a later HTTP request, stream refresh, or model send.
export function notionReadScope(db: Db, learner: LearnerId, {readOnly = false, signal}: {readOnly?: boolean; signal?: AbortSignal} = {}) {
  const {snapshot, locked, provider} = notionHost(db, {learner});
  const lockedReadOnly = readOnly ? async <T>(project: (tx: ReadTransaction) => Promise<T>) => {
    try { return await db.snapshot({learner}, project, {lockLearner:true}); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '40001')
        throw new RequestError(503, '课堂依据正在更新，请重试。');
      throw error;
    }
  } : undefined;
  return notionPageReadFence<ReadTransaction, DbTransaction>(notionPageAuthority,
    ({selection,pageId,watermark},stream,abort) => provider(selection,watermark,stream,pageId,abort,!readOnly,true),
    error => {
      if (error instanceof RequestError) return error.status === 403 ? 'withdrawn' : 'unconfirmed';
      return error instanceof LifecycleError ? 'unconfirmed' : undefined;
    },
    status => status === undefined ? new NotionReadUnchecked() : status === 'withdrawn'
      ? new FactReadDeniedError('recipient','未能确认 Notion 来源。')
      : status === 'temporary-failure' ? new NotionReadTemporaryFailure() : new NotionReadUnconfirmed(),
    {snapshot, locked, lockedReadOnly, signal});
}

export type NotionReadScope = ReturnType<typeof notionReadScope>;
export function confirmNotionRead<T>(db: Db, learner: LearnerId, read: Projection<T>, publish?: Projection<T, DbTransaction>) {
  const scope = notionReadScope(db, learner);
  return publish ? scope.read(read, publish) : scope.read(read);
}

export async function confirmNotionDispatch(db: Db, pages: Awaited<ReturnType<typeof notionSendBasis>>) {
  const {provider} = notionHost(db);
  const unique = new Map(pages.map(page => [notionPageKey(page), page]));
  for (const {selection,pageId,watermark} of unique.values()) {
    await provider(selection,watermark,notionConfirmPageAccess(selection.root,pageId),pageId);
  }
}

const blockPolicy = { slot: { type: notionBlockSlot }, deriver: notionBlockDeriver, purpose: learningReader.purpose };
export const notionBlockRoute = { deriver: notionBlockDeriver };
const blockRecovery = {slotType:notionBlockSlot,deriver:notionBlockDeriver,code:'notion-remote-unconfirmed',migrateDefaultLane:true};
const blockAccess = (tx: ReadTransaction) => selectedAccess(tx, {purpose:learningReader.purpose, recipientId:learningReader.id, maySend:() => true}, true);
const exhaustBlock = (db: Db, ref: WorkRef, remote: boolean) => remote
  ? blockRoutedWork(db,ref,blockRecovery.code,notionUnconfirmedReason)
  : blockRoutedWork(db,ref,'notion-execution-exhausted','Notion 块处理重试已耗尽。');

function blockWithdrawn(error: unknown) {
  return !(error instanceof NotionReadUnconfirmed) &&
    (error instanceof NotionBlockUnavailable || error instanceof NotionSelectionUnavailable || error instanceof FactNotFoundError ||
      error instanceof FactReadDeniedError || (error instanceof RequestError && error.status === 403));
}

const blockScopeKeys = JSON.stringify({ purpose: blockPolicy.purpose, recipientId: learningReader.id });
function createNotionHooks(afterFactsChanged?: CommandHooks['onFactsChanged']) {
  return createStudioCommandHooks({ async afterFactsChanged(tx, tick, changes) {
    await retireNotionChanges(retireDeps, tx, tick, changes);
    const read = createCommandReadContext(tx, 'storage');
    for await (const basis of changedNotionBlockWork(read, blockPolicy.purpose, changes)) await requestCatalogedWork(
      tx, tick, { slotType: notionBlockSlot, slotKey: notionBlockWorkKey(basis), deriver: notionBlockDeriver }, blockScopeKeys, { pendingState: 'routed_pending' },
    );
    await afterFactsChanged?.(tx, tick, changes);
  } });
}

const retireDeps = {findManifestDependents, notionSelectionType, captureSourceType, notionBlockSlot, teachingSlotType,
  notionModelRecipient};
const notionHooks = createNotionHooks();

export async function executeNotionBlockWork(db: Db, ref: WorkRef, terminal: boolean, cause?: WorkFailureCause) {
  const prepare = async (tx: DbTransaction, check: CheckNotionRead) => {
    const work = await readReadyWork(tx, ref);
    if (!work || work.slotType !== notionBlockSlot || work.deriver !== notionBlockDeriver) return;
    try {
      await openCurrentNotionBlock(blockAccess(tx), parseNotionBlockWorkKey(work.slotKey), check);
      return work;
    } catch (error) {
      const bound = withinLearnerTransaction(db, tx);
      if (blockWithdrawn(error)) await cancelWork(bound, ref);
      else if (terminal && error instanceof NotionReadUnconfirmed)
        await exhaustBlock(bound,ref,cause === 'remote-unavailable' && error instanceof NotionReadTemporaryFailure);
      else throw error;
      return;
    }
  };
  await notionReadScope(db, studioLearner).publishAfterChecks(prepare, async (tx, work) => {
    if (!work) return;
    const bound = withinLearnerTransaction(db, tx);
    if (terminal) { await exhaustBlock(bound,ref,cause === 'remote-unavailable'); return; }
    const snapshot = await gatherSnapshot(bound, {learner:tx.learner, purpose:blockPolicy.purpose}, ctx => gatherNotionBlock(ctx, work.slotKey));
    const sealed = await sealCandidate(bound, ref, blockPolicy, snapshot);
    if (sealed.kind === 'sealed') await submitCandidate(bound, ref, blockPolicy, sealed.id,
      {kind:'failed', reason:new NotionBlockResolverUnavailable().message}, notionHooks);
  });
}

export function openStudioNotion(db: Db, capture: LoadedModule, afterFactsChanged?: CommandHooks['onFactsChanged']) {
  const {connection, snapshot, locked, live, provider} = notionHost(db);
  const hooks = afterFactsChanged ? createNotionHooks(afterFactsChanged) : notionHooks;
  const handle = (tx: DbTransaction) => createCommandHandler(withinLearnerTransaction(db, tx), {modules:[capture], hooks});

const notionReadToolDeps = {db, studioLearner, handle, factId, sourceEnvelope, notionReadScope,
  notionPageAuthority, provider, notionReadPage, notionSelectionWitness, prepareNotionRevision,
  notionRefreshHasChanges, prepareNotionRefreshInput, commandId, stableId, refreshNotionSourceCommand,
  notionRevisionDiff, UnchangedNotionSourceError, RequestError, FactNotFoundError, FactReadDeniedError,
  NotionSelectionUnavailable, NotionSourceChanged, NotionSourceUnavailable, LifecycleError, stale, open: readStudioNotionSource};


  const ownerAccess = {purpose:'storage', recipientId:studioLearner, maySend:(s:FactSnapshot) => s.ref.learner === studioLearner};
  const settings = () => openNotionSettings({
    snapshot, connection, availablePresets, selectionAt, sources, deletionWatermark,
    readSource: (tx: ReadTransaction, sourceId: FactId) => readStudioNotionSource(tx, sourceId, {mode:'following'}, ownerAccess),
  }, notionSelectionType);

  async function mutate(action: string, raw: Record<string, unknown>, sourceId?: string) {
    const requestId = clientRequest(raw.requestId);
    if (raw.deletionWatermark === undefined) throw new RequestError(400, '需要设备原始删除水位。');
    const watermark = submittedWatermark(raw);
    const {requestId: _request, deletionWatermark: _watermark, ...fields} = raw;
    if ((action === 'purpose' || action === 'retract') && sourceId) {
      const {expectedRev,accessEpoch,preset,...selectionFields} = fields;
      const {selectionId,expectedEpoch,recipient} = parseSettings(() => selectionChange(selectionFields));
      if (recipient || (action === 'purpose' ? preset !== 'storage' : preset !== undefined))
        throw new RequestError(400, action === 'purpose' ? '此操作只将该原件收窄为本人存储。' : '此操作仅撤回单个原件。');
      const target = parseSettings(() => notionSourceTarget({id:sourceId,selectionId,expectedRev,accessEpoch}));
      return locked(async tx => {
        const read = () => openFollowing(tx,target.id,ownerAccess);
        const saved = await record(tx,requestId,action === 'purpose'
          ? {action,target,preset:'storage',expectedEpoch,watermark}
          : {action,target,expectedEpoch,watermark},async () => {
          const fact = await read();
          if (sourceEnvelope(fact.value).sourceSelectionId !== selectionId || fact.ref.rev !== expectedRev || fact.accessEpoch !== accessEpoch) throw stale();
          const receipt = await handle(tx)({learner:tx.learner,actor:'learner',purpose:'storage',deletionWatermark:watermark,
            type:action === 'purpose' ? setNotionPurposeCommand : revokeNotionSourceCommand,
            id:commandId(stableId(action === 'purpose' ? 'notion-purpose' : 'notion-retract',requestId)),
            input:(action === 'purpose' ? {...target,preset:'storage'} : target) as Json});
          return String(receipt.wrote[0]?.rev ?? expectedRev);
        },async () => { await live(tx,selectionId,expectedEpoch,watermark); });
        if (action === 'retract') {
          const {rows:[row]} = await tx.query<{retracted_rev:number|null; access_epoch:string}>(
            'SELECT retracted_rev, access_epoch::text FROM facts WHERE learner_id=$1 AND id=$2', [tx.learner, target.id]);
          if (!row || String(row.retracted_rev) !== saved) throw stale();
          return {id:sourceId,rev:row.retracted_rev,accessEpoch:row.access_epoch,retracted:true};
        }
        const fact = await read();
        if (String(fact.ref.rev) !== saved || fact.purpose.length !== 1 || fact.purpose[0] !== 'storage') throw stale();
        return {id:sourceId,rev:fact.ref.rev,accessEpoch:fact.accessEpoch,purpose:fact.purpose};
      });
    }
    const change = parseSettings(() => action === 'grant' ? selectionGrant(fields) : selectionChange(fields));
    const {selectionId,expectedEpoch} = change;
    if (action === 'sync') {
      if ('recipient' in change) throw new RequestError(400,'同步仅接受选源标识与代次。');
      return sync(requestId,selectionId,expectedEpoch,watermark);
    }
    if (action !== 'revoke' && action !== 'grant') throw new RequestError(400,'无效的选源操作。');
    const type = action === 'grant' ? grantNotionSelectionCommand : revokeNotionSelectionCommand;
    return locked(async tx => {
      const epoch = await record(tx, requestId, {action, fields:fields as Json, watermark}, async () => {
        if ('settings' in change) {
          const {settings} = change;
          const preset = (await availablePresets()).find(p => p.id === settings.preset)!;
          if (!preset.available) throw new RequestError(422,preset.reason!);
          if (settings.recipients.some(use => !preset.allowedRecipients.some(r => r.id === use.id && r.purpose === use.purpose)))
            throw new RequestError(400,'接收人或用途未在此宿主启用。');
        }
        const current = await selectionAt(tx, selectionId);
        if ((current?.selectionEpoch ?? '0') !== expectedEpoch) throw stale();
        if (!current && action === 'revoke') throw new RequestError(404, '没有该选源。');
        const saved = await handle(tx)({learner:tx.learner, actor:'learner', purpose:'storage', deletionWatermark:watermark,
          type, id:commandId(stableId('notion-choice', requestId)), input:fields as Json});
        return String(saved.wrote[0]?.rev ?? expectedEpoch);
      }, () => assertDeletionWatermark(tx, watermark));
      const next = await selectionAt(tx, selectionId);
      if (next?.selectionEpoch !== epoch) throw stale();
      return {selectionId, epoch, active:next.active};
    });
  }

  async function record(tx: DbTransaction, requestId: string, input: Json, save: () => Promise<string>, authorize: () => Promise<void>) {
    try {
      return await recordLocalRead(withinLearnerTransaction(db,tx), {learner:tx.learner, ownerKind:'session',
        ownerId:stableId('notion-request',requestId), stepKey:'result', label:'notion-request', input}, save, authorize);
    } catch (error) {
      if (error instanceof Error && error.message === 'Workspace read receipt does not match the request') throw stale();
      throw error;
    }
  }

  async function sync(requestId: string, selectionId: string, epoch: string, watermark: string) {
    type Receipt = {selectionId:string; epoch:string; sources:{id:FactId;rev:number}[]};
    async function receipt(tx: DbTransaction, save: () => Promise<Receipt>) {
      const encoded = await record(tx, requestId, {action:'sync', selectionId, epoch, watermark}, async () => JSON.stringify(await save()),
        async () => { await live(tx, selectionId, epoch, watermark); });
      const result = JSON.parse(encoded) as Receipt;
      for (const ref of result.sources) await readStudioNotionSource(tx, ref.id, {mode:'following'}, ownerAccess);
      return result;
    }
    try { return await locked(tx => receipt(tx, async () => { throw new FetchRequired(); })); }
    catch (error) { if (!(error instanceof FetchRequired)) throw error; }
    const {selection, before, deniedPages, recoveryPages} = await snapshot(async tx => {
      const selection = await live(tx, selectionId, epoch, watermark);
      if (selection.preset !== 'storage' && selection.preset !== 'learning') throw new RequestError(422,'短期材料不能同步为长期原件。');
      const denied = await tx.query<{step_key:string}>(`SELECT step_key FROM effects WHERE learner_id=$1
        AND owner_kind='session' AND owner_id=$2 AND label='notion-access-denial'`, [tx.learner, denialOwner(selectionId, epoch)]);
      const before = await sources(tx,selection);
      return {selection, before, deniedPages:new Set(denied.rows.map(row => row.step_key)),
        recoveryPages:selection.root.kind === 'data-source'
          ? notionBlockRecoveryPages(before, await readRoutedWorkForRecovery(tx,blockRecovery)) : []};
    });
    const prepared = await prepareSelectedNotionPages(selection, before[0], deniedPages, () => new Date().toISOString(),
      (stream, pageId, supplemental) => provider(selection, watermark, stream, pageId, undefined, true, supplemental),
      {pages:recoveryPages, defer:reason => console.warn('Notion 补查延后', reason)}).catch(error => {
      if (error instanceof NotionSourceChanged) throw stale();
      throw error;
    });
    return locked(tx => receipt(tx, async () => {
      const refs = [];
      const current = await sources(tx, selection);
      for (const item of prepared) {
        const prior = current.find((s: any) => s.id === item.id);
        if (prior?.rev !== before.find((s: any) => s.id === item.id)?.rev) throw stale();
        await checkDenial(tx, selectionId, epoch, item.envelope.externalId);
        const fact = prior && await readStudioNotionSource(tx, item.id, {mode:'following'}, ownerAccess);
        const input = fact ? await prepareNotionRefreshInput(
          {id:item.id,expectedRev:fact.ref.rev,accessEpoch:fact.accessEpoch,selectionId},sourceEnvelope(fact.value),item.envelope)
          : {...item, purpose:[...new Set(['storage', ...selection.recipients.map(r => r.purpose)])]};
        const saved = await handle(tx)({learner:tx.learner, actor:'companion', purpose:'storage', deletionWatermark:watermark,
          type:fact ? refreshNotionSourceCommand : captureSourceCommand, id:commandId(stableId('notion-sync-row', requestId, item.id)),
          input:input as Json}).catch(error => {
            if (error instanceof Error && error.message === 'Notion 页面观测已过时或同一版本不一致。') throw stale();
            throw error;
          });
        refs.push({id:item.id, rev:saved.wrote.find(row => row.id === item.id)?.rev ?? fact!.ref.rev});
      }
      const confirmed = new Set(refs.map(ref => ref.id));
      await reconcileRoutedWork(tx, blockRecovery, planNotionBlockRecovery(blockAccess(tx),confirmed,blockWithdrawn));
      return {selectionId, epoch, sources:refs};
    }));
  }

  async function openFollowing(tx: ReadTransaction, id: FactId, access: Access) {
    try { return await readStudioNotionSource(tx,id,{mode:'following'},access); }
    catch { throw new RequestError(403,'这份 Notion 来源未获当前接收人授权。'); }
  }

  async function read(id: string, view: string | null, send: (data: unknown) => void) {
    return openNotionRead({snapshot, locked, live, provider, stale, selectionAt, deletionWatermark,
      sourceEnvelope, notionConfirmPageAccess, ownerAccess, learningReader, factId, openFollowing, RequestError}, id, view, send);
  }

  async function readTool(input: NotionReadInput, step: number, access: Access,
    authorize: (tx: ReadTransaction) => Promise<void>): Promise<NotionReadHostOutcome> {
    return notionReadTool(notionReadToolDeps, input, step, access, authorize) as Promise<NotionReadHostOutcome>;
  }
  return {settings, mutate, read, readTool};
}
