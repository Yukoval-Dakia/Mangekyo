import type { FactId, Revision, Tick } from '../declarations/ids.ts';
import type { ReadTransaction } from '../db/types.ts';

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

/** Tick the fact was first recorded at the given rev (rev=1 is "birth"). */
export async function readFactBirthTick(tx: ReadTransaction, id: FactId, rev: Revision = 1 as Revision) {
  const { rows: [row] } = await tx.query<{ tick: string | bigint | number }>(
    `SELECT tick FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=$3`,
    [tx.learner, id, rev],
  );
  return row === undefined ? undefined : (String(row.tick) as Tick);
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
  readonly slotType: string; readonly slotKey: string; readonly id: string;
  /** When true, the slot's current pointer must still reference this derivation. */
  readonly requireCurrent?: boolean;
};

export type EffectiveDerivationRow = { readonly value: unknown; readonly manifest: unknown };

/** Read a settled derivation row that is still effective (or superseded). */
export async function readEffectiveDerivation(tx: ReadTransaction, q: EffectiveDerivationQuery) {
  const { rows: [row] } = await tx.query<EffectiveDerivationRow>(
    `SELECT d.value, d.manifest FROM derivations d
     WHERE d.learner_id=$1 AND d.slot_type=$2 AND d.slot_key=$3 AND d.id=$4
       AND NOT d.is_shadow AND d.invalidated_tick IS NULL AND d.effective_tick IS NOT NULL
       AND d.lifecycle IN ('effective','superseded')
       AND (NOT $5::boolean OR (d.lifecycle='effective' AND EXISTS (
         SELECT 1 FROM slot_state s WHERE s.learner_id=d.learner_id
           AND s.slot_type=d.slot_type AND s.slot_key=d.slot_key
           AND s.current_id=d.id AND s.last_error IS NULL)))`,
    [tx.learner, q.slotType, q.slotKey, q.id, q.requireCurrent ?? false],
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
