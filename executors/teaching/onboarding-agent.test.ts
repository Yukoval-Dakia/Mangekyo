import { describe, expect, it } from 'vitest';
import {
  extractJsonObject,
  OnboardingAgentError,
  proposeOnboardingWithAgent,
  type OnboardingAgentInput,
  type OnboardingTransport,
} from './onboarding-agent.ts';
import type { TeachingProvider } from './provider.ts';

const provider: TeachingProvider = { baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'test-key', protocol: 'openai', model: 'auto/deepseek-v4.1-flash' };
const sampleInput: OnboardingAgentInput = {
  profileText: '我是大三软件工程学生，准备明年12月考计算机 408，每天晚上有 90 分钟。',
  currentDate: '2026-11-23',
  timeZone: 'Asia/Shanghai',
  quickPrefs: { dailyMinutes: 90, campaign: 'steady' },
};

const validDraft = {
  learnerSummary: { headline: '计算机 408 备考', stage: '大学本科', regionOrSchool: '未指定', selectedSubjects: ['数据结构', '操作系统'], inferredPeriod: '大三上学期中后段', dailyMinutes: 90, teachingStyle: '先原理后刷题' },
  examStatus: {
    completedExams: [{ subject: '程序设计基础', examName: '本科先修课', status: 'completed', confidence: 'needs_confirm', reason: '按大三阶段常规培养方案推断，请核对。' }],
    upcomingExams: [{ id: 'exam-408', title: '全国硕士研究生招生考试 408', date: '2027-12-25', dateCertainty: 'estimated', scope: ['数据结构', '操作系统'], weights: [{ topic: '数据结构', weight: 50 }, { topic: '操作系统', weight: 50 }], note: '按历年12月下旬估算' }],
  },
  studyPlan: { goalText: '一年内打牢 408 核心基础并完成两轮真题', campaign: 'steady', dailyWindow: { weekday: null, start: 1200, end: 1290, label: '晚间自习' }, progressTopics: [{ topic: '二叉树与图遍历', stage: 'current' }], companionMemo: '大三软工，备考408，晚间90分钟。', preferenceNotes: ['先讲直觉再推公式'] },
  disciplines: [{ key: 'cs408', title: '计算机学科专业基础 408', learningScope: '数据结构、组成原理、操作系统、计网', mastery: '能独立分析复杂度与并发问题', assessment: ['选择与综合应用题'], boundaries: ['不替写完整作业'] }],
  knowledgeGraph: {
    concepts: [{ key: 'ds-tree', subject: '数据结构', title: '二叉树遍历', summary: '前中后序与层序遍历及递归/栈实现', semesterTag: '基础阶段', selected: true }],
    edges: [],
  },
  starterQuestions: [{ key: 'q1', subject: '数据结构', title: '满二叉树结点数', prompt: '高度为 $h$ 的满二叉树共有多少个结点？', answer: '$2^h - 1$', rubric: '给出 $2^h - 1$ 且说明等比求和依据', conceptKeys: ['ds-tree'], difficulty: 'foundation', selected: true }],
  meta: { generatedAt: '', currentDate: '2026-11-23', timeZone: 'Asia/Shanghai', source: 'llm', honestyNote: '考试日期按历年规律估算，请核对。' },
};

describe('onboarding-agent', () => {
  it('extracts JSON from plain text, fenced markdown, and thinking-wrapped prose', () => {
    expect(extractJsonObject('<think>reasoning</think>\n```json\n{"a":1,"b":"x}y"}\n```')).toEqual({ a: 1, b: 'x}y' });
    expect(extractJsonObject('结果如下：{"ok":true,"nested":{"k":"{v}"}} 完毕')).toEqual({ ok: true, nested: { k: '{v}' } });
    expect(extractJsonObject('not json at all')).toBeNull();
  });

  it('injects exact date/weekday/timezone, supports anthropic protocol, and reports usage', async () => {
    let seenBody = '';
    let seenEndpoint = '';
    const transport: OnboardingTransport = async (endpoint, body) => {
      seenEndpoint = endpoint;
      seenBody = body;
      return {
        model: 'claude-sonnet-4-5',
        content: '```json\n' + JSON.stringify(validDraft) + '\n```',
        usage: { prompt_tokens: 420, completion_tokens: 980, total_tokens: 1400 },
      };
    };
    let tick = 1_700_000_000_000;
    const result = await proposeOnboardingWithAgent(sampleInput, {
      provider: { baseUrl: 'https://api.example.test/v1', apiKey: 'sk-ant', protocol: 'anthropic', model: 'claude-sonnet-4-5', reasoningEffort: 'high' },
      transport,
      now: () => new Date((tick += 250)),
    });
    expect(seenEndpoint).toBe('https://api.example.test/v1/messages');
    const sent = JSON.parse(seenBody);
    expect(sent.reasoning_effort).toBe('low');
    expect(sent.max_tokens).toBe(8192);
    expect(seenBody).toContain('8–12 个');
    expect(seenBody).toContain('5–6 道');
    expect(seenBody).toContain('2026-11-23（星期一 / Monday）');
    expect(seenBody).toContain('Asia/Shanghai');
    expect(result.proposal.meta.model).toBe('claude-sonnet-4-5');
    expect(result.proposal.meta.source).toBe('llm');
    expect(result.usage).toEqual({ model: 'claude-sonnet-4-5', reportedModel: 'claude-sonnet-4-5', inputTokens: 420, outputTokens: 980, durationMs: 250 });

    let defaultBody = '';
    await proposeOnboardingWithAgent(sampleInput, {
      provider: { ...provider, reasoningEffort: 'default' },
      transport: async (_ep, body) => { defaultBody = body; return { model: provider.model, content: JSON.stringify(validDraft) }; },
    });
    expect(JSON.parse(defaultBody).reasoning_effort).toBeUndefined();
  });

  it('performs one targeted JSON repair retry on truncation or syntax error and accumulates tokens', async () => {
    let calls = 0;
    const transport: OnboardingTransport = async (_ep, body) => {
      calls++;
      if (calls === 1) {
        return { model: 'lobster/deepseek-flash', truncated: true, usage: { prompt_tokens: 300, completion_tokens: 1000 } };
      }
      expect(body).toContain('输出达到长度上限被截断');
      return { model: 'lobster/deepseek-flash', content: JSON.stringify(validDraft), usage: { prompt_tokens: 500, completion_tokens: 700 } };
    };
    const result = await proposeOnboardingWithAgent(sampleInput, { provider, transport });
    expect(calls).toBe(2);
    expect(result.usage.inputTokens).toBe(800);
    expect(result.usage.outputTokens).toBe(1700);
    expect(result.proposal.starterQuestions).toHaveLength(1);
  });

  it('maps missing provider, HTTP rejection, timeout, and double parse failure to structured OnboardingAgentError', async () => {
    await expect(proposeOnboardingWithAgent(sampleInput, { provider: null })).rejects.toMatchObject({ name: 'OnboardingAgentError', code: 'model_unavailable' });
    await expect(proposeOnboardingWithAgent(sampleInput, {
      provider, transport: async () => ({ rejectedHttpStatus: 401 }),
    })).rejects.toMatchObject({ name: 'OnboardingAgentError', code: 'model_unavailable' });
    await expect(proposeOnboardingWithAgent(sampleInput, {
      provider, timeoutMs: 50, transport: () => new Promise(() => {}),
    })).rejects.toMatchObject({ name: 'OnboardingAgentError', code: 'timeout' });
    await expect(proposeOnboardingWithAgent(sampleInput, {
      provider, transport: async () => ({ model: 'auto/deepseek-v4.1-flash', content: '{broken json' }),
    })).rejects.toThrow(OnboardingAgentError);
    await expect(proposeOnboardingWithAgent(sampleInput, {
      provider, transport: async () => ({ model: 'auto/deepseek-v4.1-flash', content: '{broken json' }),
    })).rejects.toMatchObject({ code: 'model_failed' });
  });
});
