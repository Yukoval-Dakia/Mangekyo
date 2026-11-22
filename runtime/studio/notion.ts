import { manifestFactInputs } from '../../kernel/src/derivations/revalidate.ts';
import { teachingMemoryBasis } from './memory-claims.ts';
import type { studyTurn } from '../../modules/activity/values.ts';
import { parseManifest, type Manifest } from '../../kernel/src/derivations/manifest.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { withLearnerLock, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createAuthorizedFactReader, createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { commandId, factId, type FactId, type LearnerId } from '../../kernel/src/declarations/ids.ts';
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
import { notionConfirmPageAccess, notionReadPage, NotionSourceChanged, NotionSourceUnavailable } from '../../modules/capture/notion-api.ts';
import { checkNotionDenial, notionReadTool, notionSources, openNotionRead, openNotionSettings, retireNotionChanges } from '../../modules/capture/notion-host-support.ts';
import { grantNotionSelectionCommand, revokeNotionSelectionCommand, notionSelectionType, selectionChange, selectionGrant,
  notionSelectionWitness, readNotionSelection, type NotionSelection, type NotionReadOptions } from '../../modules/capture/notion-selection.ts';
import {
  notionPageObservationType, NotionSelectionUnavailable,
  notionSourceTarget, openSelectedNotionSource,
  prepareNotionRefreshInput, prepareNotionRevision, prepareSelectedNotionPages,
  refreshNotionSourceCommand, revokeNotionSourceCommand, setNotionPurposeCommand,
  notionRefreshHasChanges, notionRevisionDiff, UnchangedNotionSourceError,
} from '../../modules/capture/notion-source.ts';
import { NotionBlockUnavailable, openCurrentNotionBlock } from '../../modules/capture/notion-blocks.ts';
import { changedNotionBlockWork, gatherNotionBlock, notionBlockDeriver, notionBlockRecoveryPages,
  notionBlockSlot, notionBlockWorkKey, planNotionBlockRecovery } from '../../modules/capture/notion-block-work.ts';
import { captureSourceCommand, captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import {
  checkStudioNotionFactBody,
  collectNotionSendBasis,
  teachingResultAuthorityBody,
  prepareNotionBlockWork,
  publishNotionBlockWork,
  FetchRequired,
  isFetchRequired,
  notionAvailablePresets,
  notionLiveSelection,
  runNotionProvider,
  notionDenialOwner,
  notionReadErrorFor,
  notionReadStatusOf,
  notionWitnessesOf,
  planNotionMutation,
  runNotionChoiceMutation,
  runNotionSyncRows,
  runNotionSyncReceipt,
  selectedNotionAccess,
  confirmNotionDispatchBody,
  notionOpenFollowing,
  notionLockedReadOnly,
  notionRecord,
  notionSourcesFor,
  checkNotionDenialFor,
  notionPageAuthorityFor,
  runNotionSyncFinalize,
  runNotionSyncSnapshot,
  runNotionSourceMutation,
  staleNotionError,
  translatePreparedSyncError,
} from '../../modules/capture/studio-notion-helpers.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { notionModelRecipient, purpose as teaching, slotType as teachingSlotType, stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { teachingTurnAllowed } from './reading.ts';
import { submittedWatermark } from '../../modules/capture/request.ts';
import { notionTeachingRecipients } from './workspace-access.ts';
import { notionConnection } from './notion-transport.ts';
import { questionReceiptsCurrent } from './question-exposure.ts';
import type { NotionReadHostOutcome, NotionReadInput } from '../../executors/teaching/notion-read-tool.ts';

const notionUnconfirmedReason = '暂时无法确认 Notion 来源。';
export class NotionReadUnconfirmed extends FactReadDeniedError {
  constructor() { super('recipient', notionUnconfirmedReason); }
}
export class NotionReadUnchecked extends NotionReadUnconfirmed {}
export class NotionReadTemporaryFailure extends NotionReadUnconfirmed {}

const learnerScope = {learner: studioLearner};
const learningReader = {id: 'studio:learning-reader', purpose: 'learning', label: '本机学习阅读器'} as const;
const availablePresets = async () => notionAvailablePresets(learningReader, await notionTeachingRecipients());

const selectionAt = (tx: ReadTransaction, id: string) => readNotionSelection(createCommandReadContext(tx, 'storage'), tx.learner, id);
type Access = {purpose: string; recipientId: string; maySend: (fact: FactSnapshot) => boolean};

const checkDenial = (tx: ReadTransaction, id: string, epoch: string, page?: string) => checkNotionDenialFor(checkNotionDenial as never, tx, id, epoch, page);
function selectedAccess(tx: ReadTransaction, access: Access, requireCurrentSelection = false) {
  return selectedNotionAccess({
    selectionRead: (inner: ReadTransaction) => createCommandReadContext(inner, 'storage'),
    sourceRead: (inner: ReadTransaction, use: string, maySend: (fact: FactSnapshot) => boolean) => createAuthorizedFactReader(inner, use, maySend),
    checkDenial,
  }, tx, access, requireCurrentSelection);
}

export function readStudioNotionSource(tx: ReadTransaction, sourceId: FactId, options: NotionReadOptions, access: Access) {
  return openSelectedNotionSource(selectedAccess(tx, access), sourceId, options);
}

export type NotionRecipient = ((fact: FactSnapshot) => boolean) & {notionRecipientId?: string};

export async function checkStudioNotionFact(tx: ReadTransaction, fact: FactSnapshot, purpose: string, recipient: NotionRecipient | 'learner', reopen?: (fact: FactSnapshot) => Promise<FactSnapshot>) {
  return checkStudioNotionFactBody({
    captureSourceType,
    sourceEnvelope,
    readStudioNotionSource: (inner, sourceId, options, access) => readStudioNotionSource(inner, sourceId, options, access),
    accessDenied: () => new FactReadDeniedError('recipient','Notion 来源或选源对当前接收人已不可用。'),
  }, tx, fact, purpose, recipient, reopen);
}

const sources = (tx: ReadTransaction, selection: NotionSelection, allGenerations = false) => notionSourcesFor(notionSources as never, captureSourceType, notionPageObservationType, tx, selection, allGenerations) as ReturnType<typeof notionSources>;
const stale = staleNotionError;

function notionHost(db: Db, scope = learnerScope) {
  const connection = notionConnection();
  const snapshot = <T>(read: (tx: ReadTransaction) => Promise<T>) => db.snapshot(scope, read);
  const locked = <T>(action: (tx: DbTransaction) => Promise<T>) => withLearnerLock(db, scope, action);

  const liveHost = { assertDeletionWatermark, selectionAt, checkDenial };
  const providerHost = {
    connectionRead: <T>(stream: Parameters<typeof connection.read<T>>[0], authorize: () => Promise<unknown>, signal?: AbortSignal) => connection.read(stream, authorize as never, signal),
    snapshot,
    locked,
    recordLocalRead: (bound: unknown, witness: never, run: () => Promise<string>, verify: () => Promise<void>) => recordLocalRead(bound as never, witness as never, run as never, verify as never),
    withinLearnerTransaction: (tx: DbTransaction) => withinLearnerTransaction(db, tx),
    isLifecycle: (error: unknown) => error instanceof LifecycleError,
  };

  async function live(tx: ReadTransaction, id: string, epoch: string, watermark: string, page?: string) {
    return notionLiveSelection(liveHost, tx, id, epoch, watermark, page);
  }

  async function provider<T>(selection: NotionSelection, watermark: string, stream: Parameters<typeof connection.read<T>>[0],
    page?: string, signal?: AbortSignal, rememberDenial = true, preserveTemporary = false): Promise<T> {
    return runNotionProvider(providerHost as never, liveHost, { selection, watermark, stream, page, signal, rememberDenial, preserveTemporary });
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
  return notionWitnessesOf(facts, rows, captureSourceType);
}

const notionPageAuthority = (tx: ReadTransaction, source: ReturnType<typeof sourceEnvelope>) => notionPageAuthorityFor(selectionAt as never, deletionWatermark as never, tx, source);

export async function notionSendBasis(tx: ReadTransaction, witnesses: Iterable<Basis>, recipient: NotionRecipient, check?: CheckNotionRead) {
  // A withdrawn witness takes precedence over another witness's transient failure.
  return collectNotionSendBasis({
    reopen: (inner, use, rec, witness) => createAuthorizedFactReader(inner, use, rec).reopen({
      id: factId(witness.id), rev: witness.rev, accessEpoch: witness.epoch as FactSnapshot['accessEpoch'], mode: 'pinned' }),
    checkStudioNotionFact: (inner, fact, use, rec) => checkStudioNotionFact(inner, fact, use, rec as NotionRecipient | 'learner'),
    notionPageAuthority: (inner, envelope) => notionPageAuthority(inner, envelope as ReturnType<typeof sourceEnvelope>),
    sourceEnvelope,
    captureSourceType,
    isUnconfirmed: error => error instanceof NotionReadUnconfirmed,
  }, tx, witnesses, recipient, check) as Promise<{selection: NotionSelection; pageId: string; watermark: string}[]>;
}

export async function teachingResultAuthority(tx: ReadTransaction, turnId: string, turn: ReturnType<typeof studyTurn>,
  rawManifest: unknown, grantCurrent: (turn: ReturnType<typeof studyTurn>) => Promise<boolean>, check: CheckNotionRead,
  origin?: ReturnType<typeof studyTurn>, use: 'publish' | 'history' = 'publish'): Promise<
    | { readonly state: 'withdrawn' }
    | { readonly state: 'unconfirmed' }
    | { readonly state: 'authorized'; readonly memoryBasis: NonNullable<Awaited<ReturnType<typeof teachingMemoryBasis>>> }> {
  return teachingResultAuthorityBody({
    parseManifest,
    teachingPurpose: teaching,
    teachingTurnAllowed,
    notionModelRecipient,
    teachingMemoryBasis,
    questionReceiptsCurrent,
    savedNotionWitnesses: (inner, inputs) => savedNotionWitnesses(inner, inputs as Manifest['inputs']),
    notionSendBasis: (inner, witnesses, recipient, innerCheck) => notionSendBasis(inner, witnesses, recipient as NotionRecipient, innerCheck),
    isUnconfirmed: error => error instanceof NotionReadUnconfirmed,
  }, tx, turnId, turn, rawManifest, grantCurrent, check, origin, use,
    () => ((() => true) as NotionRecipient)) as Promise<Awaited<ReturnType<typeof teachingResultAuthority>>>;
}

export type { CheckNotionRead } from '../../modules/capture/notion-read-plan.ts';
type Projection<T, Tx = ReadTransaction> = (tx: Tx, check: CheckNotionRead) => Promise<T>;

// A scope lasts for one projection (including any recall it mounts). No remote
// authority carries over to a later HTTP request, stream refresh, or model send.
export function notionReadScope(db: Db, learner: LearnerId, {readOnly = false, signal}: {readOnly?: boolean; signal?: AbortSignal} = {}) {
  const {snapshot, locked, provider} = notionHost(db, {learner});
  const lockedReadOnly = notionLockedReadOnly(readOnly, (project, options) => db.snapshot({ learner }, project as never, options)) as never;
  return notionPageReadFence<ReadTransaction, DbTransaction>(notionPageAuthority,
    ({selection,pageId,watermark},stream,abort) => provider(selection,watermark,stream,pageId,abort,!readOnly,true),
    error => notionReadStatusOf(error, lifecycleError => lifecycleError instanceof LifecycleError),
    status => notionReadErrorFor({ denied: () => new FactReadDeniedError('recipient','未能确认 Notion 来源。'), unchecked: () => new NotionReadUnchecked(), temporaryFailure: () => new NotionReadTemporaryFailure(), unconfirmed: () => new NotionReadUnconfirmed() }, status),
    {snapshot, locked, lockedReadOnly, signal});
}

export type NotionReadScope = ReturnType<typeof notionReadScope>;
export function confirmNotionRead<T>(db: Db, learner: LearnerId, read: Projection<T>, publish?: Projection<T, DbTransaction>) {
  const scope = notionReadScope(db, learner);
  return publish ? scope.read(read, publish) : scope.read(read);
}

export async function confirmNotionDispatch(db: Db, pages: Awaited<ReturnType<typeof notionSendBasis>>) {
  const {provider} = notionHost(db);
  return confirmNotionDispatchBody(pages, notionPageKey, provider as never, notionConfirmPageAccess as never);
}

const blockPolicy = { slot: { type: notionBlockSlot }, deriver: notionBlockDeriver, purpose: learningReader.purpose };
export const notionBlockRoute = { deriver: notionBlockDeriver };
const blockRecovery = {slotType:notionBlockSlot,deriver:notionBlockDeriver,code:'notion-remote-unconfirmed',migrateDefaultLane:true};
const blockAccess = (tx: ReadTransaction) => selectedAccess(tx, {purpose:learningReader.purpose, recipientId:learningReader.id, maySend:() => true}, true);
const exhaustBlock = (db: Db, ref: WorkRef, remote: boolean) => remote
  ? blockRoutedWork(db,ref,blockRecovery.code,notionUnconfirmedReason)
  : blockRoutedWork(db,ref,'notion-execution-exhausted','Notion 块处理重试已耗尽。');

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

const retireDeps = {notionSelectionType, captureSourceType, notionBlockSlot, teachingSlotType, notionModelRecipient};
const notionHooks = createNotionHooks();
const runtimeBlockWithdrawn = (error: unknown) => !(error instanceof NotionReadUnconfirmed) && (error instanceof NotionBlockUnavailable || error instanceof NotionSelectionUnavailable || error instanceof FactNotFoundError || error instanceof FactReadDeniedError || (error instanceof RequestError && error.status === 403));


export async function executeNotionBlockWork(db: Db, ref: WorkRef, terminal: boolean, cause?: WorkFailureCause) {
  const host = {
    readReadyWork,
    openCurrentNotionBlock,
    blockAccess,
    cancelWork,
    withinLearnerTransaction: (tx: DbTransaction) => withinLearnerTransaction(db, tx),
    exhaustBlock: (_bound: unknown, innerRef: WorkRef, remote: boolean) => exhaustBlock(db, innerRef, remote),
    gatherSnapshot,
    sealCandidate,
    submitCandidate,
    gatherNotionBlock,
    blockPolicy,
    blockHooks: notionHooks,
    isBlockWithdrawn: runtimeBlockWithdrawn,
    isUnconfirmed: (error: unknown) => error instanceof NotionReadUnconfirmed,
    isTemporaryFailure: (error: unknown) => error instanceof NotionReadTemporaryFailure,
  };
  await notionReadScope(db, studioLearner).publishAfterChecks(
    (tx, check) => prepareNotionBlockWork(host as never, tx, ref, check, terminal, cause),
    (tx, work) => publishNotionBlockWork(host as never, tx, work, ref, terminal, cause));
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

  const mutationDeps = { clientRequest, submittedWatermark, selectionChange, selectionGrant, notionSourceTarget };

  async function mutate(action: string, raw: Record<string, unknown>, sourceId?: string) {
    const plan = planNotionMutation(action, raw, sourceId, mutationDeps);
    if (plan.kind === 'source') {
      return locked(tx => runNotionSourceMutation({
        openFollowing: (inner, id) => openFollowing(inner, id, ownerAccess),
        sourceEnvelope,
        handle,
        record,
        live: (inner, id, epoch, watermark) => live(inner, id, epoch, watermark),
        readRetractedRev: async (inner, id) => (await inner.query<{retracted_rev:number|null; access_epoch:string}>(
          'SELECT retracted_rev, access_epoch::text FROM facts WHERE learner_id=$1 AND id=$2', [inner.learner, id])).rows[0],
        setNotionPurposeCommand,
        revokeNotionSourceCommand,
        commandIdOf: commandId,
        stableIdOf: stableId,
      }, tx, plan)).then(result => ({ ...result, id: sourceId! }));
    }
    if (plan.kind === 'sync') {
      return sync(plan.requestId, plan.selectionId, plan.expectedEpoch, plan.watermark);
    }
    return locked(tx => runNotionChoiceMutation({
      selectionAt,
      handle,
      record,
      assertDeletionWatermark,
      availablePresets,
      grantNotionSelectionCommand,
      revokeNotionSelectionCommand,
      commandIdOf: commandId,
      stableIdOf: stableId,
    }, tx, plan));
  }

  const record = (tx: DbTransaction, requestId: string, input: Json, save: () => Promise<string>, authorize: () => Promise<void>) => notionRecord(recordLocalRead as never, withinLearnerTransaction as never, db, { tx, requestId, input, save, authorize });

  async function sync(requestId: string, selectionId: string, epoch: string, watermark: string) {
    type Receipt = {selectionId:string; epoch:string; sources:{id:FactId;rev:number}[]};
    const receiptHost = {
      record,
      live,
      openFollowing: (inner: DbTransaction, id: FactId) => readStudioNotionSource(inner, id, {mode:'following'}, ownerAccess),
    };
    const receipt = (tx: DbTransaction, save: () => Promise<Receipt>) => runNotionSyncReceipt(receiptHost as never, tx, { requestId, selectionId, epoch, watermark, save });
    try { return await locked(tx => receipt(tx, async () => { throw new FetchRequired(); })); }
    catch (error) { if (!isFetchRequired(error)) throw error; }
    const {selection, before, deniedPages, recoveryPages} = await snapshot(tx => runNotionSyncSnapshot({
      live,
      readDenied: async inner => (await inner.query<{step_key:string}>(`SELECT step_key FROM effects WHERE learner_id=$1
        AND owner_kind='session' AND owner_id=$2 AND label='notion-access-denial'`, [inner.learner, notionDenialOwner(selectionId, epoch)])).rows,
      sources: (inner, sel) => sources(inner, sel) as never,
      readRoutedWorkForRecovery: (inner, recovery) => readRoutedWorkForRecovery(inner, recovery as never),
      notionBlockRecoveryPages: (beforeRows, work) => notionBlockRecoveryPages(beforeRows as never, work as never),
      blockRecovery,
    }, tx, { selectionId, epoch, watermark })) as {selection: Awaited<ReturnType<typeof selectionAt>> & object; before: Awaited<ReturnType<typeof sources>>; deniedPages: ReadonlySet<string>; recoveryPages: readonly string[]};
    const prepared = await prepareSelectedNotionPages(selection, before[0], deniedPages, () => new Date().toISOString(),
      (stream, pageId, supplemental) => provider(selection, watermark, stream, pageId, undefined, true, supplemental),
      {pages:recoveryPages, defer:reason => console.warn('Notion 补查延后', reason)}).catch(translatePreparedSyncError);
    return locked(tx => receipt(tx, async () => {
      const refs = await runNotionSyncRows({
        sources: (inner, sel) => sources(inner, sel) as never,
        checkDenial,
        openFollowing: (inner, id) => readStudioNotionSource(inner, id, {mode:'following'}, ownerAccess),
        sourceEnvelope,
        prepareNotionRefreshInput,
        handle,
        refreshNotionSourceCommand,
        captureSourceCommand,
        commandIdOf: commandId,
        stableIdOf: stableId,
      }, tx, { selection, selectionId, epoch, watermark, requestId, before, prepared });
      await runNotionSyncFinalize({ reconcileRoutedWork: reconcileRoutedWork as never, blockRecovery, planNotionBlockRecovery: planNotionBlockRecovery as never, isBlockWithdrawn: runtimeBlockWithdrawn, blockAccess }, tx, refs);
      return {selectionId, epoch, sources:refs};
    }));
  }

  const openFollowing = (tx: ReadTransaction, id: FactId, access: Access) => notionOpenFollowing(readStudioNotionSource as never, tx, id, access) as ReturnType<typeof readStudioNotionSource>;

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
