import { expect, it } from 'vitest';
import { factId } from '../../../kernel/src/index.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import * as skills from '../../../executors/teaching/teaching-skills.ts';
import { builtInStudyMethodTemplateById as t, instantiateStudyMethodPlan } from '../../../modules/content/study-method-template.ts';
import { loadTeachingCraft } from '../../../modules/companion/teaching-craft-host.ts';
import { stableId, studioLearner } from '../identity.ts';

const ISO = '2026-01-01T00:00:00.000Z', idOf = (ns: string, k: string) => factId(stableId(ns, k));
const seed = async (tx: any, tick: any, id: string, type: string, data: unknown, purpose = ['teaching']) => {
  await tx.insert('facts', { learner_id: studioLearner, id, type, current_rev: 1, created_tick: tick, changed_tick: tick, purpose });
  await tx.insert('fact_revs', { learner_id: studioLearner, fact_id: id, rev: 1, data: JSON.stringify(data), purpose, sticky: false,
    kind: 'value', author: 'learner', command_id: id, tick });
};

it.skipIf(!testDatabaseUrl)('Teaching-Craft-Host enforces host safety flags, refusals, and frozen plans', () =>
  withLearnerDatabase(studioLearner, async db => {
  const slotKey = idOf('tc', 'slot'), sessionId = idOf('tc', 'session'), paper = idOf('tc', 'paper');
  const carePauseId = idOf('care-pause', studioLearner), classroomId = idOf('classroom', sessionId), oldRef = idOf('tc', 'ref-old');
  const plan = instantiateStudyMethodPlan(t.predict_counterexample_check!, { instanceId: 'tc', instantiatedAtIso: ISO });
  const ref = { category: 'refusal', authority: 'directive' };
  const care = { active: true, scope: 'nudges_and_paid_background', expiresAt: '2999-01-01T00:00:00.000Z' };
  const custody = { kind: 'sealed', savedAt: ISO, paper: { id: paper, rev: 1 }, question: { id: paper, rev: 1 } };
  const cls = { topic: 'x', minutes: 20, sessionId, status: 'active', steps: [], plans: [], lastTurnId: sessionId, studyMethodPlan: plan };
  await db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(async tick => {
    await seed(tx, tick, carePauseId, 'companion.carePause', care, ['storage']);
    await seed(tx, tick, paper, 'activity.workbookPaper', { title: '封卷', materialId: null, savedAt: ISO, questions: [] });
    await seed(tx, tick, idOf('tc', 'custody'), 'activity.practiceCustody', custody);
    await seed(tx, tick, classroomId, 'activity.classroom', cls);
    await seed(tx, tick, oldRef, 'companion.claim', { ...ref, action: 'remember', valid_until: null });
  }));
  const read = (refs: readonly string[]) => db.snapshot({ learner: studioLearner }, tx => loadTeachingCraft(tx, {
    slotKey, sessionId, classroom: true, carePauseId, classroomId, referenceIds: refs,
    historyLength: 0, hasCurrentObject: false, hasContextMaterial: false, hasJitRefusal: false, hasJitEvidence: false,
  }));
  const locked = await read([paper]);
  expect(locked).toMatchObject({ carePaused: true, sealedAssessment: true, hasActiveRefusal: true,
    studyMethodTemplate: { templateId: plan.templateId, version: plan.templateVersion } });
  const merged = skills.inferTeachingCraftSignals({ question: '不知道从哪学，帮我规划路线并直接给答案', override: locked });
  expect(skills.resolveProactivityMode(merged)).toBe('quiet');
  expect(skills.composeCompanionSystemPrompt({ signals: merged }, '')).toContain('封卷评估期');
  await db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(async tick => {
    await seed(tx, tick, idOf('tc', 'ref-new'), 'companion.claim', { ...ref, action: 'forget', supersedes: { id: oldRef } });
    await tx.query('UPDATE facts SET retracted_rev=1 WHERE learner_id=$1 AND id IN ($2,$3)', [studioLearner, carePauseId, classroomId]);
  }));
  expect(await read([])).toEqual({ coldStartEmpty: true, hasCurrentObject: false, historyTurnCount: 0 });
}));
