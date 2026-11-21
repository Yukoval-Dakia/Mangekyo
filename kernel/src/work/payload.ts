import type { DbTransaction, ReadTransaction } from '../db/types.ts';
import type { FactId } from '../declarations/ids.ts';
import { assertUnburned } from '../lifecycle.ts';
import { lockLearner } from '../db/learner.ts';
import type { WorkRef } from './demand.ts';

import type { WorkPublication } from './payload-contract.ts';

/** Reopen inputs in this transaction before binding and keep it open until binding commits. */
export async function bindWorkPayload(tx: DbTransaction, ref: WorkRef, ids: readonly FactId[], publication: WorkPublication) {
  const sources = [...new Set(ids)].sort();
  if (!sources.length || ref.learner !== tx.learner) throw new Error('Invalid work payload inputs');
  await lockLearner(tx, tx.learner);
  await assertUnburned(tx, 'fact', sources);
  if (!await publicationAvailable(tx, publication)) return false;
  const {rows:[work]} = await tx.query<{ bound: boolean; matches: boolean }>(`SELECT
    publication_fact_id IS NOT NULL AS bound,
    (payload_sources IS NULL OR payload_sources=$4::text[]) AND
    (publication_fact_id IS NULL OR (publication_fact_id,publication_command_id)=($5,$6)) AS matches
    FROM work WHERE learner_id=$1 AND id=$2 AND generation=$3 AND family='todo' AND state='ready'`,
  [tx.learner,ref.workId,ref.generation,sources,publication.factId,publication.commandId]);
  if (!work?.matches) return false;
  if (!work.bound) await tx.withLearnerWrite(() => tx.query(`UPDATE work
    SET payload_sources=$4,publication_fact_id=$5,publication_command_id=$6
    WHERE learner_id=$1 AND id=$2 AND generation=$3`,
  [tx.learner,ref.workId,ref.generation,sources,publication.factId,publication.commandId]));
  return true;
}

async function publicationAvailable(tx: ReadTransaction, publication: WorkPublication) {
  const {rowCount} = await tx.query(`SELECT 1 FROM facts WHERE learner_id=$1 AND id=$2
    UNION ALL SELECT 1 FROM commands WHERE learner_id=$1 AND id=$3
    UNION ALL SELECT 1 FROM tombstones WHERE learner_id=$1 AND
      ((kind='fact' AND id=$2) OR (kind='command' AND id=$3)) LIMIT 1`,
  [tx.learner,publication.factId,publication.commandId]);
  return !rowCount;
}

export async function resolveWorkPublication(tx: ReadTransaction, first: FactId,
  identify: (id: FactId) => WorkPublication, successor: (id: FactId, generation: string) => FactId) {
  let id = first;
  for (;;) {
    const publication = identify(id);
    const {rows:[row]} = await tx.query<{generation: string}>(`SELECT generation::text FROM tombstones
      WHERE learner_id=$1 AND ((kind='fact' AND id=$2) OR (kind='command' AND id=$3))
      ORDER BY tombstones.generation DESC LIMIT 1`, [tx.learner,publication.factId,publication.commandId]);
    if (!row) return publication;
    id = successor(id, row.generation);
  }
}

export async function assertPayloadWork(tx: ReadTransaction, work: WorkRef) {
  if (tx.learner !== work.learner) throw new Error('Work payload learner mismatch');
  const {rows:[publication]} = await tx.query<WorkPublication>(`SELECT publication_fact_id AS "factId",
    publication_command_id AS "commandId" FROM work WHERE learner_id=$1 AND id=$2
    AND generation=$3 AND state='ready' AND publication_fact_id IS NOT NULL`,
  [tx.learner,work.workId,work.generation]);
  if (!publication || !await publicationAvailable(tx, publication)) throw new Error('Work payload is no longer active');
}
