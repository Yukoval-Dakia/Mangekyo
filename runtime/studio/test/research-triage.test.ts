import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTriageFixtures, scoreTriageFixtures } from '../research-triage/fixtures.ts';
import { scoreTriageFixture, type TriageFixture } from '../research-triage/fixtures.ts';
import { parseTriageResponse, TriageResponseError } from '../research-triage/response.ts';
import { parseTriageSnapshot } from '../research-triage/snapshot.ts';
import { selectTriageCards, triageSkillCards, triagePromptBlock } from '../research-triage/skills.ts';

const fixtureUrl = new URL('../research-triage/fixtures.json', import.meta.url);
const validResponse = {
  matched_skill: null,
  reason_brief: 'no change',
  actions: [{ kind: 'noop' }],
  memo_table: [],
  next_recheck_hint: null,
};

function snapshotWithTodo() {
  return {
    facts: {},
    events: {},
    todos: {
      '01K7TRJAGE0000000000000001': {
        todo_id: '01K7TRJAGE0000000000000001',
        dedup_key: 'todo:one',
        status: 'pending',
        trigger: 'immediate',
        source_fact_rev: '1',
        autonomy_tier: 1,
        worker_profile: 'deterministic_compute',
        goal: 'one',
      },
    },
    inventory: {},
    forecasts: {},
    work: {},
    memos: {},
    signals: {},
    chain: { id: 'chain', hop_count: '0', budget_remaining: '1' },
    budget: { remaining: '1', unit: 'usd' },
  };
}

function snapshotWithTwoTodos() {
  return {
    facts: {},
    events: {},
    todos: {
      '01K7TRJAGE0000000000000001': {
        todo_id: '01K7TRJAGE0000000000000001',
        dedup_key: 'todo:one',
        status: 'pending',
        trigger: 'immediate',
        source_fact_rev: '1',
        autonomy_tier: 1,
        worker_profile: 'deterministic_compute',
        goal: 'one',
      },
      '01K7TRJAGE0000000000000002': {
        todo_id: '01K7TRJAGE0000000000000002',
        dedup_key: 'todo:two',
        status: 'pending',
        trigger: 'immediate',
        source_fact_rev: '1',
        autonomy_tier: 1,
        worker_profile: 'deterministic_compute',
        goal: 'two',
      },
    },
    inventory: {},
    forecasts: {},
    work: {},
    memos: {},
    signals: {},
    chain: { id: 'chain', hop_count: '0', budget_remaining: '1' },
    budget: { remaining: '1', unit: 'usd' },
  };
}

describe('research triage cards', () => {
  it('ships six cards with five sections and fixed examples', () => {
    expect(triageSkillCards).toHaveLength(6);
    for (const card of triageSkillCards) {
      expect(card.when.length).toBeGreaterThan(0);
      expect(card.whenNot.length).toBeGreaterThan(0);
      expect(card.mustCheck.length).toBeGreaterThan(0);
      expect(card.examples.positive).toHaveLength(2);
      expect(card.examples.negative.length).toBeGreaterThan(0);
      expect(card.todoTemplate.refs.length).toBeGreaterThan(0);
    }
  });

  it('selects two to three cards for a wake source', () => {
    expect(selectTriageCards('attempt_submitted')).toHaveLength(3);
    expect(selectTriageCards('forecast forgetting review').length).toBeGreaterThanOrEqual(2);
    expect(selectTriageCards('forecast forgetting review').length).toBeLessThanOrEqual(3);
    const prompt = triagePromptBlock('undo retract');
    expect(typeof prompt).toBe('object');
  });
});

describe('research triage response validation', () => {
  it('accepts a strict noop response', () => {
    const snapshot = parseTriageSnapshot(snapshotWithTodo());
    expect(parseTriageResponse(JSON.stringify(validResponse), snapshot).actions).toEqual([{ kind: 'noop' }]);
  });

  it('accepts the real kernel initial access_epoch 0 decimal string', () => {
    const snapshot = parseTriageSnapshot({
      ...snapshotWithTodo(),
      facts: {
        '01K7TRJAGE0000000000000009': {
          id: '01K7TRJAGE0000000000000009',
          rev: 1,
          fact_type: 'activity.studyGoal',
          access_epoch: '0',
          purpose: 'storage',
          retracted_rev: 0,
          data: { text: 'initial' },
        },
      },
    });
    expect(Object.keys(snapshot.facts)).toEqual(['01K7TRJAGE0000000000000009']);
    expect(parseTriageResponse(JSON.stringify(validResponse), snapshot).actions).toEqual([{ kind: 'noop' }]);
  });

  it('rejects IDs outside the snapshot and expression-like fields', () => {
    const snapshot = parseTriageSnapshot(snapshotWithTodo());
    const outside = {
      ...validResponse,
      actions: [{ kind: 'update_or_cancel_todo', todo_id: '01K7TRJAGE00000000000000FF', operation: 'cancel', reason: 'x' }],
    };
    expect(() => parseTriageResponse(JSON.stringify(outside), snapshot)).toThrow(TriageResponseError);
    const expression = {
      ...validResponse,
      actions: [{ kind: 'noop', expression: 'facts.current_rev = 2' }],
    };
    expect(() => parseTriageResponse(JSON.stringify(expression), snapshot)).toThrow(TriageResponseError);
  });

  it('scores a correct first action plus an extra wrong action as false positive', () => {
    const snapshot = snapshotWithTwoTodos();
    const fixture: TriageFixture = {
      id: 'extra-wrong-action',
      wakeSource: 'undo retract',
      snapshot,
      response: {
        matched_skill: 'defer_or_cancel_on_fatigue_or_undo',
        reason_brief: 'cancel the affected todo',
        actions: [
          { kind: 'update_or_cancel_todo', todo_id: '01K7TRJAGE0000000000000001', operation: 'cancel', reason: 'affected' },
          { kind: 'update_or_cancel_todo', todo_id: '01K7TRJAGE0000000000000002', operation: 'cancel', reason: 'unrelated' },
        ],
        memo_table: [],
        next_recheck_hint: null,
      },
      expected: { kind: 'cancel', todoId: '01K7TRJAGE0000000000000001' },
    };
    const result = scoreTriageFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.classification).toBe('withdrawal_false_positive');
  });
});

describe('research triage fixtures', () => {
  it('loads 20-30 scenarios and reports the bundled simulated eval', async () => {
    const fixtures = loadTriageFixtures(JSON.parse(await readFile(fileURLToPath(fixtureUrl), 'utf8')));
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    expect(fixtures.length).toBeLessThanOrEqual(30);
    const summary = scoreTriageFixtures(fixtures);
    expect(summary.total).toBe(fixtures.length);
    expect(summary.invalid).toBe(2);
    expect(summary.falsePositives).toBe(1);
    expect(summary.missed).toBe(1);
    expect(summary.withdrawalHits).toBe(3);
    expect(summary.withdrawalExpected).toBe(4);
    expect(summary.falsePositiveRate).toBeCloseTo(1 / 28);
    expect(summary.missedRate).toBeCloseTo(1 / 28);
    expect(summary.withdrawalHitRate).toBeCloseTo(3 / 4);
  });
});
