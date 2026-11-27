import { expect, it } from 'vitest';
import { factId } from '../../../kernel/src/index.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { builtInStudyMethodTemplateById, instantiateStudyMethodPlan } from '../../../modules/content/study-method-template.ts';
import { loadTeachingCraft } from '../../../modules/companion/teaching-craft-host.ts';
import { stableId, studioLearner } from '../identity.ts';

async function fact(tx: any, tick: any, id: string, type: string, data: unknown, uses = ['teaching']) {
  await tx.insert('facts', { learner_id: studioLearner, id, type, current_rev: 1, created_tick: tick, changed_tick: tick, purpose: uses });
  await tx.insert('fact_revs', { learner_id: studioLearner, fact_id: id, rev: 1, data: JSON.stringify(data), purpose: uses,
    sticky: false, kind: 'value', author: 'learner', command_id: id, tick });
}

it.skipIf(!testDatabaseUrl)('Teaching-Craft-Host preserves safety, frozen plans, and refusal successors', () =>
  withLearnerDatabase(studioLearner, async db => {
  const slotKey = factId(stableId('tc-host', 'slot')), sessionId = factId(stableId('tc-host', 'session'));
  const paper = factId(stableId('tc-host', 'paper')), carePauseId = factId(stableId('care-pause', studioLearner));
  const classroomId = factId(stableId('classroom', sessionId)), oldRefusal = factId(stableId('tc-host', 'refusal-old'));
  const plan = instantiateStudyMethodPlan(builtInStudyMethodTemplateById.predict_counterexample_check!, {
    instanceId: 'tc-plan', instantiatedAtIso: '2026-01-01T00:00:00.000Z',
  });
  await db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(async tick => {
    await fact(tx, tick, carePauseId, 'companion.carePause', { active: true, scope: 'nudges_and_paid_background',
      expiresAt: '2999-01-01T00:00:00.000Z' }, ['storage']);
    await fact(tx, tick, paper, 'activity.workbookPaper', { title: '封卷', materialId: null,
      savedAt: '2026-01-01T00:00:00.000Z', questions: [] });
    await fact(tx, tick, factId(stableId('tc-host', 'custody')), 'activity.practiceCustody', {
      kind: 'sealed', savedAt: '2026-01-01T00:00:00.000Z', paper: { id: paper, rev: 1 }, question: { id: paper, rev: 1 },
    });
    await fact(tx, tick, classroomId, 'activity.classroom', { topic: 'x', minutes: 20, sessionId, status: 'active',
      steps: [], plans: [], lastTurnId: sessionId, studyMethodPlan: plan });
    await fact(tx, tick, oldRefusal, 'companion.claim', {
      category: 'refusal', authority: 'directive', action: 'remember', valid_until: null,
    });
  }));
  const input = { slotKey, sessionId, classroom: true, referenceIds: [paper], carePauseId, classroomId,
    historyLength: 0, hasCurrentObject: false, hasContextMaterial: false, hasJitRefusal: false };
  const read = () => db.snapshot({ learner: studioLearner }, tx => loadTeachingCraft(tx, input));
  await expect(db.snapshot({ learner: studioLearner }, tx => loadTeachingCraft(tx, input))).resolves.toMatchObject({
    carePaused: true, sealedAssessment: true, hasActiveRefusal: true,
    studyMethodTemplate: { templateId: plan.templateId, version: plan.templateVersion },
  });
  await db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(async tick => fact(tx, tick,
    factId(stableId('tc-host', 'refusal-new')), 'companion.claim', { category: 'refusal', authority: 'directive',
      action: 'forget', supersedes: { id: oldRefusal } })));
  await expect(read()).resolves.toMatchObject({ hasActiveRefusal: undefined });
}));
