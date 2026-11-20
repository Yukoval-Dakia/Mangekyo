import type { Manifest } from '../../kernel/src/derivations/manifest.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createAuthorizedFactReader, createCommandReadContext, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Json } from '../../kernel/src/declarations/types.ts';
import { assertDeletionWatermark, deletionWatermark, LifecycleError } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { notionReadPage, notionReadRows, notionConfirmPageAccess, NotionSourceUnavailable } from '../../modules/capture/notion-api.ts';
import { grantNotionSelectionCommand, revokeNotionSelectionCommand, notionSelectionType, notionSelectionWitness, resumeNotionSelectionCursor, selectionChange, selectionGrant,
  readNotionSelection, type NotionSelection, type NotionReadOptions } from '../../modules/capture/notion-selection.ts';
import { withSelectedNotionSources, notionPageObservationType, prepareNotionRefreshInput, prepareNotionIngest, refreshNotionSourceCommand } from '../../modules/capture/notion-source.ts';
import { captureSourceCommand, captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { submittedWatermark } from './deletion-watermark.ts';
import { notionTeachingRecipients } from './notion-recipient.ts';
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

async function checkDenial(tx: ReadTransaction, id: string, epoch: string, page?: string) {
  const {rowCount} = await tx.query(`SELECT FROM effects WHERE learner_id=$1 AND owner_kind='session'
    AND owner_id=$2 AND label='notion-access-denial' AND step_key=ANY($3)`, [tx.learner, denialOwner(id, epoch), ['root', ...(page ? [page] : [])]]);
  if (rowCount) throw new RequestError(403, 'Notion 已撤回该来源的访问。请重新确认选源。');
}

export async function readStudioNotionSource(tx: ReadTransaction, sourceId: FactId, options: NotionReadOptions, access: Access) {
  const source = await withSelectedNotionSources({
    learner: tx.learner, purpose: access.purpose, recipientId: access.recipientId,
    selectionRead: createCommandReadContext(tx, 'storage'),
    sourceRead: createAuthorizedFactReader(tx, access.purpose, access.maySend),
  }).fact(sourceId, options);
  const value = source.type === captureSourceType ? sourceEnvelope(source.value) : null;
  if (value?.kind !== 'notion') throw new FactReadDeniedError('recipient','没有该 Notion 来源。');
  await checkDenial(tx, value.sourceSelectionId!, value.sourceSelectionEpoch!, value.externalId!);
  const current = await selectionAt(tx, value.sourceSelectionId!);
  if (current && current.selectionEpoch !== value.sourceSelectionEpoch)
    await checkDenial(tx, value.sourceSelectionId!, current.selectionEpoch, value.externalId!);
  return source;
}

export type NotionRecipient = ((fact: FactSnapshot) => boolean) & {notionRecipientId?: string};

export async function checkStudioNotionFact(tx: ReadTransaction, fact: FactSnapshot, purpose: string, recipient: NotionRecipient | 'learner') {
  if (fact.type !== captureSourceType || sourceEnvelope(fact.value).kind !== 'notion') return;
  try {
    return await readStudioNotionSource(tx, fact.ref.id, {mode:'pinned', rev:fact.ref.rev},
      recipient === 'learner' ? {purpose,recipientId:tx.learner,maySend:() => true} : {purpose,recipientId:recipient.notionRecipientId ?? '',maySend:recipient});
  } catch {
    throw new FactReadDeniedError('recipient','Notion 来源或选源对当前接收人已不可用。');
  }
}

function transactionDb(db: Db, tx: DbTransaction): Db {
  const nested: Db['tx'] = async (scope, run) => {
    if (scope.learner !== tx.learner) throw new Error('Notion command learner mismatch');
    return run(tx);
  };
  return {...db, query: tx.query, snapshot: nested, tx: nested};
}

async function sources(tx: ReadTransaction, selection: NotionSelection, allGenerations = false) {
  return (await tx.query<{id: FactId; rev: number; pageId:string; lastEditedTime:string}>(`SELECT f.id,r.rev,r.data->>'externalId' AS "pageId",
    greatest(r.data->>'occurredAt',observation.at) AS "lastEditedTime"
    FROM facts f JOIN fact_revs r ON (f.learner_id,f.id,f.current_rev)=(r.learner_id,r.fact_id,r.rev)
    LEFT JOIN (SELECT m.learner_id,v.data->>'sourceId' AS source,v.data->>'selectionEpoch' AS epoch,v.data->>'lastEditedTime' AS at
      FROM facts m JOIN fact_revs v ON (m.learner_id,m.id,m.current_rev)=(v.learner_id,v.fact_id,v.rev)
      WHERE m.learner_id=$1 AND m.type=$6 AND m.retracted_rev IS NULL) observation
      ON observation.source=f.id AND observation.epoch=r.data->>'sourceSelectionEpoch'
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.data->>'sourceSelectionId'=$3
      AND ($5 OR r.data->>'sourceSelectionEpoch'=$4) AND r.data->>'kind'='notion'
    ORDER BY "lastEditedTime" DESC,"pageId" DESC`, [tx.learner, captureSourceType, selection.id, selection.selectionEpoch, allGenerations, notionPageObservationType])).rows;
}

class FetchRequired extends Error {}
const stale = () => new RequestError(409, '选源或原件版本已变更，请刷新后重试。');
function parseSettings<T>(read: () => T) {
  try { return read(); } catch { throw new RequestError(400, 'Notion 选源格式无效。'); }
}

function notionHost(db: Db) {
  const connection = notionConnection();
  const snapshot = <T>(read: (tx: ReadTransaction) => Promise<T>) => db.snapshot(learnerScope, read);
  const locked = <T>(action: (tx: DbTransaction) => Promise<T>) => db.tx(learnerScope, async tx => {
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

  async function provider<T>(selection: NotionSelection, watermark: string, stream: Parameters<typeof connection.read<T>>[0], page?: string) {
    const {id, selectionEpoch: epoch} = selection;
    try {
      return await connection.read(stream, () => snapshot(tx => live(tx, id, epoch, watermark, page)));
    } catch (error) {
      if (error instanceof NotionSourceUnavailable && error.invalidated) {
        const key = error.invalidated.kind === 'selection' ? 'root' : error.invalidated.pageId;
        await locked(async tx => {
          await live(tx, id, epoch, watermark);
          await recordLocalRead(transactionDb(db, tx), {learner:tx.learner, ownerKind:'session',
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
  const facts = inputs.filter(input => input.kind === 'fact');
  const {rows} = await tx.query<{id:string}>(`SELECT id FROM facts WHERE learner_id=$1 AND type=$2 AND id=ANY($3)`,
    [tx.learner,captureSourceType,facts.map(input => input.id)]);
  const ids = new Set(rows.map(r => r.id));
  return facts.filter(f => ids.has(f.id)).map(f => ({id:f.id,rev:f.rev,epoch:f.accessEpoch,type:captureSourceType}));
}

export async function notionSendBasis(tx: ReadTransaction, witnesses: Iterable<Basis>, recipient: NotionRecipient) {
  const pages = [];
  for (const witness of witnesses) {
    if (witness.type !== captureSourceType) continue;
    const fact = await createAuthorizedFactReader(tx,'teaching',recipient).reopen({...witness,id:factId(witness.id),
      accessEpoch:witness.epoch as FactSnapshot['accessEpoch'], mode:'pinned'});
    if (!await checkStudioNotionFact(tx,fact,'teaching',recipient)) continue;
    const value = sourceEnvelope(fact.value);
    const selection = (await selectionAt(tx,value.sourceSelectionId!))!;
    pages.push({selection,pageId:value.externalId!,watermark:await deletionWatermark(tx)});
  }
  return pages;
}

export async function confirmNotionDispatch(db: Db, pages: Awaited<ReturnType<typeof notionSendBasis>>) {
  const {provider} = notionHost(db);
  for (const {selection,pageId,watermark} of pages) {
    await provider(selection,watermark,notionConfirmPageAccess(selection.root,pageId),pageId);
  }
}

export function openStudioNotion(db: Db, capture: LoadedModule) {
  const {connection, snapshot, locked, live, provider} = notionHost(db);
  const hooks = createStudioCommandHooks();
  const handle = (tx: DbTransaction) => createCommandHandler(transactionDb(db, tx), {modules:[capture], hooks});

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
          try { await readStudioNotionSource(tx, source.id, {mode:'following'}, ownerAccess); }
          catch { continue; }
          visible.push({id:source.id, rev:source.rev});
        }
        selections.push({selectionId:id, epoch, active, root, preset, recipients, label:root.id, sources:visible});
      }
      return {configured:connection.configured, presets:await availablePresets(), selections, watermark:await deletionWatermark(tx)};
    });
  }
  const ownerAccess = {purpose:'storage', recipientId:studioLearner, maySend:(s:FactSnapshot) => s.ref.learner === studioLearner};

  async function mutate(action: string, raw: Record<string, unknown>) {
    const requestId = clientRequest(raw.requestId);
    if (raw.deletionWatermark === undefined) throw new RequestError(400, '需要设备原始删除水位。');
    const watermark = submittedWatermark(raw);
    const {requestId: _request, deletionWatermark: _watermark, ...fields} = raw;
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
      return await recordLocalRead(transactionDb(db,tx), {learner:tx.learner, ownerKind:'session',
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
    const cursor = before[0] && {...dispatch, position:before[0]};
    const rows = root.kind === 'page' ? [{pageId:root.id, lastEditedTime:null}]
      : await provider(selection,watermark,notionReadRows(root, resumeNotionSelectionCursor(selection,cursor ?? null)));
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

  async function read(id: string, view: string | null, send: (data: unknown) => void) {
    if (view !== null && view !== 'learning') throw new RequestError(400,'无效的读取用途。');
    const access = view ? {...ownerAccess, purpose:learningReader.purpose, recipientId:learningReader.id} : ownerAccess;
    const sourceId = factId(id);
    const open = async (tx: ReadTransaction) => {
      try { return await readStudioNotionSource(tx, sourceId, {mode:'following'}, access); }
      catch { throw new RequestError(403, '这份 Notion 来源未获当前接收人授权。'); }
    };
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
      send({id, rev:fact.ref.rev, title:unit.title, blocks:unit.blocks.map(b => ({id:b.id,parentId:b.parentId,text:b.body.status === 'known' ? b.body.text : null}))});
    });
  }
  return {settings, mutate, read};
}
