import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { commandId, derivationId, factId, type Tick } from '../../../kernel/src/declarations/ids.ts';
import { storeSettledValue } from '../../../kernel/src/derivations/settled-value.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { openCarePause } from '../care-pause.ts';
import { stableId, studioLearner } from '../identity.ts';
import { openOrganizer } from '../organizer.ts';
import { loadStudioTestModule } from './modules.ts';
import { workbookRubricAssessmentVersion, workbookRubricVersion } from '../../../modules/activity/workbook-values.ts';

it.skipIf(!testDatabaseUrl)('已提交试卷的未订正错题流向今天、订正后退场、照护暂停时诚实抑制', () =>
  withLearnerDatabase(studioLearner, async db => {
    const activity = await loadStudioTestModule('activity');
    const plan = await loadStudioTestModule('plan');
    const companion = await loadStudioTestModule('companion');
    const hooks = { onFactsChanged: async () => {} };
    const gate = openCarePause(db, companion);
    const organizer = openOrganizer(db, activity, plan, hooks, gate);
    const handle = createCommandHandler(db, { modules: [activity, plan], hooks });
    const req = (type: string, input: unknown, id: string) =>
      ({ learner: studioLearner, type, input: input as never, actor: 'learner' as const, purpose: 'storage', id: commandId(id) });
    const today = () => organizer.today(new URLSearchParams());

    const paperId = factId(stableId('wb-paper', 'pending-corrections'));
    await handle(req('activity.saveWorkbookPaper',
      { id: paperId, data: { title: '订正卷', materialId: null, savedAt: new Date().toISOString(),
        questions: [{ id: 'q1', kind: 'numeric', prompt: '1 + 1 = ?', answer: 2, tolerance: 0, unit: null, explanation: null }, { id: 'q2', kind: 'rubric', prompt: '解释等式', rubric: '说明算理', rubricVersion: workbookRubricVersion, explanation: null }] } },
      stableId('cmd', 'paper')));
    const attemptReceipt = await handle(req('activity.submitWorkbookAttempt',
      { id: stableId('wb-attempt', 'pending-corrections'),
        data: { paperId, requestId: 'pc-attempt-1', submittedAt: new Date().toISOString(), answers: { q1: '9', q2: '接近' } } },
      stableId('cmd', 'attempt')));
    const attempt = attemptReceipt.wrote[0]!;
    const gradeId = derivationId(stableId('wb-rubric', 'pending-corrections'));
    await db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(async tick => {
      const inputs = [attempt.id, paperId].map(id => ({kind: 'fact' as const, id, rev: 1, accessEpoch: '0' as Tick, mode: 'pinned' as const}));
      await storeSettledValue(tx, tick, {
        kind: 'publish', previous: null, id: gradeId, slotType: 'activity.workbookRubricAssessment', key: gradeId,
        deriver: workbookRubricAssessmentVersion, scope: { paperId, attemptId: attempt.id },
        value: { paperId, attemptId: attempt.id, questionId: 'q2', requestId: 'pc-rubric', assessedAt: new Date().toISOString(), assessmentVersion: workbookRubricAssessmentVersion, rubricVersion: workbookRubricVersion, rubric: '说明算理',
          providerBaseUrl: 'fixture', verdict: 'partial', feedback: '不完整', evidence: ['接近'], trace: [] },
        manifest: { version: 1, learner: studioLearner, purpose: 'storage', gatherTick: tick, inputs },
      }, { onSlotChanged: async () => {} });
    }));
    // 首荐为未订正错题候选，压过示例包；可直接打开原卷。
    const first = await today();
    expect(first.items[0]?.candidate.id).toBe('correction:' + paperId + '@1');
    expect(first.items[0]?.candidate.pendingCorrection)
      .toMatchObject({ incorrectCount: 1, partialCount: 1, itemIds: ['q1', 'q2'], attemptId: attempt.id, attemptRev: attempt.rev });
    expect(first.items[0]?.why.join(' ')).toContain('未订正');
    expect(first.items[0]?.candidate.open).toEqual({ kind: 'activity', id: paperId, rev: 1 });
    await expect(organizer.open(new URLSearchParams({ kind: 'activity', id: paperId, rev: '1' })))
      .resolves.toEqual({ kind: 'activity', id: paperId, rev: 1, href: '/papers/' + paperId });

    // 照护暂停激活时，主动推荐被诚实抑制并标注 paused。
    await gate.pause('pc-pause');
    const paused = await today();
    expect(paused.paused).toBe(true);
    expect(paused.items.every(item => item.candidate.id.startsWith('pack/'))).toBe(true);
    expect(paused.items.some(item => item.candidate.id.startsWith('correction:'))).toBe(false);
    await gate.resume();

    // 写入对应题位订正后，候选自动退场、诚实降级。
    await handle(req('activity.recordWorkbookCorrection',
      { id: stableId('wb-correction', 'pending-corrections'),
        data: { paperId, attempt: { id: attempt.id, rev: attempt.rev }, itemId: 'q1' } },
      stableId('cmd', 'correction')));
    await handle(req('activity.recordWorkbookCorrection', { id: stableId('wb-correction', 'pending-corrections-rubric'), data: { paperId, attempt: { id: attempt.id, rev: attempt.rev }, itemId: 'q2' } }, stableId('cmd', 'correction-rubric')));
    const cleared = await today();
    expect(cleared.items.every(item => !item.candidate.id.startsWith('correction:'))).toBe(true);
  }));
