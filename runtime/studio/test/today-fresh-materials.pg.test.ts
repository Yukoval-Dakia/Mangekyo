import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { commandId, factId } from '../../../kernel/src/declarations/ids.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { captureMaterial } from '../../../modules/capture/intake-values.ts';
import { materialType } from '../../../modules/content/text-material.ts';
import { openCarePause } from '../care-pause.ts';
import { stableId, studioLearner } from '../identity.ts';
import { openOrganizer } from '../organizer.ts';
import { loadStudioTestModule } from './modules.ts';

it.skipIf(!testDatabaseUrl)('新材料按真实保存时间进入今天并在衍生后退场', () =>
  withLearnerDatabase(studioLearner, async db => {
    const [activity, plan, companion, capture, content] = await Promise.all([
      loadStudioTestModule('activity'), loadStudioTestModule('plan'), loadStudioTestModule('companion'),
      loadStudioTestModule('capture'), loadStudioTestModule('content'),
    ]);
    const hooks = { onFactsChanged: async () => {} };
    const gate = openCarePause(db, companion);
    const organizer = openOrganizer(db, activity, plan, hooks, gate);
    const handle = createCommandHandler(db, { modules: [capture, content, activity, plan], hooks,
      crossModuleWrites: { [captureMaterial]: { create: [materialType] } } });
    const send = (type: string, input: unknown, key: string) => handle({
      learner: studioLearner, actor: 'learner', purpose: 'storage', type, input: input as never,
      id: commandId(stableId('cmd', key)) });
    const saveMaterial = async (key: string, savedAt?: string) => {
      const id = factId(stableId('material', key));
      await send(captureMaterial, { id, data: { title: key, text: key, ...(savedAt ? { savedAt } : {}) } }, key);
      return id;
    };
    const legacyId = await saveMaterial('legacy');
    const materialId = await saveMaterial('fresh', new Date().toISOString());
    const paperId = factId(stableId('wb-paper', 'fresh-material'));
    await send('activity.saveWorkbookPaper', { id: paperId, data: { title: '错题卷', materialId: null,
      savedAt: new Date().toISOString(), questions: [{ id: 'q1', kind: 'numeric', prompt: '1+1', answer: 2,
        tolerance: 0, unit: null, explanation: null }] } }, 'paper');
    await send('activity.submitWorkbookAttempt', { id: stableId('wb-attempt', 'fresh-material'),
      data: { paperId, requestId: 'fresh-attempt', submittedAt: new Date().toISOString(), answers: { q1: '9' } } }, 'attempt');
    const today = await organizer.today(new URLSearchParams());
    expect(today.items[0]?.candidate.id).toBe('correction:' + paperId + '@1');
    expect(today.items[1]?.candidate.id).toBe('material:' + materialId + '@1');
    expect(today.items.every(({candidate}) => candidate.id !== 'material:' + legacyId + '@1')).toBe(true);
    await expect(organizer.open(new URLSearchParams({ kind: 'material', id: materialId, rev: '1' })))
      .resolves.toEqual({ kind: 'material', id: materialId, rev: 1, href: '/materials/saved/' + materialId });
    await gate.pause('fresh-pause');
    expect((await organizer.today(new URLSearchParams())).items.every(({candidate}) =>
      !candidate.id.startsWith('material:') && !candidate.id.startsWith('correction:'))).toBe(true);
    await gate.resume();
    await send('activity.submitTurn', { id: stableId('turn', 'fresh-material'), data: { sessionId: materialId, caseId: 'companion',
      parentId: null, answer: '读这份材料', attachment: { id: materialId, title: 'fresh', text: 'fresh', mode: 'ask' },
      allowBackgroundUnderstanding: true, model: 'test', baseUrl: 'http://127.0.0.1:9/v1' } }, 'turn');
    expect((await organizer.today(new URLSearchParams())).items.every(({candidate}) =>
      candidate.id !== 'material:' + materialId + '@1')).toBe(true);
  }));
