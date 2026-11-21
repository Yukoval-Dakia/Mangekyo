import { factId, learnerId, type Revision, type Tick } from '@mangekyo/kernel';
import { expect, test } from 'vitest';
import { activityEvidenceSlice, activityHelpProcess } from './evidence-slice.ts';
import { projectHelpExposure } from './help-exposure.ts';
import { helpExposure } from './help-exposure-values.ts';

const ref = (id: string) => ({ id: factId(id.padStart(26, '0')), rev: 1 as Revision });
const learner = learnerId(ref('1').id);
const mount = { activityId: ref('2').id, issuance: ref('3'), item: { itemId: 'first' } };
const target = { ...mount, item: { itemId: 'second' } };
const submission = { ref: { learner, ...ref('4') }, target, cutoff: '10' as Tick };
const coverage = { submission: submission.ref, target, through: submission.cutoff };
const example = { mount, alsoAppliesTo: [target.item], content: ref('5'), step: { kind: 'worked-example', order: 1 } } as const;
const shown = { ref: { learner, ...ref('6') }, value: { ...example, kind: 'displayed' as const }, admittedAt: '9' as Tick };
const late = { ...shown, ref: { learner, ...ref('7') }, admittedAt: '11' as Tick };
const prepared = { ...shown, ref: { learner, ...ref('8') }, value: { ...example, kind: 'prepared' as const } };

test('按实际展示的范围、录入顺序和观测覆盖投影证据', () => {
  expect(projectHelpExposure({ submission, coverage, events: [prepared, shown, shown, late] }))
    .toEqual({ kind: 'exposed', evidenceRefs: [shown.ref] });
  expect(projectHelpExposure({ submission, coverage, events: [prepared, late] }).kind).toBe('unexposed');
  expect(projectHelpExposure({ submission, coverage: null, events: [] }).kind).toBe('unknown');
});

test('分级切片只使用交卷之前实际绘制的提示档次', () => {
  const first = { ...shown, value: helpExposure({ ...example, kind: 'displayed', step: { kind: 'hint_l1', order: 1 } }) };
  const second = { ...shown, ref: late.ref,
    value: helpExposure({ ...example, kind: 'displayed', step: { kind: 'hint_l2', order: 2 } }) };
  const project = (events: typeof first[]) => activityHelpProcess(projectHelpExposure({ submission, coverage, events }), events);
  expect(project([first, { ...second, admittedAt: late.admittedAt }]).helpLevel).toBe('hint_l1');
  const process = project([first, second]);
  expect(process.exposure).toMatchObject({ kind: 'exposed', level: 'hint_l2' });
  const occurredAt = '2026-11-21T00:00:00.000Z';
  expect(activityEvidenceSlice(submission.cutoff, occurredAt, undefined, [{
    submission: submission.ref, occurredAt, concepts: [], novelty: 'same', helpLevel: process.helpLevel, result: 'correct',
  }]).events[0]?.help_level).toBe('hint_l2');
  expect(project([shown]).helpLevel).toBe('hinted');
  const answer = { ...shown, ref: prepared.ref, value: helpExposure({ ...example, kind: 'displayed', step: { kind: 'solution', order: 3 } }) };
  expect(project([first, second, answer]).helpLevel).toBe('solution_seen');
  expect(() => helpExposure({ ...example, kind: 'displayed', step: { kind: 'hint_l1', order: 2 } })).toThrow('档次与阶次');
});
