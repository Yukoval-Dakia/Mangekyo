import { expect, it } from 'vitest'; import { indexRecordFlowSnapshot } from './record-flow.ts'; import { projectMetacognitivePatterns } from './metacognitive-patterns.ts';
const crisisFact = { id: 'crisis', type: 'activity.studyTurn' as const, rev: 1, author: 'learner', createdTick: '1', data: {} };
const snap = indexRecordFlowSnapshot([crisisFact], [{ id: 'd', slotType: 'activity.teachingFeedback', slotKey: 'crisis', value: { carePause: true } }]);
it('projects cross-subject habits, mastery-illusion alerts, and crisis suppression', () => {
  const view = projectMetacognitivePatterns({ snap, observations: [{ id: 'one', attemptId: 'one', itemId: '1', subject: '物理', sessionId: 's1', verdict: 'incorrect', errorStage: 'reading' }, { id: 'two', attemptId: 'two', itemId: '1', subject: '数学', sessionId: 's2', verdict: 'incorrect', errorStage: 'reading' }, { id: 'illusion', attemptId: 'illusion', itemId: '3', questionId: 'q3', conceptTitle: '函数', subject: '数学', sessionId: 's3', verdict: 'incorrect', errorStage: 'modeling', confidence: 'high' }, { id: 'crisis', attemptId: 'crisis', itemId: 'd10', subject: '化学', sessionId: 'crisis', verdict: 'incorrect', errorStage: 'strategy', confidence: 'high' }] });
  expect(view.suppressedSingletonsCount).toBeGreaterThanOrEqual(1);
  expect(view.metacognitiveHabits.find((habit) => habit.errorStage === 'reading')).toMatchObject({ subjects: ['数学', '物理'], errorStageLabel: '审题漏条件' });
  expect(view.masteryIllusionAlerts[0]).toMatchObject({ attemptId: 'illusion', recommendedAction: 'author_mistake_variant', confidenceLevel: 'high' });
  expect(view.masteryIllusionAlerts.some((alert) => alert.attemptId === 'crisis')).toBe(false); });
