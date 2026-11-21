import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { scoutReceipt } from '../../../executors/temporal/src/research-scout.ts';
import { researchDecision, reviewAction, noop, response } from '../../../modules/companion/research-triage-policy.ts';
import { loadTriageFixtures, scoreTriageFixture, scoreTriageFixtures } from '../research-triage/fixtures.ts';
import { parseTriageResponse, TriageResponseError } from '../research-triage/response.ts';
import { parseTriageSnapshot } from '../research-triage/snapshot.ts';
import { selectTriageCards, triageSkillCards, triagePromptBlock } from '../research-triage/skills.ts';

const fixtureUrl = new URL('../research-triage/fixtures.json', import.meta.url);
const validResponse = response(noop);

const firstTodo = '01K7TRJAGE0000000000000001';
const secondTodo = '01K7TRJAGE0000000000000002';

const todo = (id: string, goal: string) => ({ todo_id: id, dedup_key: 'todo:' + goal,
  status: 'pending', trigger: 'immediate', source_fact_rev: '1', autonomy_tier: 1,
  worker_profile: 'deterministic_compute', goal });

function snapshotWithTodos(todos: Record<string, ReturnType<typeof todo>> = { [firstTodo]: todo(firstTodo, 'one') }) {
  return {
    facts: {}, events: {}, todos, inventory: {}, forecasts: {}, work: {}, memos: {}, signals: {},
    chain: { id: 'chain', hop_count: '0', budget_remaining: '1' },
    budget: { remaining: '1', unit: 'usd' },
  };
}

describe('research triage cards', () => {
  it('ships six cards with five sections and fixed examples', () => {
    expect(triageSkillCards).toHaveLength(6);
    for (const card of triageSkillCards) {
      for (const section of [card.when, card.whenNot, card.mustCheck, card.examples.negative, card.todoTemplate.refs])
        expect(section.length).toBeGreaterThan(0);
      expect(card.examples.positive).toHaveLength(2);
    }
  });

  it('selects two to three cards for a wake source', () => {
    expect(selectTriageCards('attempt_submitted')).toHaveLength(3);
    expect([2, 3]).toContain(selectTriageCards('forecast forgetting review').length);
    expect(typeof triagePromptBlock('undo retract')).toBe('object');
  });
});

describe('research triage response validation', () => {
  it('accepts a strict noop with a real kernel initial access_epoch of 0', () => {
    const id = '01K7TRJAGE0000000000000009';
    const snapshot = parseTriageSnapshot({
      ...snapshotWithTodos(),
      facts: {
        [id]: { id, rev: 1, fact_type: 'activity.studyGoal', access_epoch: '0',
          purpose: 'storage', retracted_rev: 0, data: { text: 'initial' } },
      },
    });
    expect(Object.keys(snapshot.facts)).toEqual([id]);
    expect(parseTriageResponse(JSON.stringify(validResponse), snapshot).actions).toEqual([{ kind: 'noop' }]);
  });

  it('rejects IDs outside the snapshot and expression-like fields', () => {
    const snapshot = parseTriageSnapshot(snapshotWithTodos());
    for (const action of [
      { kind: 'update_or_cancel_todo', todo_id: '01K7TRJAGE00000000000000FF', operation: 'cancel', reason: 'x' },
      { kind: 'noop', expression: 'facts.current_rev = 2' },
    ]) expect(() => parseTriageResponse(JSON.stringify({...validResponse, actions:[action]}), snapshot)).toThrow(TriageResponseError);
  });

  it('scores a correct first action plus an extra wrong action as false positive', () => {
    const snapshot = snapshotWithTodos({ [firstTodo]: todo(firstTodo, 'one'), [secondTodo]: todo(secondTodo, 'two') });
    const result = scoreTriageFixture({
      id: 'extra-wrong-action',
      wakeSource: 'undo retract',
      snapshot,
      response: {
        ...validResponse,
        matched_skill: 'defer_or_cancel_on_fatigue_or_undo',
        actions: [firstTodo,secondTodo].map(todo_id => ({kind:'update_or_cancel_todo',todo_id,operation:'cancel',reason:'cancel'})),
      },
      expected: { kind: 'cancel', todoId: '01K7TRJAGE0000000000000001' },
    });
    expect(result).toMatchObject({ok:false,classification:'withdrawal_false_positive'});
  });
});

it('golden admits only the selected Scout action within the current paid menu', () => {
  const snapshot = parseTriageSnapshot(snapshotWithTodos());
  const review = reviewAction(firstTodo, 'heavy_tutor_prep');
  const comparison = reviewAction(firstTodo, 'deep_analyst');
  const variant = reviewAction(firstTodo, 'question_author');
  const cases = [
    ['tutor prep', review, response(review), 1, 'review'],
    ['comparison', comparison, response(comparison), 1, 'review'],
    ['verified variant', variant, response(variant), 1, 'review'],
    ['declined offer', review, validResponse, 1, 'noop'],
    ['empty menu', undefined, validResponse, 1, 'noop'],
    ['unoffered action', undefined, response(review), 1, 'invalid_reply'],
    ['different source', review, response({...review, source_fact_id:secondTodo}), 1, 'invalid_reply'],
    ['different profile', review, response(comparison), 1, 'invalid_reply'],
    ['extra action', review, {...validResponse, actions:[review,noop]}, 1, 'invalid_reply'],
    ['altered action', review, {...validResponse, actions:[{...review,budget_cap:0}]}, 1, 'invalid_reply'],
    ['empty actions', review, {...validResponse, actions:[]}, 1, 'invalid_reply'],
    ['truncated JSON', review, '{"actions":', 1, 'invalid_reply'],
    ['oversize reply', review, ' '.repeat(8193) + JSON.stringify(response(review)), 1, 'invalid_reply'],
    ['above quoted hard cap', review, response(review), 2, 'price_exceeded'],
    ['unknown charge', review, response(review), undefined, 'review'],
  ] as const;
  const results = cases.map(([id, action, body, actualUsdMicros, expected]) => {
    const reply = typeof body === 'string' ? body : JSON.stringify(body);
    const receipt = scoutReceipt({reply, ...(actualUsdMicros === undefined ? {} : {actualUsdMicros})},
      1, raw => researchDecision({snapshot,action},raw));
    return {id, expected, ...receipt, passed:receipt.decision === expected && receipt.actualUsdMicros === (actualUsdMicros ?? null)};
  });
  expect(results.filter(row => row.passed), JSON.stringify(results)).toHaveLength(15);
});

describe('research triage fixtures', () => {
  it('loads 20-30 scenarios and reports the bundled simulated eval', async () => {
    const fixtures = loadTriageFixtures(JSON.parse(await readFile(fixtureUrl, 'utf8')));
    const summary = scoreTriageFixtures(fixtures);
    expect(summary).toMatchObject({total:fixtures.length,invalid:2,falsePositives:1,missed:1,withdrawalHits:3,withdrawalExpected:4});
    expect(summary.falsePositiveRate).toBeCloseTo(1 / 28);
    expect(summary.missedRate).toBeCloseTo(1 / 28);
    expect(summary.withdrawalHitRate).toBeCloseTo(3 / 4);
  });
});
