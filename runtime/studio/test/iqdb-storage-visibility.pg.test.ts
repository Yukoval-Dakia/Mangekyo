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
import { openIqdb, selectionEvidenceRows } from '../iqdb.ts'; import { isCanonicalEvidenceSlice } from '../../../executors/python-deriver/schema.ts';
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
    const wb = openWorkbook(db, activity!); let llmCalls = 0;
    const iqdb = openIqdb(db, false, wb.issueBank, content!, createStudioCommandHooks(), activity!, capture!, { savePaper: wb.save,
      loadProvider: async () => ({ baseUrl: 'http://127.0.0.1:3425/v1', model: 'm', protocol: 'openai', reasoningEffort: 'low', apiKey: '',
        activeProviderId: 'm', providers: [], mcpServers: [], exaApiKey: '', allowSearch: false }),
      authorQuestions: async () => (llmCalls += 1, { questions: [{ mode: 'mistake_variant', title: '变式',
        prompt: '若 f(x)=3x，求 x->1 极限。', answer: '3', explanation: '代入连续函数。', rubric: ['代入'], difficulty: 'standard',
        hints: ['看连续性', '代入 x=1', '计算得 3'], conceptIds: [], sourceIds: [],
        verification: { status: 'verified', method: 'dual_solve_and_python', pythonChecked: true, solverAnswers: ['3', '3'] } }],
      usage: { model: 'm', durationMs: 1 } }) });
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
      const q2 = factId(stableId('iqdb-src2'));
      await send('content.saveQuestion', 'src2-q', { id: q2, purpose: 'teaching', asset: { kind: 'question', title: '原题二',
        promptBlockId: 'p', basis: [{ id: materialId, rev: taughtMaterial, epoch: '1', type: 'activity.textMaterial' }],
        blocks: [{ id: 'p', parentId: null, body: { kind: 'text', text: '若 f(x)=2x，求 x->1 极限。' } }] } }, 'teaching');
      await send('content.createKnowledgeEdge', 'vp-edge', { id: factId(stableId('vp-edge')), purpose: 'teaching', edge: { kind: 'variant_of',
        from: { kind: 'question', sourceUse: { id: taughtId, rev: 2, accessEpoch: '1' } },
        to: { kind: 'question', sourceUse: { id: q2, rev: 1, accessEpoch: '0' } },
        sourceUses: [{ id: taughtId, rev: 2, accessEpoch: '1' }, { id: q2, rev: 1, accessEpoch: '0' }], scope: '同条件',
        variant: { familyId: q2, relation: 'single_condition', preserved: ['p'], changed: ['c'], spoilsNext: 'none' } } }, 'teaching');
      const poolRes = await post('/api/iqdb/author', {
        requestId: 'auth-pool-0001', mode: 'mistake_variant', sourceQuestionId: q2, issuePaper: true });
      expect(await poolRes.json()).toMatchObject({
        source: 'variant_pool', questions: [{ id: taughtId }], paperId: expect.any(String) });
      const aiRes = await post('/api/iqdb/author', {
        requestId: 'auth-ai-00001', mode: 'mistake_variant', sourceQuestionId: q2, forceGenerate: true, issuePaper: true });
      const aiBody = await aiRes.json() as { questions: { id: string }[] };
      expect(aiBody).toMatchObject({
        source: 'ai_authored', questions: [{ verification: { status: 'verified', pythonChecked: true } }], paperId: expect.any(String) });
      const meta = await db.snapshot({ learner: studioLearner }, tx => tx.query<{ data: any }>(
        `SELECT r.data FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
         WHERE f.learner_id=$1 AND f.type='content.questionMetaDraft' AND r.data->>'id'=$2`, [studioLearner, aiBody.questions[0]!.id]));
      expect(meta.rows[0]?.data.append_metadata).toMatchObject({ hint_ladder: { l1: '看连续性' },
        solutions: [{ explanation: expect.stringContaining('独立验算') }], tags: expect.any(Array) });
      expect(llmCalls).toBe(1);
      // 无概念映射的题库题按关键词兼容召回；同请求标识重放原子一致；interactive 不被纯文字变式池拦截。
      const unmapped = await post('/api/iqdb/proposals', { requestId: 'unmapped-kw-01', need: '极限', durationMinutes: 10, coverage: [] });
      expect(await unmapped.json()).toMatchObject({ questionRefs: expect.arrayContaining([expect.objectContaining({ id: q2 })]) });
      expect(await post('/api/iqdb/proposals', { requestId: 'unmapped-kw-01', need: '极限', durationMinutes: 10, coverage: [] })
        .then(result => result.json())).toMatchObject({ questionRefs: expect.arrayContaining([expect.objectContaining({ id: q2 })]) });
      const interactive = await post('/api/iqdb/author', { requestId: 'auth-inter-001', mode: 'mistake_variant', sourceQuestionId: q2, format: 'interactive' });
      expect(llmCalls).toBe(2);
      await send('activity.setWorkspaceTeaching', 'source-revoke', { id: materialId, expectedRev: 2, enabled: false });
      listed = await getQuestions();
      expect(listed.questions).toContainEqual(expect.objectContaining({ id: taughtId, rev: 2, teachingAuthorized: false }));
      const revokedSource = await post('/api/iqdb/proposals', { requestId: 'source-revoked', need: '可授权', durationMinutes: 10, coverage: [], questionRefs: [{ id: taughtId, rev: 2 }] });
      expect(revokedSource.status).toBe(201);
      expect(await revokedSource.json()).toMatchObject({ questionRefs: [], gaps: expect.arrayContaining(['question_unavailable']) });
      const revoke = await fetch(`${base}/api/iqdb/questions/${taughtId}/teaching`, { method: 'PUT', ...body({ requestId: 'revoke-0001', expectedRev: 2, allowed: false }) });
      expect(revoke.status).toBe(200);
      expect(await revoke.json()).toMatchObject({ id: taughtId, rev: 3, teachingAuthorized: false, changed: true });
      const materialRev = await db.snapshot({ learner: studioLearner }, tx => tx.query<{ rev: number }>('SELECT current_rev AS rev FROM facts WHERE learner_id=$1 AND id=$2', [studioLearner, materialId])).then(({ rows }) => rows[0]!.rev);
      await send('activity.setWorkspaceTeaching', 'material-unlearn', { id: materialId, expectedRev: materialRev, enabled: false });
      listed = await getQuestions();
      expect(listed.questions).toContainEqual(expect.objectContaining({ id: taughtId, rev: 3, teachingAuthorized: false }));
      const ev = (q: string) => ({ conceptId: factId(stableId('iqdb-c')), submission: { id: questionId, rev: 1, type: 'x' }, questionId: factId(stableId(q)), questionRev: 1, occurredAt: '2026-01-01T00:00:00.000Z', recordedTick: '0', outcome: 'unknown', exposure: 'unknown', helpLevel: 'unknown', basisRefs: [] }) as never; // 普通作答 helpLevel unknown 折叠为 omission。
      const rows = selectionEvidenceRows([ev('qa'), ev('qb')]); expect(rows.omissions).toEqual([{ ref: { id: questionId, rev: 1 }, reason: 'unwitnessed-independence' }]);
      expect(isCanonicalEvidenceSlice({ clock_watermark: '0', as_of_at: '2026-01-02T00:00:00.000Z', events: [], omissions: rows.omissions, constraints: { budget_min: null, locks: [], deadlines: [] }, candidate_pool: [] })).toBe(true);
    } finally { server.close(); }
  }));
