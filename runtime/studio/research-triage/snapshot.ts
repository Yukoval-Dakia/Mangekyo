import { isJson } from '../../../kernel/src/declarations/define.ts';
import type { Json } from '../../../kernel/src/declarations/types.ts';

export type TriageSnapshot = {
  readonly facts: Readonly<Record<string, Json>>;
  readonly events: Readonly<Record<string, Json>>;
  readonly todos: Readonly<Record<string, Json>>;
  readonly inventory: Readonly<Record<string, Json>>;
  readonly forecasts: Readonly<Record<string, Json>>;
  readonly work: Readonly<Record<string, Json>>;
  readonly memos: Readonly<Record<string, Json>>;
  readonly chain: Json;
  readonly budget: Json;
  readonly signals: Readonly<Record<string, Json>>;
};

export type TriageAllowedIds = {
  readonly facts: ReadonlySet<string>;
  readonly events: ReadonlySet<string>;
  readonly todos: ReadonlySet<string>;
  readonly inventory: ReadonlySet<string>;
  readonly forecasts: ReadonlySet<string>;
  readonly work: ReadonlySet<string>;
  readonly memos: ReadonlySet<string>;
  readonly signals: ReadonlySet<string>;
};

const ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const revision = /^[1-9][0-9]*$/;
const accessEpoch = /^(?:0|[1-9][0-9]*)$/;
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function idMap(value: unknown, label: string): Record<string, Json> {
  const map = object(value, label);
  for (const [key, entry] of Object.entries(map)) {
    if (!ulid.test(key)) throw new Error(`${label} key must be a ULID`);
    if (!isJson(entry)) throw new Error(`${label}.${key} must be JSON`);
  }
  return map as Record<string, Json>;
}

function factLike(value: Json, label: string): void {
  const record = object(value, label);
  if (typeof record.id !== 'string' || !ulid.test(record.id)) throw new Error(`${label}.id must be a ULID`);
  if (typeof record.rev !== 'number' || !Number.isSafeInteger(record.rev) || record.rev < 1) {
    throw new Error(`${label}.rev must be a positive integer`);
  }
  if (typeof record.fact_type !== 'string' || record.fact_type.length === 0) {
    throw new Error(`${label}.fact_type must be a string`);
  }
  if (typeof record.access_epoch !== 'string' || !accessEpoch.test(record.access_epoch)) {
    throw new Error(`${label}.access_epoch must be a tick string`);
  }
  if (typeof record.retracted_rev !== 'number' || !Number.isSafeInteger(record.retracted_rev) || record.retracted_rev < 0) {
    throw new Error(`${label}.retracted_rev must be a non-negative integer`);
  }
  if (typeof record.purpose !== 'string' || record.purpose.length === 0) {
    throw new Error(`${label}.purpose must be a string`);
  }
  if (!isJson(record.data)) throw new Error(`${label}.data must be JSON`);
}

function eventLike(value: Json, label: string): void {
  const record = object(value, label);
  if (typeof record.event_id !== 'string' || record.event_id.length === 0) {
    throw new Error(`${label}.event_id must be a string`);
  }
  if (typeof record.kind !== 'string' || record.kind.length === 0) {
    throw new Error(`${label}.kind must be a string`);
  }
  if (typeof record.fact_ref !== 'string' || !ulid.test(record.fact_ref)) {
    throw new Error(`${label}.fact_ref must be a ULID`);
  }
  if (typeof record.fact_rev !== 'number' || !Number.isSafeInteger(record.fact_rev) || record.fact_rev < 1) {
    throw new Error(`${label}.fact_rev must be a positive integer`);
  }
  if (!isJson(record.payload)) throw new Error(`${label}.payload must be JSON`);
}

function todoLike(value: Json, label: string): void {
  const record = object(value, label);
  if (typeof record.todo_id !== 'string' || !ulid.test(record.todo_id)) {
    throw new Error(`${label}.todo_id must be a ULID`);
  }
  if (typeof record.dedup_key !== 'string' || record.dedup_key.length === 0) {
    throw new Error(`${label}.dedup_key must be a string`);
  }
  if (typeof record.status !== 'string' || !['pending', 'scheduled', 'done', 'cancelled', 'failed'].includes(record.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  if (typeof record.trigger !== 'string' || record.trigger.length === 0) {
    throw new Error(`${label}.trigger must be a string`);
  }
  if (typeof record.source_fact_rev !== 'string' || !revision.test(record.source_fact_rev)) {
    throw new Error(`${label}.source_fact_rev must be a revision string`);
  }
  if (typeof record.autonomy_tier !== 'number' || ![1, 2, 3, 4].includes(record.autonomy_tier)) {
    throw new Error(`${label}.autonomy_tier must be 1-4`);
  }
}

function inventoryLike(value: Json, label: string): void {
  const record = object(value, label);
  if (typeof record.inventory_id !== 'string' || !ulid.test(record.inventory_id)) {
    throw new Error(`${label}.inventory_id must be a ULID`);
  }
  if (typeof record.kind !== 'string' || record.kind.length === 0) {
    throw new Error(`${label}.kind must be a string`);
  }
  if (typeof record.status !== 'string' || !['ready', 'used', 'withdrawn', 'expired'].includes(record.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  if (typeof record.source_fact_rev !== 'string' || !revision.test(record.source_fact_rev)) {
    throw new Error(`${label}.source_fact_rev must be a revision string`);
  }
}

function forecastLike(value: Json, label: string): void {
  const record = object(value, label);
  if (typeof record.forecast_id !== 'string' || !ulid.test(record.forecast_id)) {
    throw new Error(`${label}.forecast_id must be a ULID`);
  }
  if (typeof record.knowledge_point_id !== 'string' || !ulid.test(record.knowledge_point_id)) {
    throw new Error(`${label}.knowledge_point_id must be a ULID`);
  }
  if (typeof record.predicted_crossing_at !== 'string' || !isoTime.test(record.predicted_crossing_at)) {
    throw new Error(`${label}.predicted_crossing_at must be ISO time`);
  }
  if (typeof record.confidence !== 'number' || record.confidence < 0 || record.confidence > 1) {
    throw new Error(`${label}.confidence must be between 0 and 1`);
  }
}

function workLike(value: Json, label: string): void {
  const record = object(value, label);
  if (typeof record.work_id !== 'string' || !ulid.test(record.work_id)) {
    throw new Error(`${label}.work_id must be a ULID`);
  }
  if (typeof record.state !== 'string' || !['queued', 'running', 'done', 'failed', 'cancelled'].includes(record.state)) {
    throw new Error(`${label}.state is invalid`);
  }
  if (typeof record.slot_type !== 'string' || record.slot_type.length === 0) {
    throw new Error(`${label}.slot_type must be a string`);
  }
  if (typeof record.slot_key !== 'string' || record.slot_key.length === 0) {
    throw new Error(`${label}.slot_key must be a string`);
  }
}

function memoLike(value: Json, label: string): void {
  const record = object(value, label);
  if (typeof record.memo_id !== 'string' || !ulid.test(record.memo_id)) {
    throw new Error(`${label}.memo_id must be a ULID`);
  }
  if (typeof record.text !== 'string' || record.text.length === 0 || record.text.length > 160) {
    throw new Error(`${label}.text must be a short string`);
  }
  if (typeof record.expires_at !== 'string' || !isoTime.test(record.expires_at)) {
    throw new Error(`${label}.expires_at must be ISO time`);
  }
}

function signalLike(value: Json, label: string): void {
  const record = object(value, label);
  if (typeof record.signal_id !== 'string' || !ulid.test(record.signal_id)) {
    throw new Error(`${label}.signal_id must be a ULID`);
  }
  if (typeof record.kind !== 'string' || record.kind.length === 0) {
    throw new Error(`${label}.kind must be a string`);
  }
  if (typeof record.scope !== 'string' || record.scope.length === 0) {
    throw new Error(`${label}.scope must be a string`);
  }
  if (typeof record.expires_at !== 'string' || !isoTime.test(record.expires_at)) {
    throw new Error(`${label}.expires_at must be ISO time`);
  }
}

export function parseTriageSnapshot(value: unknown): TriageSnapshot {
  const snapshot = object(value, 'snapshot');
  exactKeys(snapshot, [
    'facts', 'events', 'todos', 'inventory', 'forecasts', 'work', 'memos', 'chain', 'budget', 'signals',
  ], 'snapshot');
  const facts = idMap(snapshot.facts, 'snapshot.facts');
  const events = idMap(snapshot.events, 'snapshot.events');
  const todos = idMap(snapshot.todos, 'snapshot.todos');
  const inventory = idMap(snapshot.inventory, 'snapshot.inventory');
  const forecasts = idMap(snapshot.forecasts, 'snapshot.forecasts');
  const work = idMap(snapshot.work, 'snapshot.work');
  const memos = idMap(snapshot.memos, 'snapshot.memos');
  const signals = idMap(snapshot.signals, 'snapshot.signals');
  for (const [key, fact] of Object.entries(facts)) factLike(fact, `facts.${key}`);
  for (const [key, event] of Object.entries(events)) eventLike(event, `events.${key}`);
  for (const [key, todo] of Object.entries(todos)) todoLike(todo, `todos.${key}`);
  for (const [key, item] of Object.entries(inventory)) inventoryLike(item, `inventory.${key}`);
  for (const [key, forecast] of Object.entries(forecasts)) forecastLike(forecast, `forecasts.${key}`);
  for (const [key, item] of Object.entries(work)) workLike(item, `work.${key}`);
  for (const [key, memo] of Object.entries(memos)) memoLike(memo, `memos.${key}`);
  for (const [key, signal] of Object.entries(signals)) signalLike(signal, `signals.${key}`);
  if (!isJson(snapshot.chain)) throw new Error('snapshot.chain must be JSON');
  if (!isJson(snapshot.budget)) throw new Error('snapshot.budget must be JSON');
  return {
    facts, events, todos, inventory, forecasts, work, memos,
    chain: snapshot.chain, budget: snapshot.budget, signals,
  };
}

export function allowedTriageIds(snapshot: TriageSnapshot): TriageAllowedIds {
  return {
    facts: new Set(Object.keys(snapshot.facts)),
    events: new Set(Object.keys(snapshot.events)),
    todos: new Set(Object.keys(snapshot.todos)),
    inventory: new Set(Object.keys(snapshot.inventory)),
    forecasts: new Set(Object.keys(snapshot.forecasts)),
    work: new Set(Object.keys(snapshot.work)),
    memos: new Set(Object.keys(snapshot.memos)),
    signals: new Set(Object.keys(snapshot.signals)),
  };
}
