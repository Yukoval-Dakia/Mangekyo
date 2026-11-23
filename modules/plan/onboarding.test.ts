import { describe, expect, it } from 'vitest';
import { planRule } from './rules.ts';
import {
  ONBOARDING_COMPANION_MEMO_MAX_LENGTH,
  buildManualOnboardingProposal,
  buildOnboardingCompanionMemo,
  parseOnboardingInput,
  parseOnboardingProposal,
  planRulePayloadsFromProposal,
  sanitizeWeights,
} from './onboarding.ts';

describe('modules/plan/onboarding (Track OB-1 pure domain contract)', () => {
  it('parses onboarding input with fallbacks and rejects blank profile text', () => {
    const parsed = parseOnboardingInput(
      {
        profileText: '  高二学生，准备期中复习  ',
        currentDate: 'bad-date',
        timeZone: 'Invalid/Zone',
        quickPrefs: { stage: '高二', dailyMinutes: 999, campaign: 'sprint', teachingStyle: '先例题后总结' },
        mode: 'llm',
      },
      '2026-11-23',
      'Asia/Shanghai',
    );
    expect(parsed).toEqual({
      profileText: '高二学生，准备期中复习',
      currentDate: '2026-11-23',
      timeZone: 'Asia/Shanghai',
      quickPrefs: { stage: '高二', dailyMinutes: 480, campaign: 'sprint', teachingStyle: '先例题后总结' },
      mode: 'llm',
    });
    expect(() => parseOnboardingInput({ profileText: '   ' }, '2026-11-23', 'Asia/Shanghai')).toThrow(/学习情况/);
  });

  it('sanitizes weights to stay inside scope, unique, integer, and sum <= 100', () => {
    const scope = ['力学', '电磁学', '实验'];
    const weights = sanitizeWeights(scope, [
      { topic: '力学', weight: 60.4 },
      { topic: '力学', weight: 30 },
      { topic: '电磁学', weight: 60.4 },
      { topic: '实验', weight: 30.2 },
      { topic: '未知模块', weight: 50 },
      { topic: '实验', weight: -5 },
    ]);
    expect(weights.map((w) => w.topic)).toEqual(['力学', '电磁学', '实验']);
    expect(weights.reduce((s, w) => s + w.weight, 0)).toBeLessThanOrEqual(100);
    expect(() => planRule({ kind: 'exam', date: '2027-01-10', scope, weights })).not.toThrow();
  });

  it('tolerantly sanitizes noisy LLM proposals, dangling graph/question refs, dates, and memo budget', () => {
    const proposal = parseOnboardingProposal({
      learnerSummary: { headline: '冲刺复习\0', selectedSubjects: ['物理', '物理', ''], dailyMinutes: 5 },
      examStatus: {
        completedExams: [{ subject: '物理', examName: '首考', status: 'completed', confidence: 'high', reason: '已完成' }],
        upcomingExams: [
          { id: 'ex 1', title: '期末考', date: '2027-01', scope: ['力学', '电磁'], weights: [{ topic: '力学', weight: 80 }, { topic: '电磁', weight: 80 }, { topic: '幽灵', weight: 50 }] },
          { id: 'bad', title: '坏日期', date: 'not-a-date', scope: ['A'] },
        ],
      },
      studyPlan: {
        goalText: '夯实基础',
        campaign: 'unknown',
        dailyWindow: { weekday: 9, start: 1300, end: 1200, label: '' },
        progressTopics: [{ topic: '牛顿定律', stage: 'current' }, { topic: '牛顿定律', stage: 'preview' }],
        companionMemo: '甲'.repeat(1200) + '\uD83D',
      },
      disciplines: [{ key: 'phys 1', title: '物理', learningScope: '高中物理', mastery: '', assessment: [], boundaries: [] }],
      knowledgeGraph: {
        concepts: [
          { key: 'c1', subject: '物理', title: '牛顿第二定律', summary: 'F=ma', semesterTag: '高二上', selected: true },
          { key: 'c2', subject: '物理', title: '动能定理', summary: 'W=ΔEk', semesterTag: '高二上', selected: true },
        ],
        edges: [
          { fromKey: 'c1', toKey: 'c2', kind: 'prereq_of', rationale: '前置' },
          { fromKey: 'c1', toKey: 'c1', kind: 'related_to', rationale: '自环应过滤' },
          { fromKey: 'c1', toKey: 'missing', kind: 'related_to', rationale: '悬空应过滤' },
        ],
      },
      starterQuestions: [
        { key: 'q1', subject: '物理', title: '斜面受力', prompt: '求加速度', answer: 'a=g sinθ', rubric: '列方程', conceptKeys: ['c1', 'ghost'], difficulty: 'core', selected: true },
      ],
      meta: { currentDate: '2026-11-23', timeZone: 'Asia/Shanghai', source: 'llm', model: 'test-model' },
    });

    expect(proposal.examStatus.upcomingExams).toHaveLength(1);
    expect(proposal.examStatus.upcomingExams[0]?.date).toBe('2027-01-15');
    expect(proposal.examStatus.upcomingExams[0]?.dateCertainty).toBe('estimated');
    expect(proposal.studyPlan.companionMemo.length).toBeLessThanOrEqual(ONBOARDING_COMPANION_MEMO_MAX_LENGTH);
    expect(proposal.studyPlan.companionMemo.isWellFormed()).toBe(true);
    expect(proposal.studyPlan.companionMemo.includes('\0')).toBe(false);
    expect(proposal.knowledgeGraph.edges).toEqual([{ fromKey: 'c1', toKey: 'c2', kind: 'prereq_of', rationale: '前置' }]);
    expect(proposal.starterQuestions[0]?.conceptKeys).toEqual(['c1']);
    expect(proposal.disciplines[0]?.assessment.length).toBeGreaterThan(0);
    expect(proposal.disciplines[0]?.boundaries.length).toBeGreaterThan(0);

    const rules = planRulePayloadsFromProposal(proposal);
    expect(rules.map((r) => r.kind)).toEqual(['campaign', 'window', 'exam', 'progress']);
    for (const rule of rules) expect(() => planRule(rule)).not.toThrow();
  });

  it('builds honest minimal offline proposal without fabricating region/subject templates and bounds memo', () => {
    const input = parseOnboardingInput(
      { profileText: '高二在读，每天晚上有空', quickPrefs: { dailyMinutes: 50, campaign: 'recovery' } },
      '2026-11-23',
      'Asia/Shanghai',
    );
    const manual = buildManualOnboardingProposal(input);
    expect(manual.meta.source).toBe('offline_manual');
    expect(manual.learnerSummary.regionOrSchool).toBe('');
    expect(manual.learnerSummary.selectedSubjects).toEqual([]);
    expect(manual.examStatus).toEqual({ completedExams: [], upcomingExams: [] });
    expect(manual.disciplines).toEqual([]);
    expect(manual.knowledgeGraph).toEqual({ concepts: [], edges: [] });
    expect(manual.starterQuestions).toEqual([]);
    expect(manual.studyPlan.companionMemo.length).toBeLessThanOrEqual(ONBOARDING_COMPANION_MEMO_MAX_LENGTH);
    expect(buildOnboardingCompanionMemo(manual).length).toBeLessThanOrEqual(ONBOARDING_COMPANION_MEMO_MAX_LENGTH);
    expect(planRulePayloadsFromProposal(manual).map((r) => r.kind)).toEqual(['campaign', 'window']);
  });
});
