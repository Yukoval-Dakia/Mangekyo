import type { DbTransaction, ReadTransaction } from '../db/types.ts';
import { clearWaits, setPending, writeReadyGeneration, type WorkRequest } from './demand.ts';

type Route = Pick<WorkRequest, 'slotType' | 'deriver'>;
type Recovery = Route & { code: string; migrateDefaultLane?: boolean };
type RecoverableWork = { id: string; generation: string; slotKey: string };

/** The default lane is included only for a caller migrating an older route. */
export async function readRoutedWorkForRecovery(
  tx: ReadTransaction, recovery: Recovery,
) {
  return (await tx.query<RecoverableWork>(
    `SELECT w.id,w.generation::text,w.slot_key AS "slotKey" FROM work w
     JOIN slot_state s USING (learner_id,slot_type,slot_key)
     JOIN work_outbox o ON (o.learner_id,o.work_id,o.generation,o.intent_id) =
       (w.learner_id,w.id,w.generation,w.execution_ref)
     WHERE w.learner_id=$1 AND w.slot_type=$2 AND w.deriver=$3
       AND ((w.state='blocked' AND o.state='routed_delivered' AND s.last_error->>'code'=$4)
         OR ($5 AND ((w.state='ready' AND o.state IN ('pending','delivered'))
           OR (w.state='blocked' AND o.state='delivered' AND s.last_error->>'status'='failed'))))`,
    [tx.learner,recovery.slotType,recovery.deriver,recovery.code,recovery.migrateDefaultLane ?? false],
  )).rows;
}

/** Revalidate and transition under the caller's learner lock, atomically with the confirming write. */
export async function reconcileRoutedWork(
  tx: DbTransaction, recovery: Recovery,
  decide: (slotKey: string) => Promise<'retry' | 'cancel' | undefined>,
) {
  const changes: {current: RecoverableWork; action: 'retry' | 'cancel'}[] = [];
  for (const current of await readRoutedWorkForRecovery(tx,recovery)) {
    const action = await decide(current.slotKey);
    if (action) changes.push({current,action});
  }
  if (!changes.length) return;
  await tx.withLearnerWrite(async tick => {
    for (const {current,action} of changes) {
      const request = {slotType:recovery.slotType,deriver:recovery.deriver,slotKey:current.slotKey};
      await tx.query(
        'UPDATE slot_state SET last_error=NULL WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
        [tx.learner,request.slotType,request.slotKey],
      );
      if (action === 'retry') await writeReadyGeneration(tx,tick,request,current,'routed_pending');
      else {
        await tx.query(
          `UPDATE work SET state='cancelled',gather=NULL,gather_manifest=NULL
           WHERE learner_id=$1 AND id=$2 AND generation=$3`, [tx.learner,current.id,current.generation],
        );
        await clearWaits(tx,current.id);
        await setPending(tx,request,'none',tick);
      }
    }
  });
}
