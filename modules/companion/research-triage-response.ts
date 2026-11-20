import { isJson } from '@mangekyo/kernel';
import type { TriageAllowedIds } from './research-triage-snapshot.ts';

export type TriageTier = 1 | 2 | 3 | 4;

export type TriageTodoTemplate = {
  readonly dedupKey: string;
  readonly trigger: {
    readonly kind: 'immediate' | 'scheduled' | 'event';
    readonly ref?: string;
  };
  readonly workerProfile:
    | 'heavy_tutor_prep'
    | 'deep_analyst'
    | 'question_author'
    | 'deterministic_compute';
  readonly autonomyTier: TriageTier;
  readonly goal: string;
  readonly refs: readonly string[];
  readonly sourceFactRev: string;
  readonly budgetCap: string;
  readonly chainId: string;
  readonly hopCount: string;
};

export type TriageSkillId =
    | 'remediate_misconception'
    | 'preemptive_forgetting_prep'
    | 'defer_or_cancel_on_fatigue_or_undo'
    | 'exam_or_goal_shift_replan'
    | 'chain_post_work_followup'
    | 'escalate_ambiguous_deep_case';

export type TriageAction =
  | { readonly kind: 'noop' }
  | {
    readonly kind: 'emit_todo';
    readonly skill: TriageSkillId;
    readonly dedupKey: string;
    readonly goal: string;
    readonly trigger: TriageTodoTemplate['trigger'];
    readonly workerProfile: TriageTodoTemplate['workerProfile'];
    readonly autonomyTier: TriageTodoTemplate['autonomyTier'];
    readonly refs: readonly string[];
    readonly sourceFactRev: string;
    readonly budgetCap: string;
    readonly chainId: string;
    readonly hopCount: string;
  }
  | {
    readonly kind: 'update_or_cancel_todo';
    readonly todoId: string;
    readonly operation: 'update' | 'cancel' | 'defer';
    readonly reason: string;
  }
  | {
    readonly kind: 'escalate_to_user';
    readonly tier: 3 | 4;
    readonly reason: string;
    readonly refs: readonly string[];
  };

export type TriageResponse = {
  readonly matchedSkill: TriageSkillId | null;
  readonly reasonBrief: string;
  readonly actions: readonly TriageAction[];
  readonly memoTable: readonly { readonly key: string; readonly value: string; readonly expiresAt: string }[];
  readonly nextRecheckHint: string | null;
};

export class TriageResponseError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(issues.join('; '));
    this.name = 'TriageResponseError';
    this.issues = issues;
  }
}

const ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const forbiddenExpression = /[{}]|\b(select|insert|update|delete|where|jsonb|sql|expression|eval|function)\b/i;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TriageResponseError([`${label} must be an object`]);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string, issues: string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    issues.push(`${label} has unexpected fields`);
  }
}

function text(value: unknown, label: string, issues: string[], max = 240): string | null {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    issues.push(`${label} must be a non-empty string up to ${max} chars`);
    return null;
  }
  if (forbiddenExpression.test(value)) issues.push(`${label} looks like an expression`);
  return value;
}

function nullableText(value: unknown, label: string, issues: string[], max = 240): string | null {
  if (value === null) return null;
  return text(value, label, issues, max);
}

function stringArray(value: unknown, label: string, issues: string[]): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    issues.push(`${label} must be an array of non-empty strings`);
    return [];
  }
  return value as readonly string[];
}

function allowedId(value: string, allowed: TriageAllowedIds): boolean {
  return [...allowed.facts, ...allowed.events, ...allowed.todos, ...allowed.inventory,
    ...allowed.forecasts, ...allowed.work, ...allowed.memos, ...allowed.signals].includes(value);
}

function checkRefs(value: readonly string[], label: string, allowed: TriageAllowedIds, issues: string[]): void {
  for (const ref of value) {
    if (!ulid.test(ref) && !/^[a-z][a-z0-9_.:-]{0,119}$/i.test(ref)) {
      issues.push(`${label} contains invalid ref ${ref}`);
    } else if (!allowedId(ref, allowed)) {
      issues.push(`${label} contains ref outside snapshot: ${ref}`);
    }
  }
}

function checkTodoFields(
  action: Record<string, unknown>,
  template: TriageTodoTemplate,
  issues: string[],
): void {
  if (action.dedup_key !== template.dedupKey) issues.push('emit_todo.dedup_key must come from matched card template');
  if (action.goal !== template.goal) issues.push('emit_todo.goal must come from matched card template');
  if (JSON.stringify(action.trigger) !== JSON.stringify(template.trigger)) {
    issues.push('emit_todo.trigger must come from matched card template');
  }
  if (action.worker_profile !== template.workerProfile) issues.push('emit_todo.worker_profile must come from matched card template');
  if (action.autonomy_tier !== template.autonomyTier) issues.push('emit_todo.autonomy_tier must come from matched card template');
  if (action.source_fact_rev !== template.sourceFactRev) issues.push('emit_todo.source_fact_rev must come from matched card template');
  if (action.budget_cap !== template.budgetCap) issues.push('emit_todo.budget_cap must come from matched card template');
  if (action.chain_id !== template.chainId) issues.push('emit_todo.chain_id must come from matched card template');
  if (action.hop_count !== template.hopCount) issues.push('emit_todo.hop_count must come from matched card template');
  const refs = stringArray(action.refs, 'emit_todo.refs', issues);
  if (refs.length > template.refs.length) issues.push('emit_todo.refs exceeds template slot count');
  for (const [index, slot] of template.refs.entries()) {
    if (refs[index] !== slot) issues.push(`emit_todo.refs[${index}] must be template slot ${slot}`);
  }
}

type TriageTemplates = ReadonlyMap<TriageSkillId, { readonly todoTemplate: TriageTodoTemplate }>;

function parseAction(value: unknown, index: number, allowed: TriageAllowedIds, templates: TriageTemplates): TriageAction {
  const issues: string[] = [];
  const action = object(value, `actions[${index}]`);
  const kind = action.kind;
  if (kind === 'noop') {
    exactKeys(action, ['kind'], `actions[${index}]`, issues);
    if (issues.length) throw new TriageResponseError(issues);
    return { kind: 'noop' };
  }
  if (kind === 'emit_todo') {
    exactKeys(action, [
      'kind', 'skill', 'dedup_key', 'goal', 'trigger', 'worker_profile', 'autonomy_tier',
      'refs', 'source_fact_rev', 'budget_cap', 'chain_id', 'hop_count',
    ], `actions[${index}]`, issues);
    const skill = action.skill as TriageSkillId;
    const card = typeof skill === 'string' ? templates.get(skill) : undefined;
    if (!card) issues.push(`actions[${index}].skill is not a known card`);
    text(action.goal, `actions[${index}].goal`, issues);
    if (!isJson(action.trigger)) issues.push(`actions[${index}].trigger must be JSON`);
    if (action.worker_profile !== 'heavy_tutor_prep' && action.worker_profile !== 'deep_analyst' &&
        action.worker_profile !== 'question_author' && action.worker_profile !== 'deterministic_compute') {
      issues.push(`actions[${index}].worker_profile is invalid`);
    }
    if (action.autonomy_tier !== 1 && action.autonomy_tier !== 2 && action.autonomy_tier !== 3 && action.autonomy_tier !== 4) {
      issues.push(`actions[${index}].autonomy_tier must be 1-4`);
    }
    if (typeof action.source_fact_rev !== 'string' || action.source_fact_rev.length === 0) {
      issues.push(`actions[${index}].source_fact_rev must be a string`);
    }
    if (typeof action.budget_cap !== 'string' || action.budget_cap.length === 0) {
      issues.push(`actions[${index}].budget_cap must be a string`);
    }
    if (typeof action.chain_id !== 'string' || action.chain_id.length === 0) {
      issues.push(`actions[${index}].chain_id must be a string`);
    }
    if (typeof action.hop_count !== 'string' || action.hop_count.length === 0) {
      issues.push(`actions[${index}].hop_count must be a string`);
    }
    if (card) checkTodoFields(action, card.todoTemplate, issues);
    if (issues.length) throw new TriageResponseError(issues);
    const trigger = action.trigger as TriageTodoTemplate['trigger'];
    return {
      kind: 'emit_todo',
      skill,
      dedupKey: action.dedup_key as string,
      goal: action.goal as string,
      trigger,
      workerProfile: action.worker_profile as TriageTodoTemplate['workerProfile'],
      autonomyTier: action.autonomy_tier as TriageTodoTemplate['autonomyTier'],
      refs: action.refs as readonly string[],
      sourceFactRev: action.source_fact_rev as string,
      budgetCap: action.budget_cap as string,
      chainId: action.chain_id as string,
      hopCount: action.hop_count as string,
    };
  }
  if (kind === 'update_or_cancel_todo') {
    exactKeys(action, ['kind', 'todo_id', 'operation', 'reason'], `actions[${index}]`, issues);
    const todoId = action.todo_id;
    if (typeof todoId !== 'string' || !ulid.test(todoId)) issues.push(`actions[${index}].todo_id must be a ULID`);
    else if (!allowed.todos.has(todoId)) issues.push(`actions[${index}].todo_id is outside snapshot`);
    if (action.operation !== 'update' && action.operation !== 'cancel' && action.operation !== 'defer') {
      issues.push(`actions[${index}].operation is invalid`);
    }
    text(action.reason, `actions[${index}].reason`, issues);
    if (issues.length) throw new TriageResponseError(issues);
    return {
      kind: 'update_or_cancel_todo',
      todoId: todoId as string,
      operation: action.operation as 'update' | 'cancel' | 'defer',
      reason: action.reason as string,
    };
  }
  if (kind === 'escalate_to_user') {
    exactKeys(action, ['kind', 'tier', 'reason', 'refs'], `actions[${index}]`, issues);
    if (action.tier !== 3 && action.tier !== 4) issues.push(`actions[${index}].tier must be 3 or 4`);
    text(action.reason, `actions[${index}].reason`, issues);
    const refs = stringArray(action.refs, `actions[${index}].refs`, issues);
    checkRefs(refs, `actions[${index}].refs`, allowed, issues);
    if (issues.length) throw new TriageResponseError(issues);
    return { kind: 'escalate_to_user', tier: action.tier as 3 | 4, reason: action.reason as string, refs };
  }
  issues.push(`actions[${index}].kind is invalid`);
  throw new TriageResponseError(issues);
}

export function parseTriageResponse(
  raw: string,
  allowed: TriageAllowedIds,
  templates: TriageTemplates,
): TriageResponse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TriageResponseError(['response must be a single JSON object']);
  }
  const issues: string[] = [];
  const response = object(value, 'response');
  exactKeys(response, ['matched_skill', 'reason_brief', 'actions', 'memo_table', 'next_recheck_hint'], 'response', issues);
  const matched = response.matched_skill === null ? null : response.matched_skill;
  if (matched !== null && (typeof matched !== 'string' || !templates.has(matched as TriageSkillId))) {
    issues.push('matched_skill must be null or a known card id');
  }
  const reason = text(response.reason_brief, 'reason_brief', issues, 400);
  if (!Array.isArray(response.actions) || response.actions.length > 4) {
    issues.push('actions must be an array with at most 4 items');
  }
  const actions = Array.isArray(response.actions)
    ? response.actions.map((action, index) => parseAction(action, index, allowed, templates))
    : [];
  if (!Array.isArray(response.memo_table) || response.memo_table.length > 5) {
    issues.push('memo_table must be an array with at most 5 items');
  }
  const memoTable = Array.isArray(response.memo_table)
    ? response.memo_table.map((memo, index) => {
      const record = object(memo, `memo_table[${index}]`);
      const memoIssues: string[] = [];
      exactKeys(record, ['key', 'value', 'expires_at'], `memo_table[${index}]`, memoIssues);
      const key = text(record.key, `memo_table[${index}].key`, memoIssues, 80);
      const memoValue = text(record.value, `memo_table[${index}].value`, memoIssues, 160);
      const expiresAt = text(record.expires_at, `memo_table[${index}].expires_at`, memoIssues, 80);
      if (expiresAt && !isoTime.test(expiresAt)) memoIssues.push(`memo_table[${index}].expires_at must be ISO time`);
      if (memoIssues.length) throw new TriageResponseError(memoIssues);
      return { key: key!, value: memoValue!, expiresAt: expiresAt! };
    })
    : [];
  const hint = nullableText(response.next_recheck_hint, 'next_recheck_hint', issues);
  if (matched !== null && actions.some((action) => action.kind === 'emit_todo' && action.skill !== matched)) {
    issues.push('matched_skill must match every emit_todo skill');
  }
  if (issues.length) throw new TriageResponseError(issues);
  return {
    matchedSkill: matched as TriageResponse['matchedSkill'],
    reasonBrief: reason!,
    actions,
    memoTable,
    nextRecheckHint: hint,
  };
}
