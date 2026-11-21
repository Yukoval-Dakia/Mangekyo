import type { DbTransaction, ReadTransaction } from '../db/types.ts';
import type { Tick } from '../declarations/ids.ts';
import { newUlid } from './identity.ts';

export const todoSlot = 'working.todo';

export type WorkRef = {
  readonly learner: string;
  readonly workId: string;
  readonly generation: string;
};

export type OutboxPendingState = 'pending' | 'capability_pending' | 'routed_pending';

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
export async function requestWork(tx: DbTransaction, tick: Tick, request: WorkRequest, pendingState?: OutboxPendingState): Promise<WorkRef> {
  const { slotType, slotKey, deriver } = request;
  if (slotType === todoSlot) throw new Error('Register working.todo through emitTodo');
  const { rows: [current] } = await tx.query<CurrentWork>(
    `SELECT id, generation::text, deriver, state, requested_tick::text FROM work
     WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3`,
    [tx.learner, slotType, slotKey],
  );
  if (current?.state === 'ready' && current.requested_tick === tick && current.deriver === deriver) {
    return { learner: tx.learner, workId: current.id, generation: current.generation };
  }

  return writeReadyGeneration(tx, tick, request, current, pendingState);
}

/** Create the catalog entry and enqueue demand in the caller's learner write. */
export async function requestCatalogedWork(
  tx: DbTransaction, tick: Tick, request: WorkRequest, scope: string,
  options: { reuseSlot?: true } = {},
): Promise<void> {
  const inserted = await tx.query(
    `INSERT INTO slot_state (learner_id,slot_type,slot_key,scope_keys,changed_tick)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [tx.learner, request.slotType, request.slotKey, scope, tick],
  );
  if (inserted.rowCount || options.reuseSlot) await requestWork(tx, tick, request);
}

/** Enqueue a new execution after the caller has fenced the prior generation under the learner lock. */
export async function writeReadyGeneration(
  tx: DbTransaction,
  tick: Tick,
  request: WorkRequest,
  current: Pick<CurrentWork, 'id' | 'generation'> | undefined,
  pendingState?: OutboxPendingState,
): Promise<WorkRef> {
  const { slotType, slotKey, deriver } = request;
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
  return enqueueGeneration(tx, request, { learner: tx.learner, workId, generation }, executionRef, pendingState);
}

export async function enqueueGeneration(tx: DbTransaction, slot: Pick<WorkRequest, 'slotType' | 'slotKey'>, ref: WorkRef, executionRef: string, pendingState: OutboxPendingState = 'pending') {
  const { slotType, slotKey } = slot;
  const { workId, generation } = ref;
  await tx.query(
    `UPDATE slot_state SET pending = 'queued',
        last_error = CASE WHEN last_error->>'status' = 'blocked' THEN NULL ELSE last_error END
     WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3`,
    [tx.learner, slotType, slotKey],
  );
  await tx.insert('work_outbox', {
    learner_id: tx.learner,
    intent_id: executionRef,
    work_id: workId,
    generation,
    state: pendingState,
  });
  return ref;
}

export function clearWaits(tx: DbTransaction, workId: string) {
  return tx.query('DELETE FROM work_waits WHERE learner_id = $1 AND work_id = $2', [tx.learner, workId]);
}

export function setPending(
  tx: DbTransaction,
  slot: Pick<WorkRequest, 'slotType' | 'slotKey'>,
  pending: 'queued' | 'waiting' | 'none',
  changedTick: Tick | null = null,
) {
  return tx.query(
    `UPDATE slot_state SET pending = $4, changed_tick = COALESCE($5::bigint, changed_tick)
     WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3`,
    [tx.learner, slot.slotType, slot.slotKey, pending, changedTick],
  );
}

export async function readCurrentWork(
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
