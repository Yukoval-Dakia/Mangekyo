import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { openOnboarding } from '../onboarding.ts';
import { openTransparency } from '../transparency.ts';
import { openWorkbook } from '../workbook.ts';
import { openWorkspaceAccess } from '../workspace-access.ts';
import { resolveSource } from '../source-read.ts';
import { serve } from '../http.ts';
import { studioLearner } from '../identity.ts';
import { loadStudioTestModule } from './modules.ts';

const port = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject).listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
  });
});

const proposal = {
  learnerSummary: {
    headline: '高二冲刺', stage: '高二', regionOrSchool: '杭州', selectedSubjects: ['物理', '化学'],
    inferredPeriod: '高二下学期', dailyMinutes: 60, teachingStyle: '先例题后总结',
  },
  examStatus: { completedExams: [], upcomingExams: [{ id: 'midterm', title: '期中统考', date: '2027-04-20',
    dateCertainty: 'estimated' as const, scope: ['力学', '电磁学'], weights: [{ topic: '力学', weight: 70 }, { topic: '电磁学', weight: 30 }], note: '常规校历估算' }] },
  studyPlan: {
    goalText: '期中进入年级前 15%', campaign: 'sprint' as const, dailyWindow: { weekday: null, start: 1170, end: 1230, label: '19:30-20:30' },
    progressTopics: [{ topic: '牛顿定律', stage: 'current' as const }, { topic: '电场', stage: 'preview' as const }], companionMemo: '', preferenceNotes: [],
  },
  disciplines: [{ key: 'physics', title: '物理', learningScope: '高中物理', mastery: '能独立做对中档题',
    assessment: ['限时测验', '错题复盘'], boundaries: ['不提前扩展到竞赛'] }],
  knowledgeGraph: {
    concepts: [
      { key: 'c1', subject: '物理', title: '牛顿第二定律', summary: 'F=ma', semesterTag: '高二下', selected: true },
      { key: 'c2', subject: '物理', title: '动能定理', summary: 'W=ΔEk', semesterTag: '高二下', selected: true },
      { key: 'skip', subject: '物理', title: '相对论', summary: '暂不纳入', semesterTag: '拓展', selected: false },
    ],
    edges: [{ fromKey: 'c1', toKey: 'c2', kind: 'prereq_of' as const, rationale: '先受力分析再能量转化' }],
  },
  starterQuestions: [{ key: 'q1', subject: '物理', title: '斜面受力', prompt: '求光滑斜面加速度',
    answer: '$a=g\\sin\\theta$', rubric: '分解重力并列牛顿第二定律', conceptKeys: ['c1'], difficulty: 'core' as const, selected: true }],
  meta: { generatedAt: '2026-11-24T00:00:00.000Z', currentDate: '2026-11-24', timeZone: 'Asia/Shanghai',
    source: 'llm' as const, model: 'mock-onboarding', honestyNote: '考期为估算，请核对。' },
};

it.skipIf(!testDatabaseUrl)('serves onboarding status/apply idempotently and records transparency evidence on PostgreSQL', () =>
  withLearnerDatabase(studioLearner, async db => {
    const [activity, capture, plan, content, companion] = await Promise.all(['activity', 'capture', 'plan', 'content', 'companion'].map(loadStudioTestModule));
    let modelEnabled = true, authorizedCalls = 0;
    const onboarding = openOnboarding(db, { plan: plan!, content: content!, companion: companion! }, {
      loadProvider: async () => ({ baseUrl: modelEnabled ? 'http://127.0.0.1:3425/v1' : '', model: 'mock-model', protocol: 'openai',
        reasoningEffort: 'low', apiKey: '', activeProviderId: 'mock', providers: [], mcpServers: [], exaApiKey: '', allowSearch: false }),
      agent: async () => ({ proposal, usage: { model: 'requested-model', reportedModel: 'served-model',
        inputTokens: 1200, outputTokens: 420, durationMs: 321 } }),
      now: () => new Date('2026-11-24T08:00:00+08:00'),
      authorizeModel: async () => { authorizedCalls += 1; },
    });
    const workbook = openWorkbook(db, activity!), transparency = openTransparency(db);
    const workspace = openWorkspaceAccess(db, activity!, content!, capture!, plan!);
    const free = await port(), server = serve(db, {} as never, {} as never, {} as never, { onboarding, workbook, transparency, workspace } as never, free);
    await new Promise<void>(resolve => server.listen(free, '127.0.0.1', resolve));
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${free}${path}`, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    try {
      expect((await call('/api/onboarding/status')).body).toMatchObject({ completed: false, hasModel: true,
        disciplineCount: 0, conceptCount: 0, questionCount: 0, hasMemory: false });
      modelEnabled = false;
      expect(await call('/api/onboarding/propose', { profileText: '高二物理化学', timeZone: 'Asia/Shanghai', mode: 'llm' })).toMatchObject({
        status: 503, body: { code: 'model_unavailable', next: 'settings' } });
      modelEnabled = true;
      const proposed = await call('/api/onboarding/propose', { profileText: '高二物理化学', timeZone: 'Asia/Shanghai', mode: 'llm' });
      expect(proposed.status).toBe(200);
      expect(proposed.body).toMatchObject({ proposal: { meta: { model: 'mock-onboarding' } } });
      const applied = await call('/api/onboarding/apply', { requestId: 'onboard-apply-1', proposal: proposed.body.proposal });
      expect(applied.status).toBe(200);
      expect(applied.body.applied).toMatchObject({ ruleCount: 5, disciplineCount: 1, conceptCount: 2,
        skippedExistingConcepts: 0, edgeCount: 1, questionCount: 1, memoryUpdated: true });
      expect(applied.body.links.graph).toBe('/materials?tab=graph');
      expect(authorizedCalls).toBe(1);

      const replay = await call('/api/onboarding/apply', { requestId: 'onboard-apply-1', proposal: proposed.body.proposal });
      expect(replay.status).toBe(200);
      expect(replay.body.applied).toMatchObject(applied.body.applied);
      const after = await call('/api/onboarding/status');
      expect(after.body).toMatchObject({ completed: true, hasGoal: true, hasDisciplines: true, hasConcepts: true, hasQuestions: true,
        hasMemory: true, goalText: '期中进入年级前 15%', disciplineCount: 1, conceptCount: 2, questionCount: 1, upcomingExamCount: 1 });
      const effects = await db.snapshot({ learner: studioLearner }, tx => tx.query(
        `SELECT label,state,result FROM effects WHERE learner_id=$1 AND owner_kind='session' ORDER BY label`, [studioLearner]));
      expect(effects.rows).toEqual([expect.objectContaining({ label: 'onboarding-setup', state: 'done',
        result: expect.objectContaining({ reportedModel: 'served-model', route: 'onboarding-setup' }) })]);
      const memory = await db.snapshot({ learner: studioLearner }, tx => tx.query<{ value: { text?: string } }>(
        `SELECT r.data AS value FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
         WHERE f.learner_id=$1 AND f.type='companion.memory' AND f.retracted_rev IS NULL AND r.kind='value'`, [studioLearner]));
      expect(memory.rows[0]?.value.text).toContain('当前目标：期中进入年级前 15%');
      const research = await db.snapshot({ learner: studioLearner }, tx => tx.query<{ enabled: boolean }>(
        `SELECT (r.data->>'enabled')::boolean AS enabled FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
         WHERE f.learner_id=$1 AND f.type='companion.researchSettings' AND f.retracted_rev IS NULL AND r.kind='value'`, [studioLearner]));
      expect(research.rows[0]?.enabled).toBe(true);
      await expect(openTransparency(db).aiActivity()).resolves.toMatchObject({
        usage: { recentCalls: [expect.objectContaining({ label: 'onboarding-setup', model: 'served-model' })] } });
      const graph = await call('/api/knowledge/graph');
      expect(graph.status).toBe(200);
      const newton = (graph.body.nodes as { id: string; title: string; summary: string | null }[]).find(n => n.title === '牛顿第二定律')!;
      expect(newton?.summary).toBe('F=ma');
      expect((graph.body.nodes as { title: string; summary: string | null }[]).find(n => n.title === '动能定理')?.summary).toBe('W=ΔEk');
      const openedConcept = await db.snapshot({ learner: studioLearner }, tx => resolveSource(tx, newton.id, { recipient: 'learner' }));
      expect(openedConcept).toMatchObject({ title: '牛顿第二定律', content: 'F=ma' });
      const qp = await call(`/api/knowledge/graph/${newton.id}/quick-paper`, { requestId: 'onboard-qp-1' });
      expect(qp.status).toBe(201);
      const savedPaper = await db.snapshot({ learner: studioLearner }, tx => tx.query<{ value: { questions: { prompt: string; rubric?: string; explanation?: string | null }[] } }>(
        `SELECT r.data AS value FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
         WHERE f.learner_id=$1 AND f.id=$2`, [studioLearner, qp.body.paperId]));
      expect(savedPaper.rows[0]?.value.questions[0]).toMatchObject({
        prompt: '求光滑斜面加速度', explanation: '$a=g\\sin\\theta$', rubric: '参考答案：$a=g\\sin\\theta$\n评分要点：分解重力并列牛顿第二定律',
      });
      const conceptRecord = await call(`/api/workspace/access/records/${newton.id}?offset=0`);
      expect(conceptRecord).toMatchObject({ status: 200, body: { id: newton.id, title: '牛顿第二定律', kind: 'concept', text: 'F=ma', eligible: false } });
      const conceptList = await call('/api/workspace/access?category=entry&kind=concept');
      expect(conceptList.status).toBe(200);
      expect(conceptList.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: newton.id, title: '牛顿第二定律', kind: 'concept' })]));
      const questionList = await call('/api/workspace/access?category=entry&kind=question');
      expect(questionList.status).toBe(200);
      const qId = String((questionList.body.items as { id: string }[])[0]!.id);
      const questionRecord = await call(`/api/workspace/access/records/${qId}?offset=0`);
      expect(questionRecord).toMatchObject({ status: 200, body: { id: qId, title: '斜面受力', kind: 'question',
        question: { prompt: '求光滑斜面加速度', answer: '$a=g\\sin\\theta$', rubric: '分解重力并列牛顿第二定律' } } });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }));
