import { readFileSync } from 'node:fs';
import { assert, it } from 'vitest';
import { factId, type Revision } from '@mangekyo/kernel';
import { bindQuestionAssessment, matchesSelectionConstraint } from '../assessment-values.ts';
import { publicAnswerControls } from '../question-controls.ts';

it('binds independent selection rules to the frozen question and evaluates unseen compositions', () => {
  const question = JSON.parse(readFileSync(new URL('./two-voice-question.json', import.meta.url), 'utf8'));
  const ref = { id: factId('01KFS4AAA00000000000000000'), rev: 2 as Revision };
  const { criteria, slots } = bindQuestionAssessment(question.response_schema, question.assessment_contract, ref);
  assert.ok(publicAnswerControls(question.interaction, question.prompt, slots));
  question.interaction.sections[0].nodes[0].selected.push('bass-1');
  assert.equal(publicAnswerControls(question.interaction, question.prompt, slots), undefined);
  function check(bass: number[], snare: number[]) {
    const lanes = new Map([['bass', bass], ['snare', snare]]);
    return criteria.map(rule => matchesSelectionConstraint(rule, rule.inputs.map(({slotId}) => ({
      kind: 'structured', value: { kind: 'selection', ids: lanes.get(slotId)!.map(n => slotId + '-' + n) },
    }))));
  }
  assert.deepEqual(criteria[2]!.source, { kind: 'product-rubric', ref, path: '/assessment_contract/2' });
  assert.deepEqual(check([1, 3, 6], [1, 4, 8]), [true, true, true]);
  assert.deepEqual(check([8, 1, 7], [2, 3, 1]), [true, true, true]);
  assert.deepEqual(check([1, 3, 6], [1, 3, 8]), [true, true, false]);
  assert.throws(() => check([1, 1, 9], [1, 4, 8]));
});
