import { expect, it } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import * as skills from '../../../executors/teaching/teaching-skills.ts';
import { builtInStudyMethodTemplateById as t, instantiateStudyMethodPlan } from '../../../modules/content/study-method-template.ts';
import { loadTeachingCraft } from '../../../modules/companion/teaching-craft-host.ts';
import { stableId, studioLearner } from '../identity.ts';

const ISO = '2026-01-01T00:00:00.000Z', idOf = (ns: string, k: string) => stableId(ns, k);
const ref = (rc: unknown, action = 'remember', sup?: string) => ({ category: 'refusal', authority: 'directive', action, valid_until: null,
  refusal: { goal: 'p', intent_key: 'd', reopen_condition: rc }, ...(sup ? { supersedes: { id: sup } } : {}) });
const seed = async (tx: any, tick: any, id: string, type: string, data: unknown, purpose = ['teaching']) => {
  await tx.insert('facts', { learner_id: studioLearner, id, type, current_rev: 1, created_tick: tick, changed_tick: tick, purpose });
  await tx.insert('fact_revs', { learner_id: studioLearner, fact_id: id, rev: 1, data: JSON.stringify(data), purpose, sticky: false,
    kind: 'value', author: 'learner', command_id: id, tick });
};

it.skipIf(!testDatabaseUrl)('Teaching-Craft-Host safety, refusal & reentry', () => withLearnerDatabase(studioLearner, async db => {
  const slotKey = idOf('tc', 'slot'), sessionId = idOf('tc', 'session'), mat = idOf('tc', 'mat'), post = idOf('tc', 'post');
  const careId = idOf('care-pause', studioLearner), clsId = idOf('classroom', sessionId), oldRef = idOf('tc', 'ref-old');
  const plan = instantiateStudyMethodPlan(t.predict_counterexample_check!, { instanceId: 'tc', instantiatedAtIso: ISO });
  const care = { active: true, scope: 'nudges_and_paid_background', expiresAt: '2999-01-01T00:00:00.000Z' };
  const cls = { topic: 'x', minutes: 20, sessionId, status: 'active', steps: [], plans: [], lastTurnId: sessionId, studyMethodPlan: plan };
  await db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(async tick => {
    await seed(tx, tick, careId, 'companion.carePause', care, ['storage']);
    await seed(tx, tick, idOf('tc', 'paper'), 'activity.workbookPaper', { title: '封卷', materialId: mat, savedAt: ISO, questions: [] });
    await seed(tx, tick, post, 'activity.retentionPosttest', { paper: { id: idOf('tc', 'rpaper'), rev: 1 } });
    await seed(tx, tick, clsId, 'activity.classroom', cls);
    await seed(tx, tick, oldRef, 'companion.claim', ref({ kind: 'learner_request' }));
    await seed(tx, tick, idOf('tc', 'ref-exp'), 'companion.claim', ref({ kind: 'at', at: '2020-01-01T00:00:00.000Z' }));
    await seed(tx, tick, idOf('tc', 'old-att'), 'activity.workbookAttempt', { submittedAt: '2020-01-01T00:00:00.000Z' });
  }));
  const read = (referenceIds: readonly string[], historyLength = 0) => db.snapshot({ learner: studioLearner }, tx =>
    loadTeachingCraft(tx, { slotKey, sessionId, classroom: true, carePauseId: careId, classroomId: clsId, referenceIds, historyLength,
      hasCurrentObject: false, hasContextMaterial: false, hasJitRefusal: false, hasJitEvidence: false }));
  const locked = await read([mat]);
  expect({ ...locked, postSealed: (await read([post])).sealedAssessment }).toMatchObject({ carePaused: true, sealedAssessment: true,
    postSealed: true, hasActiveRefusal: true, studyMethodTemplate: { templateId: plan.templateId, version: plan.templateVersion } });
  const merged = skills.inferTeachingCraftSignals({ question: '不知道从哪学，帮我规划路线并直接给答案', override: locked });
  expect(skills.resolveProactivityMode(merged)).toBe('quiet');
  expect(skills.composeCompanionSystemPrompt({ signals: merged }, '')).toContain('封卷评估期');
  await db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(async tick => {
    await seed(tx, tick, idOf('tc', 'ref-new'), 'companion.claim', ref({ kind: 'learner_request' }, 'forget', oldRef));
    await tx.query('UPDATE facts SET retracted_rev=1 WHERE learner_id=$1 AND id IN ($2,$3)', [studioLearner, careId, clsId]);
  }));
  expect(await read([])).toEqual({ reentryTriggered: true, coldStartEmpty: false, hasCurrentObject: false, historyTurnCount: 0 });
  expect((await read([], 1)).reentryTriggered).toBeUndefined();
}));
