import { lockLearner } from '../db/learner.ts';
import type { DbTransaction } from '../db/types.ts';
import type { Tick } from '../declarations/ids.ts';
import type { SlotRef } from '../declarations/types.ts';
import type { WaitWitness } from '../derivations/gather.ts';
import { clearWaits, readReadyWork, setPending, writeReadyGeneration, type WorkRef, type WorkRequest } from './demand.ts';

const terminalStates = ['denied', 'unavailable', 'blocked'] as const;
export type WaitTerminalState = typeof terminalStates[number];
export type WaitTransition = { readonly kind: 'ready' | WaitTerminalState; readonly ref: WorkRef };
export type WaitRegistration = { readonly kind: 'obsolete' } | { readonly kind: 'waiting' } | WaitTransition;

type TargetWitness = { slotType: string; slotKey: string; changedTick: string };
type WaitDecision = WaitTransition['kind'] | 'waiting';

async function checkTargets(tx: DbTransaction, witnesses: readonly TargetWitness[]): Promise<WaitDecision> {
  const { rows } = await tx.query<{ terminal: string | null; ready: boolean }>(
    `SELECT CASE
         WHEN s.last_error->>'status' IN ('denied', 'unavailable') THEN s.last_error->>'status'
         WHEN s.current_id IS NULL AND w.state IN ('denied', 'unavailable', 'blocked') THEN w.state
         WHEN s.current_id IS NULL AND s.last_error->>'status' = 'blocked' THEN 'blocked'
       END AS terminal,
       s.current_id IS NOT NULL OR COALESCE(s.changed_tick, 0) <> observed.tick AS ready
     FROM unnest($2::text[], $3::text[], $4::bigint[]) AS observed(type, key, tick)
     LEFT JOIN slot_state s ON s.learner_id = $1 AND s.slot_type = observed.type AND s.slot_key = observed.key
     LEFT JOIN work w ON w.learner_id = s.learner_id AND w.slot_type = s.slot_type AND w.slot_key = s.slot_key`,
    [tx.learner, witnesses.map(w => w.slotType), witnesses.map(w => w.slotKey), witnesses.map(w => w.changedTick)],
  );
  return terminalStates.find(kind => rows.some(row => row.terminal === kind))
    ?? (rows.some(row => row.ready) ? 'ready' : 'waiting');
}

async function setWaitState(
  tx: DbTransaction,
  ref: WorkRef,
  work: WorkRequest,
  state: 'waiting' | WaitTerminalState,
) {
  await tx.query(
    `UPDATE work SET state = $4, gather = NULL, gather_manifest = NULL
     WHERE learner_id = $1 AND id = $2 AND generation = $3`,
    [tx.learner, ref.workId, ref.generation, state],
  );
  await setPending(tx, work, state === 'waiting' ? 'waiting' : 'none');
}

async function transition(
  tx: DbTransaction,
  tick: Tick,
  ref: WorkRef,
  work: WorkRequest,
  kind: WaitTransition['kind'],
): Promise<WaitTransition> {
  if (kind === 'ready') {
    const next = await writeReadyGeneration(tx, tick, work, { id: ref.workId, generation: ref.generation });
    return { kind, ref: next };
  }
  await clearWaits(tx, ref.workId);
  await setWaitState(tx, ref, work, kind);
  return { kind, ref };
}

/** After the gather snapshot closes, register its slot witnesses in a new write transaction.
 * This acquires the learner lock without advancing the clock. A retry gets a fresh execution.
 */
export async function registerWorkWait(
  tx: DbTransaction,
  ref: WorkRef,
  witnesses: readonly WaitWitness[],
): Promise<WaitRegistration> {
  if (tx.learner !== ref.learner) return { kind: 'obsolete' };
  await lockLearner(tx, tx.learner);
  const work = await readReadyWork(tx, ref);
  if (!work) return { kind: 'obsolete' };
  if (witnesses.length === 0 || witnesses.some(witness => witness.ref.learner !== tx.learner)) {
    throw new Error('Work wait requires slot witnesses for the transaction learner');
  }

  const targets = witnesses.map(({ ref: slot, changedTick }) => ({ slotType: slot.type, slotKey: slot.key, changedTick }));
  const decision = await checkTargets(tx, targets);
  if (decision === 'waiting') {
    await clearWaits(tx, ref.workId);
    await tx.query(
      `INSERT INTO work_waits (learner_id, work_id, slot_type, slot_key, observed_change_tick)
       SELECT DISTINCT $1::text, $2::text, type, key, tick
       FROM unnest($3::text[], $4::text[], $5::bigint[]) AS observed(type, key, tick)`,
      [tx.learner, ref.workId, targets.map(w => w.slotType), targets.map(w => w.slotKey), targets.map(w => w.changedTick)],
    );
    await setWaitState(tx, ref, work, 'waiting');
    return { kind: 'waiting' };
  }

  const { rows: [clock] } = await tx.query<{ tick: Tick }>(
    'SELECT clock::text AS tick FROM learners WHERE id = $1',
    [tx.learner],
  );
  const result = await transition(tx, clock!.tick, ref, work, decision);
  if (decision !== 'ready') {
    await wakeWaitingWork(tx, clock!.tick, { learner: tx.learner, type: work.slotType, key: work.slotKey });
  }
  return result;
}

/** With the caller's learner write lock and tick, reconcile waiters after persisting
 * the target's current_id, changed_tick and availability. The slot owner records explicit
 * terminal states as last_error.status = 'blocked' | 'unavailable' | 'denied'
 * and clears that status when the target recovers. A missing value with a terminal
 * producer is also terminal. Other error metadata can describe a retryable missing value.
 */
export async function wakeWaitingWork(tx: DbTransaction, tick: Tick, target: SlotRef): Promise<readonly WaitTransition[]> {
  if (target.learner !== tx.learner) throw new Error('Wake target learner does not match transaction');
  const transitions: WaitTransition[] = [];
  const changedTargets = [target];
  for (const changed of changedTargets) {
    const { rows: waiters } = await tx.query<WorkRequest & WorkRef>(
      `SELECT w.learner_id AS learner, w.id AS "workId", w.generation::text,
         w.slot_type AS "slotType", w.slot_key AS "slotKey", w.deriver
       FROM work_waits x JOIN work w ON w.learner_id = x.learner_id AND w.id = x.work_id
       WHERE x.learner_id = $1 AND x.slot_type = $2 AND x.slot_key = $3 AND w.state = 'waiting'`,
      [tx.learner, changed.type, changed.key],
    );
    for (const waiter of waiters) {
      const { rows: witnesses } = await tx.query<TargetWitness>(
        `SELECT slot_type AS "slotType", slot_key AS "slotKey", observed_change_tick::text AS "changedTick"
         FROM work_waits WHERE learner_id = $1 AND work_id = $2`,
        [tx.learner, waiter.workId],
      );
      const decision = await checkTargets(tx, witnesses);
      if (decision === 'waiting') continue;
      const ref = { learner: waiter.learner, workId: waiter.workId, generation: waiter.generation };
      transitions.push(await transition(tx, tick, ref, waiter, decision));
      if (decision !== 'ready') {
        changedTargets.push({ learner: tx.learner, type: waiter.slotType, key: waiter.slotKey });
      }
    }
  }
  return transitions;
}
