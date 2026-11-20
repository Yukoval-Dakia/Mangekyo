import { lockLearner } from '../db/learner.ts';
import type { Db, DbQuery, DbTransaction } from '../db/types.ts';
import { learnerId, type Tick } from '../declarations/ids.ts';
import { clearWaits, readCurrentWork, readReadyWork, setPending, todoSlot, type OutboxPendingState, type WorkRef, type WorkRequest } from './demand.ts';

export type { WorkRef, WorkRequest } from './demand.ts';
export { readReadyWork, requestWork } from './demand.ts';
export type { WaitRegistration, WaitTransition, WaitTerminalState } from './wait.ts';
export { registerWorkWait, wakeWaitingWork } from './wait.ts';

export type { EffectRequest, EffectResult } from './effects.ts';
export { runEffect } from './effects.ts';

// Retain outbox identities across generations. Only a current ready generation may be started.
const currentIntent = `FROM work_outbox o JOIN work w
  ON w.learner_id = o.learner_id AND w.id = o.work_id AND w.generation = o.generation
  AND w.execution_ref = o.intent_id AND w.state = 'ready'`;
const intentRef = 'SELECT o.learner_id AS learner, o.work_id AS "workId", o.generation::text';

async function currentPendingIntent(db: DbQuery, executionRef: string, pendingState: OutboxPendingState): Promise<WorkRef | null> {
  const { rows: [ref] } = await db.query<WorkRef>(
    `${intentRef} ${currentIntent} WHERE o.intent_id = $1 AND o.state = $2`,
    [executionRef,pendingState],
  );
  return ref ?? null;
}

function markDelivered(tx: DbTransaction, ref: WorkRef, executionRef: string, pendingState: OutboxPendingState) {
  return tx.query(
    `UPDATE work_outbox SET state = 'delivered'
     WHERE learner_id = $1 AND intent_id = $2 AND work_id = $3 AND generation = $4 AND state = $5`,
    [tx.learner, executionRef, ref.workId, ref.generation, pendingState],
  );
}

/** Resolve the Activity's opaque identity and durably acknowledge its first start before doing work. */
export async function acknowledgeStartedWork(db: Db, executionRef: string, pendingState: OutboxPendingState = 'pending'): Promise<WorkRef | null> {
  const { rows: [owner] } = await db.query<{ learner: string }>(
    'SELECT learner_id AS learner FROM work_outbox WHERE intent_id = $1',
    [executionRef],
  );
  if (!owner) return null;
  const learner = learnerId(owner.learner);
  return db.tx({ learner }, async tx => {
    await lockLearner(tx, learner);
    const { rows: [ref] } = await tx.query<WorkRef>(
      `${intentRef} ${currentIntent} WHERE o.learner_id = $1 AND o.intent_id = $2 AND o.state IN ($3,'delivered')`,
      [learner, executionRef, pendingState],
    );
    if (!ref) return null;
    await markDelivered(tx, ref, executionRef, pendingState);
    return ref;
  });
}

/** Start with a stable executionRef. The receiver treats an existing workflow as successful delivery. */
export async function relayPending(
  db: Db,
  start: (ref: WorkRef, executionRef: string) => Promise<void>,
  pendingState: OutboxPendingState = 'pending',
): Promise<number> {
  const { rows: [last] } = await db.query<{ intent_id: string }>(
    'SELECT intent_id FROM work_outbox WHERE state = $1 ORDER BY intent_id DESC LIMIT 1', [pendingState],
  );
  if (!last) return 0;

  let cursor = '';
  let priority = -1;
  let delivered = 0;
  const errors: unknown[] = [];
  for (;;) {
    const { rows } = await db.query<{ intent_id: string; priority: number }>(
      `SELECT o.intent_id, w.priority ${currentIntent}
       WHERE o.state = $4 AND (w.priority, o.intent_id) > ($3, $1) AND o.intent_id <= $2
       ORDER BY w.priority, o.intent_id LIMIT 100`,
      [cursor, last.intent_id, priority, pendingState],
    );
    if (rows.length === 0) break;

    for (const { intent_id: executionRef, priority: currentPriority } of rows) {
      cursor = executionRef;
      priority = currentPriority;
      try {
        const ref = await currentPendingIntent(db, executionRef, pendingState);
        if (!ref) continue;
        await start(ref, executionRef);
        const result = await db.tx({ learner: learnerId(ref.learner) }, async tx => {
          await lockLearner(tx, tx.learner);
          return markDelivered(tx, ref, executionRef, pendingState);
        });
        delivered += result.rowCount;
      } catch (error) {
        if (!errors.length) errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Work outbox delivery failed');
  return delivered;
}

/** Resolve current generation data in PG, outside workflow history. */
export function readWork(db: Db, ref: WorkRef): Promise<WorkRequest | null> {
  return db.snapshot({ learner: learnerId(ref.learner) }, tx => readReadyWork(tx, ref));
}

export type WorkAcceptance = (tx: DbTransaction, tick: Tick) => Promise<void> | void;

async function closeWork(
  db: Db,
  ref: WorkRef,
  state: 'satisfied' | 'cancelled' | 'blocked',
  accept?: WorkAcceptance,
): Promise<boolean> {
  const learner = learnerId(ref.learner);
  return db.tx({ learner }, async tx => {
    await lockLearner(tx, learner);
    const work = await readCurrentWork(tx, ref, state === 'cancelled' ? ['ready', 'waiting'] : ['ready']);
    // Todo publication records the result and satisfies the work atomically in completeTodo.
    if (!work || (work.slotType === todoSlot && state === 'satisfied')) return false;
    return tx.withLearnerWrite(async tick => {
      await tx.query(
        `UPDATE work SET state = $4, revision = revision + CASE WHEN family='todo' THEN 1 ELSE 0 END, gather = NULL, gather_manifest = NULL
         WHERE learner_id = $1 AND id = $2 AND generation = $3`,
        [learner, ref.workId, ref.generation, state],
      );
      await clearWaits(tx, ref.workId);
      await setPending(tx, work, 'none', state === 'blocked' ? tick : null);
      await accept?.(tx, tick);
      return true;
    });
  });
}

/** Commit acceptance and completion together, while the generation is still current. */
export function finishWork(db: Db, ref: WorkRef, accept?: WorkAcceptance): Promise<boolean> {
  return closeWork(db, ref, 'satisfied', accept);
}

export function failWork(db: Db, ref: WorkRef, recordFailure?: WorkAcceptance): Promise<boolean> {
  return closeWork(db, ref, 'blocked', recordFailure);
}

export function cancelWork(db: Db, ref: WorkRef, accept?: WorkAcceptance): Promise<boolean> {
  return closeWork(db, ref, 'cancelled', accept);
}
