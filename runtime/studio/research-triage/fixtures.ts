import { parseTriageSnapshot, type TriageSnapshot } from './snapshot.ts';
import { parseTriageResponse, type TriageResponse } from './response.ts';
import { triageSkillById, type TriageSkillCard } from './skills.ts';

export type TriageExpected =
  | { readonly kind: 'noop' }
  | { readonly kind: 'emit'; readonly skill: TriageSkillCard['id'] }
  | { readonly kind: 'cancel'; readonly todoId: string }
  | { readonly kind: 'defer'; readonly todoId: string }
  | { readonly kind: 'escalate'; readonly tier: 3 | 4 };

export type TriageFixture = {
  readonly id: string;
  readonly wakeSource: string;
  readonly snapshot: unknown;
  readonly response: unknown;
  readonly expected: TriageExpected;
};

export type TriageFixtureResult = {
  readonly id: string;
  readonly ok: boolean;
  readonly classification:
    | 'hit'
    | 'false_positive'
    | 'missed'
    | 'withdrawal_hit'
    | 'withdrawal_missed'
    | 'withdrawal_false_positive'
    | 'invalid';
  readonly expected: TriageExpected;
  readonly actual: TriageExpected | null;
  readonly issues: readonly string[];
};

export type TriageEvalSummary = {
  readonly total: number;
  readonly valid: number;
  readonly invalid: number;
  readonly hits: number;
  readonly falsePositives: number;
  readonly missed: number;
  readonly withdrawalMissed: number;
  readonly withdrawalHits: number;
  readonly withdrawalExpected: number;
  readonly falsePositiveRate: number;
  readonly missedRate: number;
  readonly withdrawalHitRate: number;
  readonly results: readonly TriageFixtureResult[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function expectedFrom(value: unknown): TriageExpected | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'noop') return { kind: 'noop' };
  if (value.kind === 'emit' && typeof value.skill === 'string' && triageSkillById.has(value.skill as TriageSkillCard['id'])) {
    return { kind: 'emit', skill: value.skill as TriageSkillCard['id'] };
  }
  if ((value.kind === 'cancel' || value.kind === 'defer') && typeof value.todoId === 'string') {
    return { kind: value.kind, todoId: value.todoId };
  }
  if (value.kind === 'escalate' && (value.tier === 3 || value.tier === 4)) {
    return { kind: 'escalate', tier: value.tier };
  }
  return null;
}

export function loadTriageFixtures(value: unknown): readonly TriageFixture[] {
  if (!Array.isArray(value) || value.length < 20 || value.length > 30) {
    throw new Error('Triage fixtures must contain 20-30 scenarios');
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`fixture ${index} must be an object`);
    const { id, wakeSource, snapshot, response, expected } = item;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) throw new Error(`fixture ${index}.id is invalid`);
    if (seen.has(id)) throw new Error(`duplicate fixture id ${id}`);
    seen.add(id);
    if (typeof wakeSource !== 'string' || wakeSource.trim().length === 0) throw new Error(`${id}.wakeSource is required`);
    const parsedExpected = expectedFrom(expected);
    if (!parsedExpected) throw new Error(`${id}.expected is invalid`);
    return { id, wakeSource, snapshot, response, expected: parsedExpected };
  });
}

function actualFrom(response: TriageResponse): TriageExpected | null {
  const first = response.actions[0];
  if (!first) return null;
  if (first.kind === 'noop') return { kind: 'noop' };
  if (first.kind === 'emit_todo') return { kind: 'emit', skill: first.skill };
  if (first.kind === 'update_or_cancel_todo') {
    return first.operation === 'cancel' ? { kind: 'cancel', todoId: first.todoId } : { kind: 'defer', todoId: first.todoId };
  }
  if (first.kind === 'escalate_to_user') return { kind: 'escalate', tier: first.tier };
  return null;
}

function hasExtraAction(response: TriageResponse): boolean {
  return response.actions.length > 1;
}

function sameExpected(expected: TriageExpected, actual: TriageExpected | null): boolean {
  if (!actual) return false;
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === 'emit' && actual.kind === 'emit') return expected.skill === actual.skill;
  if ((expected.kind === 'cancel' || expected.kind === 'defer') && (actual.kind === 'cancel' || actual.kind === 'defer')) {
    return expected.todoId === actual.todoId;
  }
  if (expected.kind === 'escalate' && actual.kind === 'escalate') return expected.tier === actual.tier;
  return true;
}

function isWithdrawal(expected: TriageExpected): boolean {
  return expected.kind === 'cancel' || expected.kind === 'defer';
}

export function scoreTriageFixture(fixture: TriageFixture): TriageFixtureResult {
  let snapshot: TriageSnapshot;
  let response: TriageResponse;
  try {
    snapshot = parseTriageSnapshot(fixture.snapshot);
    response = parseTriageResponse(JSON.stringify(fixture.response), snapshot);
  } catch (error) {
    return {
      id: fixture.id,
      ok: false,
      classification: 'invalid',
      expected: fixture.expected,
      actual: null,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
  const actual = actualFrom(response);
  const ok = sameExpected(fixture.expected, actual) && !hasExtraAction(response);
  const classification = ok
    ? isWithdrawal(fixture.expected) ? 'withdrawal_hit' : 'hit'
    : isWithdrawal(fixture.expected)
      ? actual === null || actual.kind === 'noop' ? 'withdrawal_missed' : 'withdrawal_false_positive'
      : fixture.expected.kind === 'noop' ? 'false_positive' : 'missed';
  return { id: fixture.id, ok, classification, expected: fixture.expected, actual, issues: [] };
}

export function scoreTriageFixtures(fixtures: readonly TriageFixture[]): TriageEvalSummary {
  const results = fixtures.map(scoreTriageFixture);
  const valid = results.filter((result) => result.classification !== 'invalid').length;
  const hits = results.filter((result) => result.classification === 'hit').length;
  const falsePositives = results.filter((result) =>
    result.classification === 'false_positive' || result.classification === 'withdrawal_false_positive'
  ).length;
  const missed = results.filter((result) => result.classification === 'missed').length;
  const withdrawalMissed = results.filter((result) => result.classification === 'withdrawal_missed').length;
  const withdrawalHits = results.filter((result) => result.classification === 'withdrawal_hit').length;
  const withdrawalExpected = results.filter((result) => isWithdrawal(result.expected)).length;
  const actionable = hits + falsePositives + missed + withdrawalHits + withdrawalMissed;
  return {
    total: results.length,
    valid,
    invalid: results.length - valid,
    hits,
    falsePositives,
    missed,
    withdrawalMissed,
    withdrawalHits,
    withdrawalExpected,
    falsePositiveRate: actionable === 0 ? 0 : falsePositives / actionable,
    missedRate: actionable === 0 ? 0 : (missed + withdrawalMissed) / actionable,
    withdrawalHitRate: withdrawalExpected === 0
      ? 0
      : withdrawalHits / withdrawalExpected,
    results,
  };
}
