import { factId, learnerId, type Revision, type Tick } from '@mangekyo/kernel';
import { expect, test } from 'vitest';
import { projectHelpExposure } from './help-exposure.ts';

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
