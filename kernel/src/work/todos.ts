import { z } from 'zod';
import type { DbQuery, DbTransaction, ReadTransaction } from '../db/types.ts';
import { lockLearner } from '../db/learner.ts';
import { factId, type Tick } from '../declarations/ids.ts';
import { enqueueGeneration, setPending, requestWork, todoSlot, type WorkRequest } from './demand.ts';
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
  id: string;
  spec: TodoSpec;
  revision: number;
  state: TodoState;
  chainId: string;
  hopCount: number;
  registeredTick: string;
  resultId: string | null;
};
type Eligibility = (spec: TodoSpec) => Promise<boolean>;

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

const columns = `slot_key AS id, spec, revision, CASE state
  WHEN 'pending' THEN 'pending' WHEN 'ready' THEN 'dispatched' WHEN 'waiting' THEN 'dispatched'
  WHEN 'satisfied' THEN 'completed' WHEN 'cancelled' THEN 'cancelled' ELSE 'failed' END AS state, chain_id AS "chainId",
  hop_count AS "hopCount", registered_tick::text AS "registeredTick", result_id AS "resultId"`;

function parsed(row: Todo): Todo {
  return { ...row, spec: todoSpec.parse(row.spec) };
}

export async function readTodo(tx: ReadTransaction, id: string) {
  const { rows: [row] } = await tx.query<Todo>(
    `SELECT ${columns} FROM work WHERE family='todo' AND learner_id = $1 AND slot_key = $2`, [tx.learner, id],
  );
  return row ? parsed(row) : null;
}

export async function enqueueWork(tx: DbTransaction, tick: Tick, work: WorkRequest) {
  await tx.query(
    `INSERT INTO slot_state (learner_id, slot_type, slot_key, scope_keys, changed_tick)
     VALUES ($1, $2, $3, '{}', $4) ON CONFLICT (learner_id, slot_type, slot_key) DO NOTHING`,
    [tx.learner, work.slotType, work.slotKey, tick],
  );
  return requestWork(tx, tick, work);
}

async function transition(tx: DbTransaction, todo: Todo, state: 'cancelled' | 'blocked' | 'satisfied', resultId?: string) {
  const { rowCount } = await tx.query(
    `UPDATE work SET state = $3, result_id = $4, revision = revision + 1
     WHERE family='todo' AND learner_id = $1 AND slot_key = $2 AND revision = $5
       AND state IN ('pending','ready','waiting')`,
    [tx.learner, todo.id, state, resultId ?? null, todo.revision],
  );
  if (rowCount) await setPending(tx, { slotType: todoSlot, slotKey: todo.id }, 'none');
  return rowCount === 1;
}

async function dispatch(tx: DbTransaction, tick: Tick, todo: Todo, now: number, eligible: Eligibility) {
  if (todo.spec.expiresAtMs <= now || !await eligible(todo.spec)) {
    await transition(tx, todo, 'cancelled');
    return;
  }
  const executionRef = newUlid();
  const { rows: [ref] } = await tx.query<{ workId: string; generation: string }>(
    `UPDATE work SET state='ready', execution_ref=$4, requested_tick=$5, revision=revision+1
     WHERE learner_id=$1 AND family='todo' AND slot_key=$2 AND revision=$3 AND state='pending'
     RETURNING id AS "workId", generation::text`, [tx.learner, todo.id, todo.revision, executionRef, tick]);
  if (ref) await enqueueGeneration(tx, { slotType: todoSlot, slotKey: todo.id }, { learner: tx.learner, ...ref }, executionRef);
}

function eventParent(spec: TodoSpec) {
  const { trigger } = spec;
  return trigger.kind === 'event' && trigger.event.type === 'on_work_completed' ? trigger.event.subject : undefined;
}

/** Mutators run inside the caller's learner write transaction. */
export async function emitTodo(tx: DbTransaction, tick: Tick, input: TodoInput, now: number, eligible: Eligibility) {
  const spec = todoSpec.parse(input);
  const active = await tx.query<Todo>(
    `SELECT ${columns} FROM work WHERE family='todo' AND learner_id = $1 AND dedup_key = $2 AND state IN ('pending','ready','waiting')`,
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
  const todo: Todo = { id, spec, state: 'pending', revision: 1, chainId: parent?.chainId ?? id,
    hopCount: parent ? parent.hopCount + 1 : 0, registeredTick: tick, resultId: null };
  await tx.insert('slot_state', {
    learner_id: tx.learner, slot_type: todoSlot, slot_key: id, scope_keys: '{}', changed_tick: tick,
  });
  await tx.insert('work', {
    learner_id: tx.learner, id, slot_type: todoSlot, slot_key: id, spec: JSON.stringify(spec),
    priority: spec.priority ?? 0, deriver: spec.workerProfile, family: 'todo', requested_tick: tick,
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
  if (todo.state !== 'pending') return false;
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
    WHERE family='todo' AND learner_id = $1 AND slot_key = $2`,
  [tx.learner, id, JSON.stringify(spec), registeredTick, spec.workerProfile, spec.priority ?? 0]);
  if (spec.trigger.kind === 'immediate') await dispatch(tx, tick, { ...todo, spec, revision: revision + 1 }, now, eligible);
  return true;
}

export function cancelResearchTodos(tx: DbTransaction) {
  return tx.query(`WITH cancelled AS (UPDATE work SET state = 'cancelled', revision = revision + 1
    WHERE family='todo' AND learner_id = $1 AND state IN ('pending','ready','waiting') RETURNING slot_type,slot_key)
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

export async function completeTodo(tx: DbTransaction, tick: Tick, todo: Todo, resultId: string) {
  if (todo.state !== 'dispatched' || !await transition(tx, todo, 'satisfied', resultId)) return false;
  await recordTodoEvent(tx, tick, { type: 'on_work_completed', subject: todo.id });
  return true;
}

export async function endDispatchedTodo(tx: DbTransaction, id: string, state: 'cancelled' | 'failed') {
  const todo = await readTodo(tx, id);
  if (todo?.state === 'dispatched') await transition(tx, todo, state === 'failed' ? 'blocked' : 'cancelled');
}

export async function checkTodoTriggers(tx: DbTransaction, now: number, eligible: Eligibility) {
  await lockLearner(tx, tx.learner);
  const { rows } = await tx.query<Todo & { noticed: boolean }>(
    `SELECT ${columns}, EXISTS (
       SELECT 1 FROM working_todo_events e WHERE e.learner_id = t.learner_id
        AND e.event_type = t.event_match->>'type' AND e.subject = t.event_match->>'subject'
        AND e.seen_tick > t.registered_tick
     ) AS noticed FROM work t WHERE family='todo' AND learner_id = $1 AND state = 'pending' ORDER BY priority,registered_tick,slot_key`, [tx.learner],
  );
  const due: Todo[] = [];
  let nextAt: number | undefined;
  for (const row of rows) {
    const todo = parsed(row);
    const { trigger, expiresAtMs } = todo.spec;
    const deadline = trigger.kind === 'scheduled' ? Math.min(trigger.fireAtMs, expiresAtMs) : expiresAtMs;
    if (deadline <= now || row.noticed) due.push(todo);
    else nextAt = Math.min(nextAt ?? deadline, deadline);
  }
  if (due.length) {
    await tx.withLearnerWrite(async tick => {
      for (const todo of due) await dispatch(tx, tick, todo, now, eligible);
    });
  }
  return { advanced: due.length > 0, nextAt };
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
