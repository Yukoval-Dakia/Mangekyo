import type { ReadTransaction } from '../db/types.ts';
import { factId, type FactId, type Revision } from '../declarations/ids.ts';
import type { FactSnapshot, ReadContext } from '../declarations/types.ts';
import { isFactNotFound, isFactReadDenied } from './errors.ts';

export async function readable<T>(open: () => Promise<T>) {
  try { return await open(); } catch (error) {
    if (isFactNotFound(error) || isFactReadDenied(error)) return undefined;
    throw error;
  }
}

export async function readFactType(tx: ReadTransaction, id: FactId): Promise<string | null> {
  const { rows: [fact] } = await tx.query<{ type: string }>(
    'SELECT type FROM facts WHERE learner_id=$1 AND id=$2',
    [tx.learner, id],
  );
  return fact?.type ?? null;
}

// Enumerate identities in the caller's snapshot. Every returned value goes through
// the supplied reader so gather records the actual pinned or following dependency.
export async function* readFactCollection(
  tx: ReadTransaction,
  read: Pick<ReadContext, 'fact'>,
  types: readonly string[],
  options: { newestFirst?: boolean; idAscending?: boolean; pinTypes?: readonly string[] } = {},
) {
  const order = options.newestFirst
    ? options.idAscending ? 'created_tick DESC, id' : 'created_tick DESC, id DESC'
    : 'created_tick, id';
  const { rows } = await tx.query<{ id: string; type: string; current_rev: Revision }>(
    `SELECT id,type,current_rev FROM facts
     WHERE learner_id=$1 AND type=ANY($2::text[]) AND retracted_rev IS NULL ORDER BY ${order}`,
    [tx.learner, types],
  );
  for (const row of rows) {
    const id = factId(row.id);
    const value = await readable(() => options.pinTypes?.includes(row.type)
      ? read.fact(id, { mode: 'pinned', rev: row.current_rev })
      : read.fact(id, { mode: 'following' }));
    if (value) yield value;
  }
}

export async function readValueRevisions(tx: ReadTransaction, read: Pick<ReadContext, 'fact'>, id: FactId) {
  const { rows } = await tx.query<{ rev: Revision }>(
    "SELECT rev FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND kind='value' ORDER BY rev",
    [tx.learner, id],
  );
  const versions: FactSnapshot[] = [];
  for (const { rev } of rows) {
    const value = await readable(() => read.fact(id, { mode: 'pinned', rev }));
    if (value) versions.push(value);
  }
  return versions;
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
