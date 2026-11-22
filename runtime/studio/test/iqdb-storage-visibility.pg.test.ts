import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { commandId, factId, type FactId } from '../../../kernel/src/declarations/ids.ts';
import type { Json } from '../../../kernel/src/declarations/types.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { intakeQuestionId } from '../../../modules/content/intake-question-bank.ts';
import { stableId, studioLearner } from '../identity.ts';
import { intakeWriteTargets } from '../intake.ts';
import { serve } from '../http.ts';
import { openIqdb } from '../iqdb.ts';
import { openWorkbook } from '../workbook.ts';
import { createStudioCommandHooks } from '../command-hooks.ts';
import { loadStudioTestModule } from './modules.ts';

const body = (input: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });

it.skipIf(!testDatabaseUrl)('shows storage questions without weakening teaching admission', () =>
  withLearnerDatabase(studioLearner, async db => {
    const [activity, capture, content] = await Promise.all(['activity', 'capture', 'content'].map(loadStudioTestModule));
    const handle = createCommandHandler(db, { modules: [activity!, capture!, content!], hooks: { async onFactsChanged() {} },
      crossModuleWrites: { ...intakeWriteTargets, 'activity.setWorkspaceTeaching': { set_purpose: ['activity.textMaterial', 'activity.intakeDocument'] } } });
    const send = (type: string, key: string, input: Json, purpose = 'storage') => handle({
      learner: studioLearner, actor: 'learner', purpose, id: commandId(stableId('iqdb-visibility', key)), type, input,
    });
    const materialId = factId(stableId('iqdb-material'));
    const intakeId = factId(stableId('intake-document', materialId));
    await send('activity.captureIntake', 'capture', { materialId, intakeId, title: '拍卷', original: { name: 'a.txt', mediaType: 'text/plain', size: 4, sha256: 'a'.repeat(64) }, extraction: { status: 'ok', method: 'utf8', text: 'storage 题干', error: null, warnings: [], pages: null, truncated: false, characterCount: 10 } });
    await send('content.confirmIntakeQuestions', 'question', { confirmedByLearner: true, materialId, expectedMaterialRev: 1, purpose: 'storage', items: [{ draftId: 'd1', title: '资产题', stem: 'storage 题干' }] });
    const questionId: FactId = await intakeQuestionId(materialId, 'd1');
    const iqdb = openIqdb(db, false, openWorkbook(db, activity!).issueBank, content!, createStudioCommandHooks(), activity!, capture!);
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    const server = serve(db, {} as never, {} as never, {} as never, { iqdb } as never, port);
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${port}`;
      const getQuestions = async () => await (await fetch(`${base}/api/iqdb/questions`)).json() as { questions: { id: string; rev: number; teachingAuthorized: boolean }[] };
    const post = (path: string, input: unknown) => fetch(`${base}${path}`, { method: 'POST', ...body(input) });
    const putTeaching = (input: unknown) => fetch(`${base}/api/iqdb/questions/${questionId}/teaching`, { method: 'PUT', ...body(input) });
    try {
      let listed = await getQuestions();
      expect(listed.questions).toContainEqual(expect.objectContaining({ id: questionId, rev: 1, teachingAuthorized: false }));
      const auto = await post('/api/iqdb/proposals', { requestId: 'auto-refs-0001', need: 'storage', durationMinutes: 10, coverage: [] });
      expect(auto.status).toBe(201);
      expect(await auto.json()).toMatchObject({ questionRefs: [], gaps: expect.arrayContaining(['no_matching_question']) });
      const explicit = await post('/api/iqdb/proposals', { requestId: 'explicit-refs01', need: 'storage', durationMinutes: 10, coverage: [], questionRefs: [{ id: questionId, rev: 1 }] });
      expect(explicit.status).toBe(201);
      expect(await explicit.json()).toMatchObject({ questionRefs: [], gaps: expect.arrayContaining(['question_unavailable']) });
      expect(await post('/api/iqdb/papers', { requestId: 'paper-source-001', sourceRef: { id: questionId, rev: 1 } })).toHaveProperty('status', 409);
      const denied = await putTeaching({ requestId: 'grant-00001', expectedRev: 1, allowed: true });
      expect(denied.status).toBe(409);
      expect((await putTeaching({ requestId: 'source-stale', expectedRev: 2, allowed: true, includeSourceMaterial: true })).status).toBe(409);
      expect(await db.snapshot({ learner: studioLearner }, tx => tx.query<{ purpose: string[] }>('SELECT purpose FROM facts WHERE learner_id=$1 AND id=$2', [studioLearner, materialId]))).toMatchObject({ rows: [{ purpose: ['storage'] }] });
      const linked = await putTeaching({ requestId: 'source-grant', expectedRev: 1, allowed: true, includeSourceMaterial: true });
      expect(linked.status).toBe(200);
      expect(await linked.json()).toMatchObject({ teachingAuthorized: true, changed: true, sourceMaterialAuthorized: true });
      const granted = await db.snapshot({ learner: studioLearner }, tx => tx.query<{ id: FactId; purpose: string[] }>('SELECT id, purpose FROM facts WHERE learner_id=$1 AND id=ANY($2)', [studioLearner, [materialId, intakeId]]));
      expect(granted.rows.map(row => row.purpose.includes('teaching'))).toEqual([true, true]);
      listed = await getQuestions();
      expect(listed.questions).toContainEqual(expect.objectContaining({ id: questionId, rev: 2, teachingAuthorized: true }));
      const taughtMaterial = await db.snapshot({ learner: studioLearner }, tx => tx.query<{ rev: number }>('SELECT current_rev AS rev FROM facts WHERE learner_id=$1 AND id=$2', [studioLearner, materialId])).then(({ rows }) => rows[0]!.rev);
      await send('content.saveQuestion', 'taught-question', { id: factId(stableId('iqdb-taught')), purpose: 'storage', asset: { kind: 'question', title: '授权题', promptBlockId: 'p', basis: [{ id: materialId, rev: taughtMaterial, epoch: '1', type: 'activity.textMaterial' }], blocks: [{ id: 'p', parentId: null, body: { kind: 'text', text: '可授权题干' } }] } });
      const taughtId = factId(stableId('iqdb-taught'));
      const grant = await fetch(`${base}/api/iqdb/questions/${taughtId}/teaching`, { method: 'PUT', ...body({ requestId: 'grant-00002', expectedRev: 1, allowed: true }) });
      expect(grant.status).toBe(200);
      expect(await grant.json()).toMatchObject({ id: taughtId, rev: 2, teachingAuthorized: true, changed: true });
      listed = await getQuestions();
      expect(listed.questions).toContainEqual(expect.objectContaining({ id: taughtId, rev: 2, teachingAuthorized: true }));
      const revoke = await fetch(`${base}/api/iqdb/questions/${taughtId}/teaching`, { method: 'PUT', ...body({ requestId: 'revoke-0001', expectedRev: 2, allowed: false }) });
      expect(revoke.status).toBe(200);
      expect(await revoke.json()).toMatchObject({ id: taughtId, rev: 3, teachingAuthorized: false, changed: true });
      const materialRev = await db.snapshot({ learner: studioLearner }, tx => tx.query<{ rev: number }>('SELECT current_rev AS rev FROM facts WHERE learner_id=$1 AND id=$2', [studioLearner, materialId])).then(({ rows }) => rows[0]!.rev);
      await send('activity.setWorkspaceTeaching', 'material-unlearn', { id: materialId, expectedRev: materialRev, enabled: false });
      listed = await getQuestions();
      expect(listed.questions).toContainEqual(expect.objectContaining({ id: taughtId, rev: 3, teachingAuthorized: false }));
    } finally { server.close(); }
  }));
