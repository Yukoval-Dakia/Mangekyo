import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { openOnboarding } from '../onboarding.ts';
import { openTransparency } from '../transparency.ts';
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
    const [plan, content, companion] = await Promise.all(['plan', 'content', 'companion'].map(loadStudioTestModule));
    const onboarding = openOnboarding(db, { plan: plan!, content: content!, companion: companion! }, {
      loadProvider: async () => ({ baseUrl: 'http://127.0.0.1:3425/v1', model: 'mock-model', protocol: 'openai',
        reasoningEffort: 'low', apiKey: '', activeProviderId: 'mock', providers: [], mcpServers: [], exaApiKey: '', allowSearch: false }),
      agent: async () => ({ proposal, usage: { model: 'requested-model', reportedModel: 'served-model',
        inputTokens: 1200, outputTokens: 420, durationMs: 321 } }),
      now: () => new Date('2026-11-24T08:00:00+08:00'),
    });
    const free = await port(), server = serve(db, {} as never, {} as never, {} as never, { onboarding } as never, free);
    await new Promise<void>(resolve => server.listen(free, '127.0.0.1', resolve));
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${free}${path}`, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    try {
      expect((await call('/api/onboarding/status')).body).toMatchObject({ completed: false, hasModel: true,
        counts: { goals: 0, disciplines: 0, concepts: 0, questions: 0, memories: 0 } });
      const proposed = await call('/api/onboarding/propose', { requestId: 'onboard-req-1', profileText: '高二物理化学', mode: 'llm' });
      expect(proposed.status).toBe(200);
      expect(proposed.body).toMatchObject({ proposal: { meta: { model: 'mock-onboarding' } } });
      const applied = await call('/api/onboarding/apply', { requestId: 'onboard-apply-1', proposal: proposed.body.proposal });
      expect(applied.status).toBe(200);
      expect(applied.body.applied).toMatchObject({ ruleCount: 4, disciplineCount: 1, conceptCount: 2,
        skippedExistingConcepts: 0, edgeCount: 1, questionCount: 1, memoryUpdated: true });
      expect(applied.body.links.graph).toBe('/materials?tab=graph');

      const replay = await call('/api/onboarding/apply', { requestId: 'onboard-apply-1', proposal: proposed.body.proposal });
      expect(replay.status).toBe(200);
      expect(replay.body.applied).toMatchObject(applied.body.applied);
      const after = await call('/api/onboarding/status');
      expect(after.body).toMatchObject({ completed: true, goalText: '期中进入年级前 15%', upcomingExamCount: 1,
        counts: { goals: 1, disciplines: 1, concepts: 2, questions: 1, memories: 1 } });
      const effects = await db.snapshot({ learner: studioLearner }, tx => tx.query(
        `SELECT label,state,result FROM effects WHERE learner_id=$1 AND owner_kind='session' ORDER BY label`, [studioLearner]));
      expect(effects.rows).toEqual([expect.objectContaining({ label: 'onboarding-setup', state: 'done',
        result: expect.objectContaining({ reportedModel: 'served-model', route: 'onboarding-setup' }) })]);
      const memory = await db.snapshot({ learner: studioLearner }, tx => tx.query<{ value: { text?: string } }>(
        `SELECT value FROM facts WHERE learner_id=$1 AND type='companion.memory'`, [studioLearner]));
      expect(memory.rows[0]?.value.text).toContain('当前目标：期中进入年级前 15%');
      await expect(openTransparency(db).aiActivity()).resolves.toMatchObject({
        usage: { recentCalls: [expect.objectContaining({ label: 'onboarding-setup', model: 'served-model' })] } });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }));
