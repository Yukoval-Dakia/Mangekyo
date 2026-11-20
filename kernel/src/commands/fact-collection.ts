import type { ReadTransaction } from '../db/types.ts';
import { factId, type FactId, type Revision } from '../declarations/ids.ts';
import type { ReadContext } from '../declarations/types.ts';
import { FactNotFoundError, FactReadDeniedError } from './reads.ts';

export async function readable<T>(open: () => Promise<T>) {
  try {
    return await open();
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return undefined;
    throw error;
  }
}

// Enumerate identities in the caller's snapshot. Every returned value goes through
// the supplied reader, preserving its access checks and dependency tracking.
export async function* readFactCollection(
  tx: ReadTransaction,
  read: Pick<ReadContext, 'fact'>,
  types: readonly string[],
  options: { newestFirst?: boolean; idAscending?: boolean } = {},
) {
  const order = options.newestFirst
    ? options.idAscending ? 'created_tick DESC, id' : 'created_tick DESC, id DESC'
    : 'created_tick, id';
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM facts
     WHERE learner_id=$1 AND type=ANY($2::text[]) AND retracted_rev IS NULL ORDER BY ${order}`,
    [tx.learner, types],
  );
  for (const row of rows) {
    const id = factId(row.id);
    const value = await readable(() => read.fact(id, { mode: 'following' }));
    if (value) yield value;
  }
}

export async function revisionsOnlyChangeGrants(tx: ReadTransaction, id: FactId, before: Revision, after: Revision) {
  // Each adjacent revision must be a grant change, including an edit later restored to the same value.
  const { rows: [proof] } = await tx.query<{ unchanged: boolean }>(
    `SELECT count(*) FILTER (WHERE r.kind='value' AND r.data=base.data AND r.corrects_rev=p.rev
        AND r.purpose IS DISTINCT FROM p.purpose)=($4::int-$3::int) AS unchanged
     FROM fact_revs base JOIN fact_revs r ON (r.learner_id,r.fact_id)=(base.learner_id,base.fact_id)
     JOIN fact_revs p ON (p.learner_id,p.fact_id,p.rev)=(r.learner_id,r.fact_id,r.rev-1)
     WHERE base.learner_id=$1 AND base.fact_id=$2 AND base.rev=$3 AND base.kind='value' AND r.rev>$3 AND r.rev<=$4`,
    [tx.learner, id, before, after],
  );
  return proof?.unchanged === true;
}
