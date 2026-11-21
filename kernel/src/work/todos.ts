import { z } from 'zod';
import type { DbQuery, DbTransaction, ReadTransaction } from '../db/types.ts';
import { lockLearner } from '../db/learner.ts';
import { factId, type FactId, type Tick } from '../declarations/ids.ts';
import { enqueueGeneration, setPending, requestWork, todoSlot, type WorkRef, type WorkRequest } from './demand.ts';
import { newUlid } from './identity.ts';

export { todoSlot };
export const maxTodoHops = 3;
const id = z.string().transform(factId);
const timestamp = z.number().int().positive().max(8_640_000_000_000_000);
const source = z.object({
  id, revision: z.number().int().positive(), accessEpoch: z.string().regex(/^(0|[1-9][0-9]*)$/),
  anchor: z.string().min(1).max(80).optional(),
}).strict();
const todoEvent = z.object({
  type: z.enum(['on_attempt_submitted', 'on_work_completed']), subject: id,
}).strict();
export type TodoEvent = z.input<typeof todoEvent>;
const trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('immediate') }).strict(),
  z.object({ kind: z.literal('scheduled'), fireAtMs: timestamp }).strict(),
  z.object({ kind: z.literal('event'), event: todoEvent }).strict(),
]);
const todoSpec = z.object({
  dedupKey: z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/),
  trigger,
  workerProfile: z.enum(['heavy_tutor_prep', 'deep_analyst', 'question_author', 'deterministic_compute', 'personalized_extractor']),
  goal: z.string().min(1).max(240),
  refs: z.array(source).max(20),
  sourceFactRev: source,
  autonomyTier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  priority: z.union([z.literal(0), z.literal(1)]).optional(),
  budgetCap: z.number().int().nonnegative(),
  settingsRevision: z.number().int().positive(),
  expiresAtMs: timestamp,
  parentTodoId: id.optional(),
}).strict();
export type TodoInput = z.input<typeof todoSpec>;
export type TodoSpec = z.output<typeof todoSpec>;
type TodoState = 'pending' | 'dispatched' | 'completed' | 'cancelled' | 'failed';
export type Todo = {
  learner: string;
  id: string;
  spec: TodoSpec;
  route: string | null;
  revision: number;
  state: TodoState;
  chainId: string;
  hopCount: number;
  registeredTick: string;
  resultId: string | null;
};
type TodoRoute = { deriver: string; erasureBasis: readonly FactId[]; settingsFactId: FactId };
export type TodoDeferral = { status: 'not_dispatched'; reason: string; retryAtMs: number };
type Eligibility = (spec: TodoSpec, route: string | null) => Promise<boolean | TodoDeferral>;

export async function migrateWorkingState(tx: DbQuery) {
  await tx.query(`CREATE TABLE working_todos (
    learner_id text NOT NULL REFERENCES learners(id),
    todo_id text NOT NULL,
    dedup_key text NOT NULL,
    spec jsonb NOT NULL,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dispatched','completed','cancelled','failed')),
    chain_id text NOT NULL,
    hop_count integer NOT NULL CHECK (hop_count BETWEEN 0 AND ${maxTodoHops}),
    registered_tick bigint NOT NULL,
    result_id text,
    PRIMARY KEY (learner_id, todo_id),
    CHECK ((state = 'completed') = (result_id IS NOT NULL))
  )`);
  await tx.query(`CREATE UNIQUE INDEX working_todos_active ON working_todos (learner_id, dedup_key)
    WHERE state IN ('pending','dispatched')`);
  await tx.query(`CREATE TABLE working_todo_events (
    learner_id text NOT NULL REFERENCES learners(id),
    event_type text NOT NULL,
    subject text NOT NULL,
    seen_tick bigint NOT NULL,
    PRIMARY KEY (learner_id, event_type, subject)
  )`);
  await tx.query(`CREATE TABLE working_todo_watermarks (
    learner_id text PRIMARY KEY REFERENCES learners(id),
    fact_tick bigint NOT NULL
  )`);
}

const todoFamilies = "family IN ('todo','routed_todo')";
const columns = `learner_id AS learner, slot_key AS id, spec, revision,
  CASE WHEN family='routed_todo' THEN deriver END AS route, CASE state
  WHEN 'pending' THEN 'pending' WHEN 'ready' THEN 'dispatched' WHEN 'waiting' THEN 'dispatched'
  WHEN 'satisfied' THEN 'completed' WHEN 'cancelled' THEN 'cancelled' ELSE 'failed' END AS state, chain_id AS "chainId",
  hop_count AS "hopCount", registered_tick::text AS "registeredTick", result_id AS "resultId"`;

function parsed(row: Todo): Todo {
  return { ...row, spec: todoSpec.parse(row.spec) };
}

export async function readTodo(tx: ReadTransaction, id: string) {
  const { rows: [row] } = await tx.query<Todo>(
    `SELECT ${columns} FROM work WHERE ${todoFamilies} AND learner_id = $1 AND slot_key = $2`, [tx.learner, id],
  );
  return row ? parsed(row) : null;
}

export async function rememberTodoUnavailable(tx: DbTransaction, tick: Tick, id: string, reason: string) {
  await tx.query(`UPDATE slot_state SET last_error=$4, changed_tick=$5
    WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3`,
  [tx.learner, todoSlot, id, JSON.stringify({status:'unavailable', reason}), tick]);
}

export async function readLatestTodoUnavailable(tx: ReadTransaction, dedupKey: string, settingsRevision: number) {
  const { rows: [latest] } = await tx.query<{reason:string | null}>(`SELECT CASE
      WHEN w.state='blocked' AND s.last_error->>'status'='unavailable' THEN s.last_error->>'reason' END AS reason
    FROM work w JOIN slot_state s USING (learner_id,slot_type,slot_key)
    WHERE w.learner_id=$1 AND w.slot_type=$2 AND w.family='todo' AND w.dedup_key=$3 AND w.spec->>'settingsRevision'=$4
    ORDER BY w.registered_tick DESC, w.id DESC LIMIT 1`,
  [tx.learner, todoSlot, dedupKey, String(settingsRevision)]);
  return latest?.reason ?? null;
}

export async function enqueueWork(tx: DbTransaction, tick: Tick, work: WorkRequest) {
  await tx.query(
    `INSERT INTO slot_state (learner_id, slot_type, slot_key, scope_keys, changed_tick)
     VALUES ($1, $2, $3, '{}', $4) ON CONFLICT (learner_id, slot_type, slot_key) DO NOTHING`,
    [tx.learner, work.slotType, work.slotKey, tick],
  );
  return requestWork(tx, tick, work);
}

async function transition(tx: DbTransaction, todo: Todo, state: 'cancelled' | 'blocked') {
  const { rowCount } = await tx.query(
    `UPDATE work SET state = $3, revision = revision + 1
     WHERE ${todoFamilies} AND learner_id = $1 AND slot_key = $2 AND revision = $4
       AND state IN ('pending','ready','waiting')`,
    [tx.learner, todo.id, state, todo.revision],
  );
  if (rowCount) await setPending(tx, { slotType: todoSlot, slotKey: todo.id }, 'none');
  return rowCount === 1;
}

async function rememberDeferral(tx: DbTransaction, todo: Todo, deferral: TodoDeferral, now: number) {
  if (todo.spec.trigger.kind !== 'scheduled' || !Number.isSafeInteger(deferral.retryAtMs) || deferral.retryAtMs <= now)
    throw new Error('Only scheduled Todo work can defer to a future check');
  const retryAtMs = Math.min(todo.spec.expiresAtMs, deferral.retryAtMs);
  await tx.query(`UPDATE slot_state SET pending='none', last_error=$3
    WHERE learner_id=$1 AND slot_type='working.todo' AND slot_key=$2`,
  [tx.learner, todo.id, JSON.stringify({ ...deferral, retryAtMs })]);
  return retryAtMs;
}

function clearDeferral(tx: DbTransaction, todo: Todo) {
  return tx.query(`UPDATE slot_state SET last_error=NULL WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3
    AND last_error->>'status'='not_dispatched'`, [tx.learner, todoSlot, todo.id]);
}

/** A dispatched scheduled task can return to pending when a prerequisite is lost. */
export async function deferDispatchedTodo(tx: DbTransaction, ref: WorkRef, todo: Todo, deferral: TodoDeferral, now: number) {
  if (ref.learner !== tx.learner || todo.learner !== tx.learner || todo.state !== 'dispatched') return false;
  const result = await tx.query(`UPDATE work SET state='pending', generation=generation+1, revision=revision+1, execution_ref=NULL
    WHERE learner_id=$1 AND id=$2 AND generation=$3 AND slot_key=$4 AND revision=$5 AND ${todoFamilies} AND state='ready'`,
  [ref.learner, ref.workId, ref.generation, todo.id, todo.revision]);
  if (!result.rowCount) return false;
  await rememberDeferral(tx, todo, deferral, now);
  return true;
}

async function dispatch(tx: DbTransaction, tick: Tick, todo: Todo, now: number, eligible: Eligibility) {
  const decision = todo.spec.expiresAtMs > now && await eligible(todo.spec, todo.route);
  if (typeof decision !== 'boolean') return rememberDeferral(tx, todo, decision, now);
  if (!decision) return transition(tx, todo, 'cancelled');
  const executionRef = newUlid();
  const { rows: [ref] } = await tx.query<{ workId: string; generation: string }>(
    `UPDATE work SET state='ready', execution_ref=$4, requested_tick=$5, revision=revision+1
     WHERE learner_id=$1 AND ${todoFamilies} AND slot_key=$2 AND revision=$3 AND state='pending'
     RETURNING id AS "workId", generation::text`, [tx.learner, todo.id, todo.revision, executionRef, tick]);
  if (!ref) return false;
  if (todo.spec.trigger.kind === 'scheduled') await clearDeferral(tx, todo);
  await enqueueGeneration(tx, { slotType: todoSlot, slotKey: todo.id }, { learner: tx.learner, ...ref }, executionRef,
    todo.route ? 'routed_pending' : 'pending');
  return true;
}

function eventParent(spec: TodoSpec) {
  const { trigger } = spec;
  return trigger.kind === 'event' && trigger.event.type === 'on_work_completed' ? trigger.event.subject : undefined;
}

/** Mutators run inside the caller's learner write transaction. */
export async function emitTodo(tx: DbTransaction, tick: Tick, input: TodoInput, now: number, eligible: Eligibility, route?: TodoRoute) {
  const spec = todoSpec.parse(input);
  const active = await tx.query<Todo>(
    `SELECT ${columns} FROM work WHERE ${todoFamilies} AND learner_id = $1 AND dedup_key = $2 AND state IN ('pending','ready','waiting')`,
    [tx.learner, spec.dedupKey],
  );
  if (active.rows[0]) return parsed(active.rows[0]);
  const completionParent = eventParent(spec);
  if (completionParent && spec.parentTodoId && completionParent !== spec.parentTodoId) return null;
  const parentId = completionParent ?? spec.parentTodoId;
  const parent = parentId ? await readTodo(tx, parentId) : null;
  if (parentId && (!parent || parent.hopCount >= maxTodoHops || parent.state === 'cancelled' ||
      parent.state === 'failed' || (!completionParent && parent.state !== 'completed')))
    return null;
  const id = newUlid();
  const todo: Todo = { learner: tx.learner, id, spec, route: route?.deriver ?? null, state: 'pending', revision: 1, chainId: parent?.chainId ?? id,
    hopCount: parent ? parent.hopCount + 1 : 0, registeredTick: tick, resultId: null };
  await tx.insert('slot_state', {
    learner_id: tx.learner, slot_type: todoSlot, slot_key: id, scope_keys: '{}', changed_tick: tick,
  });
  await tx.insert('work', {
    learner_id: tx.learner, id, slot_type: todoSlot, slot_key: id, spec: JSON.stringify(spec),
    priority: spec.priority ?? 0, deriver: route?.deriver ?? spec.workerProfile, family: route ? 'routed_todo' : 'todo', requested_tick: tick,
    ...(route && { erasure_basis: route.erasureBasis, settings_fact_id: route.settingsFactId }),
    state: todo.state, chain_id: todo.chainId, hop_count: todo.hopCount, registered_tick: tick,
  });
  if (spec.trigger.kind === 'immediate' || (completionParent && parent?.state === 'completed'))
    await dispatch(tx, tick, todo, now, eligible);
  return readTodo(tx, id);
}

export async function updateOrCancelTodo(
  tx: DbTransaction, tick: Tick, id: string, revision: number,
  change: { kind: 'cancel' } | {
    kind: 'update';
    patch: Partial<Omit<TodoInput, 'dedupKey' | 'settingsRevision' | 'parentTodoId'>>;
  },
  now: number, eligible: Eligibility,
) {
  const todo = await readTodo(tx, id);
  if (!todo || todo.revision !== revision || !['pending', 'dispatched'].includes(todo.state)) return false;
  if (change.kind === 'cancel') return transition(tx, todo, 'cancelled');
  if (todo.state !== 'pending' || todo.route) return false;
  const { dedupKey, settingsRevision, parentTodoId } = todo.spec;
  const spec = todoSpec.parse({ ...todo.spec, ...change.patch, dedupKey, settingsRevision, parentTodoId });
  // A trigger edit may change timing but cannot attach to a different completion chain.
  if (eventParent(spec) !== eventParent(todo.spec)) return false;
  const { trigger } = spec;
  const previous = todo.spec.trigger;
  const sameEvent = trigger.kind === 'event' && previous.kind === 'event'
    && trigger.event.type === previous.event.type && trigger.event.subject === previous.event.subject;
  // Extending or editing the task keeps already-observed events for the same subscription.
  const registeredTick = sameEvent ? todo.registeredTick : tick;
  await tx.query(`UPDATE work SET spec = $3, revision = revision + 1, registered_tick = $4, deriver=$5, priority=$6
    WHERE ${todoFamilies} AND learner_id = $1 AND slot_key = $2`,
  [tx.learner, id, JSON.stringify(spec), registeredTick, spec.workerProfile, spec.priority ?? 0]);
  if (previous.kind === 'scheduled') await clearDeferral(tx, todo);
  if (spec.trigger.kind === 'immediate') await dispatch(tx, tick, { ...todo, spec, revision: revision + 1 }, now, eligible);
  return true;
}

export function cancelResearchTodos(tx: DbTransaction) {
  return tx.query(`WITH cancelled AS (UPDATE work SET state = 'cancelled', revision = revision + 1
    WHERE ${todoFamilies} AND learner_id = $1 AND state IN ('pending','ready','waiting') RETURNING slot_type,slot_key)
    UPDATE slot_state s SET pending='none' FROM cancelled c
    WHERE learner_id=$1 AND (s.slot_type,s.slot_key)=(c.slot_type,c.slot_key)`, [tx.learner]);
}

export async function recordTodoEvent(tx: DbTransaction, tick: Tick, input: TodoEvent) {
  const { type, subject } = todoEvent.parse(input);
  await tx.query(`INSERT INTO working_todo_events (learner_id, event_type, subject, seen_tick)
    VALUES ($1, $2, $3, $4) ON CONFLICT (learner_id, event_type, subject)
    DO UPDATE SET seen_tick = GREATEST(working_todo_events.seen_tick, EXCLUDED.seen_tick)`,
  [tx.learner, type, subject, tick]);
}

export async function completeTodo(tx: DbTransaction, tick: Tick, ref: WorkRef, todo: Todo, resultId: string) {
  if (ref.learner !== tx.learner || todo.learner !== tx.learner || todo.state !== 'dispatched') return false;
  const updated = await tx.query(
    `UPDATE work SET state='satisfied', result_id=$6, revision=revision+1
     WHERE learner_id=$1 AND id=$2 AND generation=$3 AND slot_key=$4 AND revision=$5
       AND ${todoFamilies} AND state='ready' AND (publication_fact_id IS NULL OR publication_fact_id=$6)`,
    [ref.learner, ref.workId, ref.generation, todo.id, todo.revision, resultId],
  );
  if (!updated.rowCount) return false;
  await setPending(tx, { slotType: todoSlot, slotKey: todo.id }, 'none');
  await recordTodoEvent(tx, tick, { type: 'on_work_completed', subject: todo.id });
  return true;
}

export async function endDispatchedTodo(tx: DbTransaction, id: string, state: 'cancelled' | 'failed') {
  const todo = await readTodo(tx, id);
  if (todo?.state === 'dispatched') await transition(tx, todo, state === 'failed' ? 'blocked' : 'cancelled');
}

export async function checkTodoTriggers(tx: DbTransaction, now: number, eligible: Eligibility, routedDeriver?: string) {
  await lockLearner(tx, tx.learner);
  const { rows } = await tx.query<Todo & { noticed: boolean; retry: string | null }>(
    `SELECT ${columns}, EXISTS (
       SELECT 1 FROM working_todo_events e WHERE e.learner_id = t.learner_id
        AND e.event_type = t.event_match->>'type' AND e.subject = t.event_match->>'subject'
        AND e.seen_tick > t.registered_tick
     ) AS noticed, (SELECT s.last_error->>'retryAtMs' FROM slot_state s WHERE (s.learner_id,s.slot_type,s.slot_key)=
       (t.learner_id,t.slot_type,t.slot_key) AND s.last_error->>'status'='not_dispatched') AS retry
     FROM work t WHERE (family='todo' OR family='routed_todo' AND deriver=$2) AND learner_id = $1 AND state = 'pending'
     ORDER BY priority,registered_tick,slot_key`, [tx.learner, routedDeriver ?? null],
  );
  const due: Todo[] = [];
  let nextAt: number | undefined;
  for (const row of rows) {
    const todo = parsed(row);
    const { trigger, expiresAtMs } = todo.spec;
    const deadline = trigger.kind === 'scheduled' ? Math.min(Math.max(trigger.fireAtMs, Number(row.retry ?? 0)), expiresAtMs) : expiresAtMs;
    if (deadline <= now || row.noticed) due.push(todo);
    else nextAt = Math.min(nextAt ?? deadline, deadline);
  }
  let advanced = false;
  if (due.length) await tx.withLearnerWrite(async tick => {
    for (const todo of due) {
      const outcome = await dispatch(tx, tick, todo, now, eligible);
      if (typeof outcome === 'number') nextAt = Math.min(nextAt ?? outcome, outcome);
      else advanced ||= outcome;
    }
  });
  return { advanced, nextAt };
}

export async function newFactWatermark(tx: ReadTransaction) {
  const { rows: [row] } = await tx.query<{ observed: Tick; reviewed: Tick }>(
    `SELECT COALESCE((SELECT max(changed_tick) FROM facts WHERE learner_id = $1), 0)::text AS observed,
       COALESCE((SELECT fact_tick FROM working_todo_watermarks WHERE learner_id = $1), 0)::text AS reviewed`,
    [tx.learner],
  );
  return row && BigInt(row.observed) > BigInt(row.reviewed) ? row : null;
}

export function saveFactWatermark(tx: DbTransaction, tick: Tick) {
  return tx.query(`INSERT INTO working_todo_watermarks (learner_id, fact_tick) VALUES ($1, $2)
    ON CONFLICT (learner_id) DO UPDATE SET fact_tick = EXCLUDED.fact_tick`, [tx.learner, tick]);
}
