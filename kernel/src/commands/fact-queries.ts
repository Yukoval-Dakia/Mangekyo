import type { CommandId, FactId, Revision, Tick } from '../declarations/ids.ts';
import type { Db, DbTransaction, ReadTransaction, SqlValue } from '../db/types.ts';

/**
 * Purpose- and learner-scoped reads over the kernel's own tables only
 * (`facts`, `fact_revs`, `derivations`+`slot_state`, `effects`). These do not
 * bypass `guardAccess` for content reads; callers still project via readers.
 */

export type ActiveFactsQuery = {
  readonly types: readonly string[];
  readonly purpose: string;
  readonly afterId?: FactId;
  readonly limit?: number;
};

/** Page through non-retracted facts the given purpose may read, ordered by id. */
export const listActiveFactsByTypes = (tx: ReadTransaction, q: ActiveFactsQuery) =>
  tx.query<{ id: FactId }>(
    `SELECT id FROM facts
     WHERE learner_id=$1 AND type=ANY($2::text[]) AND retracted_rev IS NULL
       AND purpose && ARRAY[$3,'all']::text[] AND ($4::text IS NULL OR id>$4)
     ORDER BY id LIMIT $5`,
    [tx.learner, q.types, q.purpose, q.afterId ?? null, q.limit ?? 100],
  );

const factOrderSql = {
  id: 'f.id',
  created_desc: 'f.created_tick DESC, f.id',
  created_desc_id_desc: 'f.created_tick DESC, f.id DESC',
  changed_desc: 'f.changed_tick DESC, f.id',
} as const;

export type FactIdsQuery = {
  readonly types: readonly string[];
  readonly purpose?: string;
  readonly includeRetracted?: boolean;
  readonly jsonField?: readonly [string, string];
  readonly order?: keyof typeof factOrderSql;
  readonly limit?: number;
};

/** Enumerate matching fact ids for a learner using kernel tables only. */
export async function listFactIds(tx: ReadTransaction, q: FactIdsQuery): Promise<FactId[]> {
  const order = factOrderSql[q.order ?? 'id'];
  const joinRev = q.jsonField ? 'JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)' : '';
  const where = [
    'f.learner_id=$1',
    'f.type=ANY($2::text[])',
    ...(q.includeRetracted ? [] : ['f.retracted_rev IS NULL']),
    ...(q.purpose ? [`f.purpose && ARRAY[$3,'all']::text[]`] : []),
    ...(q.jsonField ? [`r.data->>$${q.purpose ? 4 : 3}=$${q.purpose ? 5 : 4}`] : []),
  ];
  const params: SqlValue[] = [tx.learner, q.types];
  if (q.purpose) params.push(q.purpose);
  if (q.jsonField) params.push(q.jsonField[0], q.jsonField[1]);
  const limitSql = q.limit === undefined ? '' : ` LIMIT $${params.push(q.limit)}`;
  const { rows } = await tx.query<{ id: FactId }>(
    `SELECT f.id FROM facts f ${joinRev} WHERE ${where.join(' AND ')} ORDER BY ${order}${limitSql}`,
    params,
  );
  return rows.map(row => row.id);
}

export type FactStatusRow = {
  readonly id: FactId;
  readonly type: string;
  readonly currentRev: number;
  readonly retractedRev: number | null;
  readonly accessEpoch: Tick;
};

export async function listFactsStatus(tx: ReadTransaction, ids: readonly string[], type?: string): Promise<readonly FactStatusRow[]> {
  if (!ids.length) return [];
  const { rows } = await tx.query<FactStatusRow>(
    `SELECT id, type, current_rev AS "currentRev", retracted_rev AS "retractedRev", access_epoch::text AS "accessEpoch"
     FROM facts WHERE learner_id=$1 AND id=ANY($2::text[]) AND ($3::text IS NULL OR type=$3)`,
    [tx.learner, ids, type ?? null],
  );
  return rows;
}

export type FactCommandBirthQuery = {
  readonly rev?: number;
  readonly factType?: string;
  readonly commandId?: CommandId;
  readonly commandTypes?: readonly string[];
  readonly author?: string;
};

export type FactCommandBirthRow = {
  readonly rev: number;
  readonly priorRev: number | null;
  readonly author: string;
  readonly data: unknown;
  readonly commandId: CommandId;
  readonly commandType: string;
  readonly commandInput: unknown;
};

/** Inspect the committed command and revision metadata that produced a fact revision. */
export async function readFactCommandBirth(
  db: Pick<Db, 'query'> | ReadTransaction,
  learner: string,
  id: FactId,
  q: FactCommandBirthQuery = {},
): Promise<FactCommandBirthRow | undefined> {
  const { rows: [row] } = await db.query<FactCommandBirthRow>(
    `SELECT r.rev, r.corrects_rev AS "priorRev", r.author, r.data,
       c.id AS "commandId", c.type AS "commandType", c.input AS "commandInput"
     FROM fact_revs r
     JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
     JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
     WHERE r.learner_id=$1 AND r.fact_id=$2 AND c.state='done'
       AND ($3::int IS NULL OR r.rev=$3) AND ($4::text IS NULL OR f.type=$4)
       AND ($5::text IS NULL OR c.id=$5) AND ($6::text[] IS NULL OR c.type=ANY($6::text[]))
       AND ($7::text IS NULL OR r.author=$7)
     ORDER BY r.rev LIMIT 1`,
    [learner, id, q.rev ?? null, q.factType ?? null, q.commandId ?? null, q.commandTypes ?? null, q.author ?? null],
  );
  if (row && typeof row.commandInput === 'string') return { ...row, commandInput: JSON.parse(row.commandInput) };
  return row;
}

/** Tick the fact was first recorded at the given rev (rev=1 is "birth"). */
export async function readFactBirthTick(tx: ReadTransaction, id: FactId, rev: Revision = 1 as Revision) {
  const { rows: [row] } = await tx.query<{ tick: string | bigint | number }>(
    `SELECT tick FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=$3`,
    [tx.learner, id, rev],
  );
  return row === undefined ? undefined : (String(row.tick) as Tick);
}

export async function readLearnerClock(tx: ReadTransaction): Promise<Tick> {
  const { rows: [row] } = await tx.query<{ clock: string | bigint | number }>(
    'SELECT clock FROM learners WHERE id=$1', [tx.learner],
  );
  if (!row) throw new Error('Learner clock missing');
  return String(row.clock) as Tick;
}

/** Read authorship and recording time at a revision (defaults to rev 1 birth). */
export async function readFactOrigin(tx: ReadTransaction, id: FactId, rev: Revision = 1 as Revision) {
  const { rows: [row] } = await tx.query<{ tick: string | bigint | number; author: string }>(
    'SELECT tick,author FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=$3', [tx.learner, id, rev],
  );
  return row && { author: row.author, tick: String(row.tick) as Tick };
}

export async function readRevisionManifestTick(tx: ReadTransaction, id: FactId, rev: Revision = 1 as Revision) {
  const { rows: [row] } = await tx.query<{ tick: string | null }>(
    "SELECT data->'manifest'->>'gatherTick' AS tick FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=$3",
    [tx.learner, id, rev],
  );
  return row?.tick ?? undefined;
}

export type FactRevisionProvenance = { readonly id: FactId; readonly author: string; readonly tick: Tick };

export async function listRevisionProvenance(tx: ReadTransaction, refs: readonly { id: FactId; rev: Revision }[]) {
  if (!refs.length) return [] as FactRevisionProvenance[];
  const { rows } = await tx.query<{ fact_id: FactId; author: string; tick: string | bigint | number }>(
    `SELECT original.fact_id,original.author,source.tick FROM fact_revs source
     JOIN fact_revs original ON (original.learner_id,original.fact_id,original.rev)=(source.learner_id,source.fact_id,1)
     JOIN unnest($2::text[],$3::int[]) chosen(id,rev) ON (source.fact_id,source.rev)=(chosen.id,chosen.rev)
     WHERE source.learner_id=$1`,
    [tx.learner, refs.map(ref => ref.id), refs.map(ref => ref.rev)],
  );
  return rows.map(row => ({ id: row.fact_id, author: row.author, tick: String(row.tick) as Tick }));
}

export type FactRevisionRow = {
  readonly factId: FactId; readonly rev: number; readonly kind: string; readonly author: string;
  readonly commandId: string; readonly tick: Tick;
};

export type FactRevisionsQuery = {
  readonly factIds?: readonly FactId[]; readonly types?: readonly string[];
  readonly sinceTick?: Tick; readonly limit?: number;
};

/** Enumerate revision rows for the caller's learner, tick-ascending. */
export async function listFactRevisions(tx: ReadTransaction, q: FactRevisionsQuery) {
  const { rows } = await tx.query<{
    fact_id: FactId; rev: number; kind: string; author: string; command_id: string; tick: string | bigint | number;
  }>(
    `SELECT r.fact_id, r.rev, r.kind, r.author, r.command_id, r.tick
     FROM fact_revs r JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
     WHERE r.learner_id=$1
       AND ($2::text[] IS NULL OR r.fact_id=ANY($2))
       AND ($3::text[] IS NULL OR f.type=ANY($3))
       AND ($4::bigint IS NULL OR r.tick>=$4)
     ORDER BY r.tick, r.fact_id, r.rev LIMIT $5`,
    [tx.learner, q.factIds ?? null, q.types ?? null, q.sinceTick ?? null, q.limit ?? 100],
  );
  return rows.map(({ fact_id, rev, kind, author, command_id, tick }) => ({
    factId: fact_id, rev, kind, author, commandId: command_id, tick: String(tick) as Tick,
  }));
}

export type EffectiveDerivationQuery = {
  readonly slotType: string; readonly slotKey: string; readonly id?: string;
  /** When true, the slot's current pointer must still reference this derivation. */
  readonly requireCurrent?: boolean;
};

export type EffectiveDerivationRow = { readonly id: string; readonly value: unknown; readonly manifest: unknown };

export async function readSlotStatus<Scope = unknown>(tx: ReadTransaction, slotType: string, slotKey: string) {
  const { rows: [row] } = await tx.query<{
    lastId: string | null; lastError: { status?: string } | null; scopeKeys: Scope;
  }>(
    `SELECT last_id AS "lastId", last_error AS "lastError", scope_keys AS "scopeKeys"
     FROM slot_state WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3`,
    [tx.learner, slotType, slotKey],
  );
  return row;
}

export async function readDerivationSlot(tx: ReadTransaction, id: string) {
  const { rows: [row] } = await tx.query<{ slotType: string; slotKey: string }>(
    'SELECT slot_type AS "slotType", slot_key AS "slotKey" FROM derivations WHERE learner_id=$1 AND id=$2',
    [tx.learner, id],
  );
  return row;
}

/** Read a settled derivation row that is still effective (or superseded). */
export async function readEffectiveDerivation(tx: ReadTransaction, q: EffectiveDerivationQuery) {
  const { rows: [row] } = await tx.query<EffectiveDerivationRow>(
    `SELECT d.id, d.value, d.manifest FROM derivations d
     WHERE d.learner_id=$1 AND d.slot_type=$2 AND d.slot_key=$3 AND ($4::text IS NULL OR d.id=$4)
       AND NOT d.is_shadow AND d.invalidated_tick IS NULL AND d.effective_tick IS NOT NULL
       AND d.lifecycle IN ('effective','superseded')
       AND (NOT $5::boolean OR (d.lifecycle='effective' AND EXISTS (
         SELECT 1 FROM slot_state s WHERE s.learner_id=d.learner_id
           AND s.slot_type=d.slot_type AND s.slot_key=d.slot_key
           AND s.current_id=d.id AND s.last_error IS NULL)))`,
    [tx.learner, q.slotType, q.slotKey, q.id ?? null, q.requireCurrent ?? false],
  );
  return row;
}

export type CompletedEffectsQuery = { readonly ownerKind: string; readonly ownerId: string; readonly label: string };

/** Completed effect rows for one (owner,label) pair, for audit reads. */
export const listCompletedEffects = (tx: ReadTransaction, q: CompletedEffectsQuery) =>
  tx.query<{ result: unknown }>(
    `SELECT result FROM effects
     WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND label=$4 AND state='done'`,
    [tx.learner, q.ownerKind, q.ownerId, q.label],
  );

export type SlotFailure = { readonly status: 'blocked' | 'failed' | 'unknown'; readonly message?: string; readonly reason?: string };

export async function markSlotFailed(tx: DbTransaction, slotType: string, slotKey: string, failure: SlotFailure, tick?: Tick) {
  await tx.query(
    `UPDATE slot_state SET last_error=$4${tick === undefined ? '' : ',changed_tick=$5'}
     WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3`,
    tick === undefined
      ? [tx.learner, slotType, slotKey, JSON.stringify(failure)]
      : [tx.learner, slotType, slotKey, JSON.stringify(failure), tick],
  );
}

export async function readLatestCompletedEffect(tx: ReadTransaction, label: string) {
  const { rows: [row] } = await tx.query<{ endedTick: string; result: unknown }>(
    `SELECT ended_tick::text AS "endedTick",result FROM effects
     WHERE learner_id=$1 AND label=$2 AND state='done' ORDER BY ended_tick DESC LIMIT 1`,
    [tx.learner, label],
  );
  return row;
}

export async function listEffectLabels(tx: ReadTransaction, ownerKind: string, ownerId: string): Promise<Set<string>> {
  const { rows } = await tx.query<{ label: string }>(
    'SELECT DISTINCT label FROM effects WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3',
    [tx.learner, ownerKind, ownerId],
  );
  return new Set(rows.map(row => row.label));
}

export type CurrentSlotQuery = {
  readonly factType: string;
  readonly slotType: string;
  readonly keyField?: string;
  readonly keyValue?: string;
  readonly newestFirst?: boolean;
  readonly limit?: number;
};

export type CurrentSlotFactRow = {
  readonly id: FactId;
  readonly value: unknown;
  readonly derivationId: string | null;
  readonly manifest: unknown;
  readonly settled: boolean;
  readonly error: { readonly status: 'failed' | 'unknown'; readonly message: string } | null;
};

export async function listCurrentSlotFacts(tx: ReadTransaction, query: CurrentSlotQuery): Promise<readonly CurrentSlotFactRow[]> {
  const { rows } = await tx.query<CurrentSlotFactRow>(
    `SELECT f.id, d.value, d.id AS "derivationId", d.manifest,
       (s.last_id IS NOT NULL OR s.last_error IS NOT NULL) AS settled, s.last_error AS error
     FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     LEFT JOIN slot_state s ON (s.learner_id,s.slot_type,s.slot_key)=(f.learner_id,$3,f.id)
     LEFT JOIN derivations d ON (d.learner_id,d.id)=(s.learner_id,s.current_id)
     WHERE f.learner_id=$1 AND f.type=$2 AND ($4::text IS NULL OR r.data->>$4=$5)
     ORDER BY f.created_tick${query.newestFirst ? ' DESC' : ''} LIMIT $6`,
    [tx.learner, query.factType, query.slotType, query.keyField ?? null, query.keyValue ?? null, query.limit ?? 100],
  );
  return rows;
}
