import type {
  DbTransaction, DerivationId, FactChange, FactId, FactSnapshot, ReadTransaction, Tick,
} from '@mangekyo/kernel';
import { cancelPendingWork, invalidateDerivationTree } from '@mangekyo/kernel';
import {
  buildNotionInvalidationTarget, filterInvalidatedNotionTargets, notionBlockRetirementMatchesSlot,
  notionRecordPurpose, notionSelectionFromSnapshot, parseNotionBlockSlotKey, planNotionBlockRetirements,
  planNotionSelectionInvalidation, reconstructNotionFactPair,
  type NotionFactTransitionRow, type NotionInvalidationSourceRow,
} from './notion-source.ts';

export type RetireNotionDeps = {
  readonly notionSelectionType: string;
  readonly captureSourceType: string;
  readonly notionBlockSlot: string;
  readonly teachingSlotType: string;
  readonly notionModelRecipient: (providerId: string, baseUrl: string, protocol: string, model: string, workspaceRevision: string) => string;
};

const liveDerivationSql = `NOT d.is_shadow AND d.invalidated_tick IS NULL AND (d.lifecycle='candidate' OR (d.lifecycle IN ('effective','superseded') AND d.effective_tick IS NOT NULL))`;
const turnJoinSql = (alias: string) => `LEFT JOIN facts tf ON tf.learner_id=${alias}.learner_id AND tf.id=${alias}.slot_key AND ${alias}.slot_type=$4 AND tf.type='activity.studyTurn'
  LEFT JOIN fact_revs tr ON (tr.learner_id,tr.fact_id,tr.rev)=(tf.learner_id,tf.id,tf.current_rev)`;

const turnModelRecipient = (data: unknown, deps: RetireNotionDeps) => {
  if (!data || typeof data !== 'object') return undefined;
  const turn = data as Record<string, unknown>;
  return typeof turn.providerId === 'string' && typeof turn.baseUrl === 'string' && typeof turn.protocol === 'string' &&
    typeof turn.model === 'string' && typeof turn.workspaceRevision === 'string'
    ? deps.notionModelRecipient(turn.providerId, turn.baseUrl, turn.protocol, turn.model, turn.workspaceRevision) : undefined;
};

async function readFactTransition(tx: ReadTransaction, change: FactChange) {
  if (change.ref.rev <= 1) return null;
  const { rows } = await tx.query<NotionFactTransitionRow>(
    `SELECT f.type, f.access_epoch::text AS "accessEpoch", r.rev, r.kind, r.purpose, r.data
     FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id)=(f.learner_id,f.id)
     WHERE f.learner_id=$1 AND f.id=$2 AND r.rev IN ($3,$4) ORDER BY r.rev`,
    [tx.learner, change.ref.id, change.ref.rev - 1, change.ref.rev],
  );
  return reconstructNotionFactPair(tx.learner, change.ref.id, change.kind, rows);
}

export async function retireNotionChanges(deps: RetireNotionDeps, tx: DbTransaction, tick: Tick, changes: readonly FactChange[]) {
  type LiveRow = { id: string; slotType: string; slotKey: string; scopeKeys?: unknown; slotScopeKeys?: unknown; manifest?: unknown; turnData?: unknown };
  const toTarget = (row: LiveRow) => buildNotionInvalidationTarget(row, {
    blockSlotType: deps.notionBlockSlot,
    blockSourceId: row.slotType === deps.notionBlockSlot ? parseNotionBlockSlotKey(row.slotKey)?.id : undefined,
    fallbackRecipientId: row.slotType === deps.teachingSlotType ? turnModelRecipient(row.turnData, deps) : undefined,
  });
  for (const change of changes) {
    if (change.factType === deps.notionSelectionType && change.kind === 'correct') {
      const pair = await readFactTransition(tx, change);
      if (!pair) continue;
      const invalidation = planNotionSelectionInvalidation(notionSelectionFromSnapshot(pair.previous), notionSelectionFromSnapshot(pair.current));
      if (!invalidation.retracted.length) continue;
      const { rows: sourceRows } = await tx.query<NotionInvalidationSourceRow>(
        `SELECT f.id, r.data->>'sourceSelectionId' AS "sourceSelectionId", r.data->>'sourceSelectionEpoch' AS "sourceSelectionEpoch", r.data->>'externalId' AS "externalId"
         FROM facts f JOIN fact_revs r ON (f.learner_id,f.id,f.current_rev)=(r.learner_id,r.fact_id,r.rev)
         WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.data->>'kind'='notion' AND r.data->>'sourceSelectionId'=$3`,
        [tx.learner, deps.captureSourceType, invalidation.selectionId],
      );
      const sourceIds = sourceRows.map(row => row.id);
      if (!sourceIds.length) continue;
      const { rows: derivationRows } = await tx.query<LiveRow>(
        `SELECT d.id, d.slot_type AS "slotType", d.slot_key AS "slotKey", d.scope_keys AS "scopeKeys", s.scope_keys AS "slotScopeKeys", d.manifest, tr.data AS "turnData"
         FROM derivations d LEFT JOIN slot_state s ON (s.learner_id,s.slot_type,s.slot_key)=(d.learner_id,d.slot_type,d.slot_key) ${turnJoinSql('d')}
         WHERE d.learner_id=$1 AND ${liveDerivationSql} AND ((CASE WHEN d.slot_type=$3 THEN (d.slot_key::jsonb)->>'id' END)=ANY($2::text[])
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(d.manifest->'inputs') entry WHERE entry->>'kind'='fact' AND entry->>'id'=ANY($2::text[])))`,
        [tx.learner, sourceIds, deps.notionBlockSlot, deps.teachingSlotType],
      );
      await invalidateDerivationTree(tx, tick, filterInvalidatedNotionTargets(invalidation, sourceRows, derivationRows.map(toTarget))
        .map(row => row.id as DerivationId), 'notion-selection-invalidated');
      const { rows: workRows } = await tx.query<LiveRow>(
        `SELECT w.id, w.slot_type AS "slotType", w.slot_key AS "slotKey", s.scope_keys AS "scopeKeys", w.gather_manifest AS manifest, tr.data AS "turnData"
         FROM work w JOIN slot_state s ON (s.learner_id,s.slot_type,s.slot_key)=(w.learner_id,w.slot_type,w.slot_key) ${turnJoinSql('w')}
         WHERE w.learner_id=$1 AND (w.state IN ('ready','waiting') OR (w.slot_type=$3 AND w.state='blocked'))
           AND ((CASE WHEN w.slot_type=$3 THEN (w.slot_key::jsonb)->>'id' END)=ANY($2::text[])
             OR (w.gather_manifest IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(w.gather_manifest->'inputs') entry WHERE entry->>'kind'='fact' AND entry->>'id'=ANY($2::text[]))))`,
        [tx.learner, sourceIds, deps.notionBlockSlot, deps.teachingSlotType],
      );
      await cancelPendingWork(tx, tick, filterInvalidatedNotionTargets(invalidation, sourceRows, workRows.map(toTarget)),
        'notion-selection-invalidated', { includeBlockedSlotTypes: [deps.notionBlockSlot] });
    } else if (change.factType === deps.captureSourceType) {
      const pair = await readFactTransition(tx, change);
      if (!pair) continue;
      const blockPlan = planNotionBlockRetirements(pair.previous, pair.current);
      if (blockPlan.retire.length) {
        const { rows: blockDerivations } = await tx.query<{ id: string; slotKey: string; manifest: unknown }>(
          `SELECT d.id, d.slot_key AS "slotKey", d.manifest FROM derivations d
           WHERE d.learner_id=$1 AND d.slot_type=$2 AND ${liveDerivationSql} AND (CASE WHEN d.slot_type=$2 THEN (d.slot_key::jsonb)->>'id' END)=$3`,
          [tx.learner, deps.notionBlockSlot, change.ref.id],
        );
        await invalidateDerivationTree(tx, tick, blockDerivations
          .filter(row => notionBlockRetirementMatchesSlot(blockPlan.retire, row.slotKey, notionRecordPurpose(row.manifest)))
          .map(row => row.id as DerivationId), 'notion-block-retired');
        const { rows: blockWork } = await tx.query<{ id: string; slotType: string; slotKey: string; scopeKeys: unknown; manifest: unknown }>(
          `SELECT w.id, w.slot_type AS "slotType", w.slot_key AS "slotKey", s.scope_keys AS "scopeKeys", w.gather_manifest AS manifest
           FROM work w JOIN slot_state s ON (s.learner_id,s.slot_type,s.slot_key)=(w.learner_id,w.slot_type,w.slot_key)
           WHERE w.learner_id=$1 AND w.slot_type=$2 AND w.state IN ('ready','waiting','blocked') AND (CASE WHEN w.slot_type=$2 THEN (w.slot_key::jsonb)->>'id' END)=$3`,
          [tx.learner, deps.notionBlockSlot, change.ref.id],
        );
        await cancelPendingWork(tx, tick, blockWork.filter(row =>
          notionBlockRetirementMatchesSlot(blockPlan.retire, row.slotKey, notionRecordPurpose(row.manifest, row.scopeKeys))), 'notion-block-retired',
          { includeBlockedSlotTypes: [deps.notionBlockSlot] });
      }
      if (change.kind === 'retract' || change.kind === 'set_purpose') {
        const { rows: gatheredWork } = await tx.query<{ id: string; slotType: string; slotKey: string; manifest: unknown }>(
          `SELECT w.id, w.slot_type AS "slotType", w.slot_key AS "slotKey", w.gather_manifest AS manifest
           FROM work w WHERE w.learner_id=$1 AND w.state IN ('ready','waiting') AND w.gather_manifest IS NOT NULL
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(w.gather_manifest->'inputs') entry WHERE entry->>'kind'='fact' AND entry->>'id'=$2)`,
          [tx.learner, change.ref.id],
        );
        const cancelled = change.kind === 'retract' ? gatheredWork : gatheredWork.filter(row => {
          const workPurpose = notionRecordPurpose(row.manifest);
          return workPurpose !== undefined && !pair.current.purpose.includes(workPurpose) && !pair.current.purpose.includes('all');
        });
        await cancelPendingWork(tx, tick, cancelled, change.kind === 'retract' ? 'notion-source-retracted' : 'notion-purpose-changed',
          { includeBlockedSlotTypes: [deps.notionBlockSlot] });
      }
    }
  }
}

export type NotionSettingsDeps = {
  readonly snapshot: <T>(read: (tx: ReadTransaction) => Promise<T>) => Promise<T>;
  readonly connection: {configured: boolean};
  readonly availablePresets: () => Promise<unknown[]>;
  readonly selectionAt: (tx: ReadTransaction, id: string) => Promise<any>;
  readonly sources: (tx: ReadTransaction, selection: any, allGenerations?: boolean) => Promise<readonly {id: FactId; rev: number}[]> | Promise<readonly {id: FactId; rev: number; pageId: string; lastEditedTime: string}[]>;
  readonly readSource: (tx: ReadTransaction, sourceId: FactId) => Promise<FactSnapshot>;
  readonly deletionWatermark: (tx: ReadTransaction) => Promise<string>;
};

export function openNotionSettings(deps: NotionSettingsDeps, notionSelectionType: string) {
  return deps.snapshot(async tx => {
    const {rows} = await tx.query<{id:string}>(`SELECT r.data->>'id' AS id FROM facts f JOIN fact_revs r
      ON (f.learner_id,f.id,f.current_rev)=(r.learner_id,r.fact_id,r.rev)
      WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL ORDER BY f.id`, [tx.learner, notionSelectionType]);
    const selections = [];
    for (const {id} of rows) {
      const current = await deps.selectionAt(tx, id);
      if (!current) continue;
      const {root, preset, recipients, selectionEpoch:epoch, active} = current;
      const visible = [];
      if (active) for (const source of await deps.sources(tx, current, true)) {
        try {
          const fact = await deps.readSource(tx, source.id);
          visible.push({id:source.id, rev:source.rev, accessEpoch:fact.accessEpoch, purpose:fact.purpose});
        } catch { continue; }
      }
      selections.push({selectionId:id, epoch, active, root, preset, recipients, label:root.id, sources:visible});
    }
    return {configured:deps.connection.configured, presets:await deps.availablePresets(), selections, watermark:await deps.deletionWatermark(tx)};
  });
}

export function openNotionRead(deps: Record<string, any>, id: string, view: string | null, send: (data: unknown) => void) {
  return (async () => {
    if (view !== null && view !== 'learning') throw new deps.RequestError(400,'无效的读取用途。');
    const access = view ? {...deps.ownerAccess, purpose:deps.learningReader.purpose, recipientId:deps.learningReader.id} : deps.ownerAccess;
    const open = (tx: any) => deps.openFollowing(tx, deps.factId(id), access);
    const initial = await deps.snapshot(async (tx: any) => {
      const fact = await open(tx);
      const source = deps.sourceEnvelope(fact.value);
      return {fact, source, selection: (await deps.selectionAt(tx,source.sourceSelectionId!))!, watermark:await deps.deletionWatermark(tx)};
    });
    await deps.provider(initial.selection, initial.watermark,
      deps.notionConfirmPageAccess(initial.selection.root,initial.source.externalId!), initial.source.externalId);
    return deps.locked(async (tx: any) => {
      await deps.live(tx,initial.selection.id,initial.selection.selectionEpoch,initial.watermark,initial.source.externalId);
      const fact = await open(tx);
      if (fact.ref.rev !== initial.fact.ref.rev || fact.accessEpoch !== initial.fact.accessEpoch) throw deps.stale();
      const {unit} = deps.sourceEnvelope(fact.value);
      send({id, rev:fact.ref.rev, accessEpoch:fact.accessEpoch, purpose:fact.purpose, title:unit.title, blocks:unit.blocks.map((b: any) => ({id:b.id,parentId:b.parentId,text:b.body.status === 'known' ? b.body.text : null}))});
    });
  })();
}

export async function notionReadTool(deps: Record<string, any>, input: any, step: number, access: any,
  authorize: (tx: any) => Promise<void>) {
    const id = deps.factId(input.sourceId);
    const wanted = input.blockIds && new Set(input.blockIds);
    const emit = (fact: FactSnapshot, status: 'refreshed' | 'unchanged',
      diff: any = {added: [], removed: [], edited: [], moved: []}) => ({
      sourceId: input.sourceId, rev: fact.ref.rev, accessEpoch: fact.accessEpoch, title: deps.sourceEnvelope(fact.value).unit.title,
      status, diff, blocks: deps.sourceEnvelope(fact.value).unit.blocks
        .filter((block: any) => !wanted || wanted.has(block.id))
        .map((block: any) => ({id: block.id, parentId: block.parentId, text: block.body.status === 'known' ? block.body.text : ''})),
    });
    const open = (tx: ReadTransaction) => deps.open(tx, id, {mode: 'following'}, access);
    const notion = deps.notionReadScope(deps.db, deps.studioLearner);
    const project = async (tx: ReadTransaction, check: any) => {
      await authorize(tx);
      const fact = await open(tx);
      await check(fact);
      return {fact, page: await deps.notionPageAuthority(tx, deps.sourceEnvelope(fact.value))};
    };
    let lastFact: FactSnapshot | undefined;
    try {
      const {fact, page} = await notion.read(async (tx: any, check: any) => {
        const found = await project(tx, check);
        lastFact = found.fact;
        return found;
      });
      if (!input.refresh) return {ok: true, data: emit(fact, 'refreshed')};
      const previous = deps.sourceEnvelope(fact.value);
      const fetched = await deps.provider(page.selection, page.watermark,
        deps.notionReadPage(page.selection.root, page.pageId, deps.notionSelectionWitness(page.selection)), page.pageId);
      const received = await deps.prepareNotionRevision(page.selection, fetched, new Date().toISOString());
      if (!deps.notionRefreshHasChanges(previous, received)) return {ok: false, kind: 'unchanged', snapshot: emit(fact, 'unchanged')};
      const refresh = await deps.prepareNotionRefreshInput(
        {id: input.sourceId, expectedRev: fact.ref.rev, accessEpoch: fact.accessEpoch, selectionId: page.selection.id},
        previous, received);
      const data = await notion.read(async (tx: any, check: any) => {
        const {fact: current} = await project(tx, check);
        lastFact = current;
        if (current.ref.rev !== fact.ref.rev || current.accessEpoch !== fact.accessEpoch) throw deps.stale();
        return current;
      }, async (tx: any, check: any) => {
        const current = await project(tx, check).then(found => found.fact);
        lastFact = current;
        if (current.ref.rev !== fact.ref.rev || current.accessEpoch !== fact.accessEpoch) throw deps.stale();
        await deps.handle(tx)({learner: tx.learner, actor: 'companion', purpose: 'storage', deletionWatermark: page.watermark,
          type: deps.refreshNotionSourceCommand, id: deps.commandId(deps.stableId('notion-read-refresh', input.sourceId, String(step), String(fact.ref.rev))),
          input: refresh as any});
        const saved = await open(tx);
        lastFact = saved;
        return emit(saved, 'refreshed', deps.notionRevisionDiff(previous, deps.sourceEnvelope(saved.value)));
      });
      return {ok: true, data};
    } catch (error) {
      const message = error instanceof Error ? {message: error.message} : {};
      if (error instanceof deps.UnchangedNotionSourceError && lastFact)
        return {ok: false, kind: 'unchanged', snapshot: emit(lastFact, 'unchanged')};
      if (error instanceof deps.RequestError) return {ok: false, kind: (error as any).status === 403 ? 'withdrawn' : 'unconfirmed', ...message};
      if (error instanceof deps.FactNotFoundError) return {ok: false, kind: 'not_found', ...message};
      if (error instanceof deps.FactReadDeniedError || error instanceof deps.NotionSelectionUnavailable) return {ok: false, kind: 'denied', ...message};
      if (error instanceof deps.NotionSourceChanged || error instanceof deps.NotionSourceUnavailable) return {ok: false, kind: 'stale', ...message};
      if (error instanceof deps.LifecycleError) return {ok: false, kind: 'stale_watermark', ...message};
      return {ok: false, kind: 'unconfirmed', ...message};
    }
  }

export async function notionSources(deps: Record<string, any>, tx: any, selection: any, allGenerations = false) {
  return (await tx.query(`WITH current AS (
    SELECT f.id,f.type,r.rev,r.data FROM facts f JOIN fact_revs r ON (f.learner_id,f.id,f.current_rev)=(r.learner_id,r.fact_id,r.rev)
    WHERE f.learner_id=$1 AND f.type IN ($2,$6) AND f.retracted_rev IS NULL)
    SELECT s.id,s.rev,s.data->>'externalId' AS "pageId",greatest(s.data->>'occurredAt',m.data->>'lastEditedTime') AS "lastEditedTime"
    FROM current s LEFT JOIN current m ON m.type=$6 AND m.data->>'sourceId'=s.id AND m.data->>'selectionEpoch'=s.data->>'sourceSelectionEpoch'
    WHERE s.type=$2 AND s.data->>'sourceSelectionId'=$3 AND ($5 OR s.data->>'sourceSelectionEpoch'=$4) AND s.data->>'kind'='notion'
    ORDER BY "lastEditedTime" DESC,"pageId" DESC`, [tx.learner, deps.captureSourceType, selection.id, selection.selectionEpoch, allGenerations, deps.notionPageObservationType])).rows;
}
export async function checkNotionDenial(deps: Record<string, any>, tx: any, id: string, epoch: string, page?: string, since = epoch) {
  const owners = [];
  for (let generation = Number(since); generation <= Number(epoch); generation++) owners.push(deps.denialOwner(id,String(generation)));
  const {rowCount} = await tx.query(`SELECT FROM effects WHERE learner_id=$1 AND owner_kind='session'
    AND owner_id=ANY($2) AND label='notion-access-denial' AND step_key=ANY($3)`, [tx.learner, owners, ['root', ...(page ? [page] : [])]]);
  if (rowCount) throw new deps.RequestError(403, 'Notion 已撤回该来源的访问。请重新确认选源。');
}
