import { lockLearner } from '../db/learner.ts';
import type { Db, DbQuery, DbTransaction, ReadTransaction } from '../db/types.ts';
import { learnerId, type Tick } from '../declarations/ids.ts';
import { newUlid } from './identity.ts';

export type { EffectRequest, EffectResult } from './effects.ts';
export { runEffect } from './effects.ts';

export type WorkRef = {
  readonly learner: string;
  readonly workId: string;
  readonly generation: string;
};

export type WorkRequest = {
  readonly slotType: string;
  readonly slotKey: string;
  readonly deriver: string;
};
type CurrentWork = {
  id: string;
  generation: string;
  deriver: string;
  state: string;
  requested_tick: string;
};

/** Register demand with the caller's existing learner write lock and tick. */
export async function requestWork(tx: DbTransaction, tick: Tick, request: WorkRequest): Promise<WorkRef> {
  const { slotType, slotKey, deriver } = request;
  const { rows: [current] } = await tx.query<CurrentWork>(
    `SELECT id, generation::text, deriver, state, requested_tick::text FROM work
     WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3`,
    [tx.learner, slotType, slotKey],
  );
  if (current?.state === 'ready' && current.requested_tick === tick && current.deriver === deriver) {
    return { learner: tx.learner, workId: current.id, generation: current.generation };
  }

  const workId = current?.id ?? newUlid();
  const generation = current ? (BigInt(current.generation) + 1n).toString() : '1';
  const executionRef = newUlid();
  if (current) {
    await tx.query(
      `UPDATE work SET deriver = $3, state = 'ready', generation = $4, requested_tick = $5,
         execution_ref = $6, gather = NULL, gather_manifest = NULL
       WHERE learner_id = $1 AND id = $2`,
      [tx.learner, workId, deriver, generation, tick, executionRef],
    );
    await clearWaits(tx, workId);
  } else {
    await tx.insert('work', {
      learner_id: tx.learner,
      id: workId,
      slot_type: slotType,
      slot_key: slotKey,
      deriver,
      state: 'ready',
      generation,
      requested_tick: tick,
      execution_ref: executionRef,
    });
  }
  await setPending(tx, { slotType, slotKey }, 'queued');
  await tx.insert('work_outbox', {
    learner_id: tx.learner,
    intent_id: executionRef,
    work_id: workId,
    generation,
    state: 'pending',
  });
  return { learner: tx.learner, workId, generation };
}

function clearWaits(tx: DbTransaction, workId: string) {
  return tx.query('DELETE FROM work_waits WHERE learner_id = $1 AND work_id = $2', [tx.learner, workId]);
}

function setPending(
  tx: DbTransaction,
  slot: Pick<WorkRequest, 'slotType' | 'slotKey'>,
  pending: 'queued' | 'none',
  changedTick: Tick | null = null,
) {
  return tx.query(
    `UPDATE slot_state SET pending = $4, changed_tick = COALESCE($5::bigint, changed_tick)
     WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3`,
    [tx.learner, slot.slotType, slot.slotKey, pending, changedTick],
  );
}

// Retain outbox identities across generations. Only a current ready generation may be started.
const currentIntent = `FROM work_outbox o JOIN work w
  ON w.learner_id = o.learner_id AND w.id = o.work_id AND w.generation = o.generation
  AND w.execution_ref = o.intent_id AND w.state = 'ready'`;
const intentRef = 'SELECT o.learner_id AS learner, o.work_id AS "workId", o.generation::text';

async function currentPendingIntent(db: DbQuery, executionRef: string): Promise<WorkRef | null> {
  const { rows: [ref] } = await db.query<WorkRef>(
    `${intentRef} ${currentIntent} WHERE o.intent_id = $1 AND o.state = 'pending'`,
    [executionRef],
  );
  return ref ?? null;
}

function markDelivered(tx: DbTransaction, ref: WorkRef, executionRef: string) {
  return tx.query(
    `UPDATE work_outbox SET state = 'delivered'
     WHERE learner_id = $1 AND intent_id = $2 AND work_id = $3 AND generation = $4 AND state = 'pending'`,
    [tx.learner, executionRef, ref.workId, ref.generation],
  );
}

/** Resolve the Activity's opaque identity and durably acknowledge its first start before doing work. */
export async function acknowledgeStartedWork(db: Db, executionRef: string): Promise<WorkRef | null> {
  const { rows: [owner] } = await db.query<{ learner: string }>(
    'SELECT learner_id AS learner FROM work_outbox WHERE intent_id = $1',
    [executionRef],
  );
  if (!owner) return null;
  const learner = learnerId(owner.learner);
  return db.tx({ learner }, async tx => {
    await lockLearner(tx, learner);
    const { rows: [ref] } = await tx.query<WorkRef>(
      `${intentRef} ${currentIntent} WHERE o.learner_id = $1 AND o.intent_id = $2`,
      [learner, executionRef],
    );
    if (!ref) return null;
    await markDelivered(tx, ref, executionRef);
    return ref;
  });
}

/** Start with a stable executionRef. The receiver treats an existing workflow as successful delivery. */
export async function relayPending(
  db: Db,
  start: (ref: WorkRef, executionRef: string) => Promise<void>,
): Promise<number> {
  const { rows: [last] } = await db.query<{ intent_id: string }>(
    "SELECT intent_id FROM work_outbox WHERE state = 'pending' ORDER BY intent_id DESC LIMIT 1",
  );
  if (!last) return 0;

  let cursor = '';
  let delivered = 0;
  const errors: unknown[] = [];
  for (;;) {
    const { rows } = await db.query<{ intent_id: string }>(
      `SELECT o.intent_id ${currentIntent} WHERE o.state = 'pending' AND o.intent_id > $1 AND o.intent_id <= $2
       ORDER BY o.intent_id LIMIT 100`,
      [cursor, last.intent_id],
    );
    if (rows.length === 0) break;

    for (const { intent_id: executionRef } of rows) {
      cursor = executionRef;
      try {
        const ref = await currentPendingIntent(db, executionRef);
        if (!ref) continue;
        await start(ref, executionRef);
        const result = await db.tx({ learner: learnerId(ref.learner) }, async tx => {
          await lockLearner(tx, tx.learner);
          return markDelivered(tx, ref, executionRef);
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

async function readCurrentWork(
  tx: ReadTransaction,
  ref: WorkRef,
  states: readonly ('ready' | 'waiting')[],
): Promise<WorkRequest | null> {
  if (tx.learner !== ref.learner) return null;
  const { rows: [row] } = await tx.query<WorkRequest>(
    `SELECT slot_type AS "slotType", slot_key AS "slotKey", deriver
     FROM work WHERE learner_id = $1 AND id = $2 AND generation = $3 AND state = ANY($4::text[])`,
    [tx.learner, ref.workId, ref.generation, states],
  );
  return row ?? null;
}

/** Check execution eligibility within the caller's transaction. */
export function readReadyWork(tx: ReadTransaction, ref: WorkRef): Promise<WorkRequest | null> {
  return readCurrentWork(tx, ref, ['ready']);
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
    if (!work) return false;
    return tx.withLearnerWrite(async tick => {
      await tx.query(
        `UPDATE work SET state = $4, gather = NULL, gather_manifest = NULL
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

export function cancelWork(db: Db, ref: WorkRef): Promise<boolean> {
  return closeWork(db, ref, 'cancelled');
}
