import { manifestFactInputs } from '../../kernel/src/derivations/revalidate.ts';
import { teachingMemoryBasis } from './memory-claims.ts';
import type { studyTurn } from '../../modules/activity/values.ts';
import { parseManifest, type Manifest } from '../../kernel/src/derivations/manifest.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { lockLearner, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createAuthorizedFactReader, createCommandReadContext, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { commandId, factId, type FactId, type LearnerId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Json } from '../../kernel/src/declarations/types.ts';
import { assertDeletionWatermark, deletionWatermark, LifecycleError } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { notionReadPlan, type CheckNotionRead } from '../../modules/capture/notion-read-plan.ts';
import { notionReadPage, notionReadRows, notionConfirmPageAccess, NotionSourceUnavailable } from '../../modules/capture/notion-api.ts';
import { grantNotionSelectionCommand, revokeNotionSelectionCommand, notionSelectionType, notionSelectionWitness, selectionChange, selectionGrant,
  readNotionSelection, type NotionSelection, type NotionReadOptions } from '../../modules/capture/notion-selection.ts';
import { openSelectedNotionSource, notionSourceTarget, setNotionPurposeCommand, notionPageObservationType, prepareNotionRefreshInput, prepareNotionIngest, refreshNotionSourceCommand } from '../../modules/capture/notion-source.ts';
import { captureSourceCommand, captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { notionModelRecipient, purpose as teaching, stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { teachingTurnAllowed } from './reading.ts';
import { submittedWatermark } from './deletion-watermark.ts';
import { notionTeachingRecipients } from './workspace-access.ts';
import { notionConnection } from './notion-transport.ts';

const learnerScope = {learner: studioLearner};
const learningReader = {id: 'studio:learning-reader', purpose: 'learning', label: '本机学习阅读器'};
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
  const owners = [];
  for (let generation = Number(since); generation <= Number(epoch); generation++) owners.push(denialOwner(id,String(generation)));
  const {rowCount} = await tx.query(`SELECT FROM effects WHERE learner_id=$1 AND owner_kind='session'
    AND owner_id=ANY($2) AND label='notion-access-denial' AND step_key=ANY($3)`, [tx.learner, owners, ['root', ...(page ? [page] : [])]]);
  if (rowCount) throw new RequestError(403, 'Notion 已撤回该来源的访问。请重新确认选源。');
}

export async function readStudioNotionSource(tx: ReadTransaction, sourceId: FactId, options: NotionReadOptions, access: Access) {
  const source = await openSelectedNotionSource({
    learner: tx.learner, purpose: access.purpose, recipientId: access.recipientId,
    selectionRead: createCommandReadContext(tx, 'storage'),
    sourceRead: createAuthorizedFactReader(tx, access.purpose, access.maySend),
  },sourceId,options);
  const value = sourceEnvelope(source.value);
  const current = (await selectionAt(tx, value.sourceSelectionId!))!;
  await checkDenial(tx, current.id, current.selectionEpoch, value.externalId!, value.sourceSelectionEpoch!);
  return source;
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

async function sources(tx: ReadTransaction, selection: NotionSelection, allGenerations = false) {
  return (await tx.query<{id: FactId; rev: number; pageId:string; lastEditedTime:string}>(`WITH current AS (
    SELECT f.id,f.type,r.rev,r.data FROM facts f JOIN fact_revs r ON (f.learner_id,f.id,f.current_rev)=(r.learner_id,r.fact_id,r.rev)
    WHERE f.learner_id=$1 AND f.type IN ($2,$6) AND f.retracted_rev IS NULL)
    SELECT s.id,s.rev,s.data->>'externalId' AS "pageId",greatest(s.data->>'occurredAt',m.data->>'lastEditedTime') AS "lastEditedTime"
    FROM current s LEFT JOIN current m ON m.type=$6 AND m.data->>'sourceId'=s.id AND m.data->>'selectionEpoch'=s.data->>'sourceSelectionEpoch'
    WHERE s.type=$2 AND s.data->>'sourceSelectionId'=$3 AND ($5 OR s.data->>'sourceSelectionEpoch'=$4) AND s.data->>'kind'='notion'
    ORDER BY "lastEditedTime" DESC,"pageId" DESC`, [tx.learner, captureSourceType, selection.id, selection.selectionEpoch, allGenerations, notionPageObservationType])).rows;
}

class FetchRequired extends Error {}
const stale = () => new RequestError(409, '选源或原件版本已变更，请刷新后重试。');
function parseSettings<T>(read: () => T) {
  try { return read(); } catch { throw new RequestError(400, 'Notion 选源格式无效。'); }
}

function notionHost(db: Db, scope = learnerScope) {
  const connection = notionConnection();
  const snapshot = <T>(read: (tx: ReadTransaction) => Promise<T>) => db.snapshot(scope, read);
  const locked = <T>(action: (tx: DbTransaction) => Promise<T>) => db.tx(scope, async tx => {
    await lockLearner(tx, tx.learner);
    return action(tx);
  });

  async function live(tx: ReadTransaction, id: string, epoch: string, watermark: string, page?: string) {
    await assertDeletionWatermark(tx, watermark);
    const selection = await selectionAt(tx, id);
    if (!selection?.active || selection.selectionEpoch !== epoch) throw stale();
    await checkDenial(tx, id, epoch, page);
    return selection;
  }

  async function provider<T>(selection: NotionSelection, watermark: string, stream: Parameters<typeof connection.read<T>>[0],
    page?: string, signal?: AbortSignal, rememberDenial = true) {
    const {id, selectionEpoch: epoch} = selection;
    try {
      return await connection.read(stream, () => snapshot(tx => live(tx, id, epoch, watermark, page)), signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof NotionSourceUnavailable && error.invalidated) {
        if (!rememberDenial) throw new RequestError(403, 'Notion 已撤回该来源的访问。');
        const key = error.invalidated.kind === 'selection' ? 'root' : error.invalidated.pageId;
        await locked(async tx => {
          await live(tx, id, epoch, watermark);
          await recordLocalRead(withinLearnerTransaction(db, tx), {learner:tx.learner, ownerKind:'session',
            ownerId:denialOwner(id, epoch), stepKey:key, label:'notion-access-denial', input:{}}, async () => 'denied', async () => {});
        });
        throw new RequestError(403, 'Notion 已撤回该来源的访问。');
      }
      if (error instanceof RequestError || error instanceof LifecycleError) throw error;
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

function notionPageKey({selection,pageId,watermark}: Awaited<ReturnType<typeof notionPageAuthority>>) {
  return JSON.stringify([selection.id, selection.selectionEpoch, pageId, watermark]);
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
  origin?: ReturnType<typeof studyTurn>) {
  try {
    const manifest = parseManifest(rawManifest);
    if (manifest.purpose !== teaching || !await teachingTurnAllowed(tx,turn,grantCurrent,origin))
      return {state:'withdrawn'} as const;
    const recipient: NotionRecipient = () => true;
    if (turn.providerId && turn.protocol && turn.workspaceRevision)
      recipient.notionRecipientId = notionModelRecipient(turn.providerId, turn.baseUrl, turn.protocol, turn.model, turn.workspaceRevision);
    const memoryBasis = await teachingMemoryBasis(tx, manifest, turnId, recipient);
    if (!memoryBasis) return {state:'withdrawn'} as const;
    await notionSendBasis(tx, [...await savedNotionWitnesses(tx, manifest.inputs), ...memoryBasis.objects], recipient, check);
    return {state:'authorized', memoryBasis} as const;
  } catch (error) {
    return error instanceof NotionReadUnconfirmed ? {state:'unconfirmed'} as const : {state:'withdrawn'} as const;
  }
}

export class NotionReadUnconfirmed extends FactReadDeniedError {
  constructor() { super('recipient', '暂时无法确认 Notion 来源。'); }
}

export class NotionReadUnchecked extends NotionReadUnconfirmed {}

export type { CheckNotionRead } from '../../modules/capture/notion-read-plan.ts';
type Projection<T, Tx = ReadTransaction> = (tx: Tx, check: CheckNotionRead) => Promise<T>;

// A scope lasts for one projection (including any recall it mounts). No remote
// authority carries over to a later HTTP request, stream refresh, or model send.
export function notionReadScope(db: Db, learner: LearnerId, {readOnly = false, signal}: {readOnly?: boolean; signal?: AbortSignal} = {}) {
  const {snapshot, locked, provider} = notionHost(db, {learner});
  async function pageFor(tx: ReadTransaction, fact: FactSnapshot) {
    if (fact.type !== captureSourceType) return;
    const source = sourceEnvelope(fact.value);
    if (source.kind !== 'notion') return;
    const page = await notionPageAuthority(tx, source);
    const key = notionPageKey(page);
    return {...page, key, witness: JSON.stringify([key, fact.ref.id, fact.ref.rev, fact.accessEpoch])};
  }
  const planner = notionReadPlan<NonNullable<Awaited<ReturnType<typeof pageFor>>>>(async ({selection,pageId,watermark},abort) => {
    try {
      await provider(selection,watermark,notionConfirmPageAccess(selection.root,pageId),pageId,abort,!readOnly);
      return 'authorized';
    } catch (error) {
      abort.throwIfAborted();
      if (!(error instanceof RequestError || error instanceof LifecycleError)) throw error;
      return error instanceof RequestError && error.status===403 ? 'withdrawn' : 'unconfirmed';
    }
  }, status => status === undefined ? new NotionReadUnchecked() : status === 'withdrawn'
    ? new FactReadDeniedError('recipient','未能确认 Notion 来源。') : new NotionReadUnconfirmed(),signal);
  const check = (tx: ReadTransaction) => planner.reader(fact=>pageFor(tx,fact));
  async function read<T>(project: Projection<T>): Promise<T>;
  async function read<P, T>(project: Projection<P>, publish: Projection<T, DbTransaction>): Promise<T>;
  async function read<P, T>(project: Projection<P>, publish?: Projection<T, DbTransaction>): Promise<P | T> {
    if (readOnly && publish) throw new Error('A read-only Notion scope cannot publish');
    signal?.throwIfAborted();
    const {initial,prepared} = await snapshot(async tx=>{
      const prepared = planner.prepare(fact=>pageFor(tx,fact));
      return {initial:await project(tx,prepared.collect),prepared};
    });
    signal?.throwIfAborted();
    if (prepared.empty() && !publish) return initial;
    await prepared.resolve();
    if (readOnly) {
      try {
        return await db.snapshot({learner},tx => project(tx,check(tx)),{lockLearner:true});
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === '40001')
          throw new RequestError(503, '课堂依据正在更新，请重试。');
        throw error;
      }
    }
    return locked<P | T>(tx => {
      signal?.throwIfAborted();
      return publish ? publish(tx,check(tx)) : project(tx,check(tx));
    });
  }

  async function publishAfterChecks<P,T>(
    project: (tx: DbTransaction, check: CheckNotionRead, collect: boolean) => Promise<P>,
    publish: (tx: DbTransaction, prepared: P) => Promise<T>,
  ): Promise<T> {
    if (readOnly) throw new Error('A read-only Notion scope cannot publish');
    signal?.throwIfAborted();
    const first = await locked(async tx => {
      signal?.throwIfAborted();
      const plan = planner.prepare(fact=>pageFor(tx,fact));
      const prepared = await project(tx,plan.collect,true);
      if (!plan.empty()) return {plan};
      return {response:await publish(tx,prepared)};
    });
    if (!first.plan) return first.response;
    // A remote check runs with no learner transaction or pool connection held.
    signal?.throwIfAborted();
    await first.plan.resolve();
    return locked(async tx => {
      signal?.throwIfAborted();
      return publish(tx,await project(tx,check(tx),false));
    });
  }

  return {read,check,publishAfterChecks};
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

export function openStudioNotion(db: Db, capture: LoadedModule) {
  const {connection, snapshot, locked, live, provider} = notionHost(db);
  const handle = (tx: DbTransaction) => createCommandHandler(withinLearnerTransaction(db, tx), {modules:[capture], hooks:createStudioCommandHooks()});

  async function settings() {
    return snapshot(async tx => {
      const {rows} = await tx.query<{id:string}>(`SELECT r.data->>'id' AS id FROM facts f JOIN fact_revs r
        ON (f.learner_id,f.id,f.current_rev)=(r.learner_id,r.fact_id,r.rev)
        WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL ORDER BY f.id`, [tx.learner, notionSelectionType]);
      const selections = [];
      for (const {id} of rows) {
        const current = await selectionAt(tx, id);
        if (!current) continue;
        const {root, preset, recipients, selectionEpoch:epoch, active} = current;
        const visible = [];
        if (active) for (const source of await sources(tx, current, true)) {
          try {
            const fact = await readStudioNotionSource(tx,source.id,{mode:'following'},ownerAccess);
            visible.push({id:source.id, rev:source.rev, accessEpoch:fact.accessEpoch, purpose:fact.purpose});
          } catch { continue; }
        }
        selections.push({selectionId:id, epoch, active, root, preset, recipients, label:root.id, sources:visible});
      }
      return {configured:connection.configured, presets:await availablePresets(), selections, watermark:await deletionWatermark(tx)};
    });
  }
  const ownerAccess = {purpose:'storage', recipientId:studioLearner, maySend:(s:FactSnapshot) => s.ref.learner === studioLearner};

  async function mutate(action: string, raw: Record<string, unknown>, sourceId?: string) {
    const requestId = clientRequest(raw.requestId);
    if (raw.deletionWatermark === undefined) throw new RequestError(400, '需要设备原始删除水位。');
    const watermark = submittedWatermark(raw);
    const {requestId: _request, deletionWatermark: _watermark, ...fields} = raw;
    if (action === 'purpose' && sourceId) {
      const {expectedRev,accessEpoch,preset,...selectionFields} = fields;
      const {selectionId,expectedEpoch,recipient} = parseSettings(() => selectionChange(selectionFields));
      if (recipient || preset !== 'storage') throw new RequestError(400,'此操作只将该原件收窄为本人存储。');
      const target = parseSettings(() => notionSourceTarget({id:sourceId,selectionId,expectedRev,accessEpoch}));
      return locked(async tx => {
        const read = () => openFollowing(tx,target.id,ownerAccess);
        const saved = await record(tx,requestId,{action,target,preset,expectedEpoch,watermark},async () => {
          const fact = await read();
          if (sourceEnvelope(fact.value).sourceSelectionId !== selectionId || fact.ref.rev !== expectedRev || fact.accessEpoch !== accessEpoch) throw stale();
          await handle(tx)({learner:tx.learner,actor:'learner',purpose:'storage',deletionWatermark:watermark,type:setNotionPurposeCommand,
            id:commandId(stableId('notion-purpose',requestId)),input:{...target,preset}});
          return (await read()).ref.rev.toString();
        },async () => { await live(tx,selectionId,expectedEpoch,watermark); });
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
    const {selection, before, deniedPages} = await snapshot(async tx => {
      const selection = await live(tx, selectionId, epoch, watermark);
      if (selection.preset !== 'storage' && selection.preset !== 'learning') throw new RequestError(422,'短期材料不能同步为长期原件。');
      const denied = await tx.query<{step_key:string}>(`SELECT step_key FROM effects WHERE learner_id=$1
        AND owner_kind='session' AND owner_id=$2 AND label='notion-access-denial'`, [tx.learner, denialOwner(selectionId, epoch)]);
      return {selection, before:await sources(tx,selection), deniedPages:new Set(denied.rows.map(row => row.step_key))};
    });
    const {root} = selection;
    const dispatch = notionSelectionWitness(selection);
    const rows = root.kind === 'page' ? [{pageId:root.id, lastEditedTime:null}]
      : await provider(selection,watermark,notionReadRows(root, before[0]));
    const prepared: Awaited<ReturnType<typeof prepareNotionIngest>>[] = [];
    for (const {pageId, lastEditedTime} of rows) {
      if (deniedPages.has(pageId)) continue;
      const page = await provider(selection, watermark, notionReadPage(root,pageId,dispatch), pageId);
      if (lastEditedTime && page.lastEditedTime !== lastEditedTime) throw stale();
      prepared.push(await prepareNotionIngest(selection,page,new Date().toISOString()));
    }
    return locked(tx => receipt(tx, async () => {
      const refs = [];
      const current = await sources(tx, selection);
      for (const item of prepared) {
        const prior = current.find(s => s.id === item.id);
        if (prior?.rev !== before.find(s => s.id === item.id)?.rev) throw stale();
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
      return {selectionId, epoch, sources:refs};
    }));
  }

  async function openFollowing(tx: ReadTransaction, id: FactId, access: Access) {
    try { return await readStudioNotionSource(tx,id,{mode:'following'},access); }
    catch { throw new RequestError(403,'这份 Notion 来源未获当前接收人授权。'); }
  }

  async function read(id: string, view: string | null, send: (data: unknown) => void) {
    if (view !== null && view !== 'learning') throw new RequestError(400,'无效的读取用途。');
    const access = view ? {...ownerAccess, purpose:learningReader.purpose, recipientId:learningReader.id} : ownerAccess;
    const open = (tx: ReadTransaction) => openFollowing(tx,factId(id),access);
    const initial = await snapshot(async tx => {
      const fact = await open(tx);
      const source = sourceEnvelope(fact.value);
      return {fact, source, selection: (await selectionAt(tx,source.sourceSelectionId!))!, watermark:await deletionWatermark(tx)};
    });
    await provider(initial.selection, initial.watermark,
      notionConfirmPageAccess(initial.selection.root,initial.source.externalId!), initial.source.externalId);
    return locked(async tx => {
      await live(tx,initial.selection.id,initial.selection.selectionEpoch,initial.watermark,initial.source.externalId);
      const fact = await open(tx);
      if (fact.ref.rev !== initial.fact.ref.rev || fact.accessEpoch !== initial.fact.accessEpoch) throw stale();
      const {unit} = sourceEnvelope(fact.value);
      send({id, rev:fact.ref.rev, accessEpoch:fact.accessEpoch, purpose:fact.purpose, title:unit.title, blocks:unit.blocks.map(b => ({id:b.id,parentId:b.parentId,text:b.body.status === 'known' ? b.body.text : null}))});
    });
  }
  return {settings, mutate, read};
}
