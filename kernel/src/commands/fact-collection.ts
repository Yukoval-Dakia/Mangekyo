import type { ReadTransaction } from '../db/types.ts';
import { factId, type FactId, type Revision } from '../declarations/ids.ts';
import type { FactSnapshot, ReadContext } from '../declarations/types.ts';
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
// the supplied reader so gather records the actual pinned or following dependency.
export async function* readFactCollection(
  tx: ReadTransaction,
  read: Pick<ReadContext, 'fact'>,
  types: readonly string[],
  options: { newestFirst?: boolean; pinTypes?: readonly string[] } = {},
) {
  const order = options.newestFirst ? 'created_tick DESC, id DESC' : 'created_tick, id';
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
