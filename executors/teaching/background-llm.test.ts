import { describe, expect, it } from 'vitest';
import {
  createSettingsUnderstandingTransport,
  proposeKnowledgeMaintenanceWithAgent,
  type BackgroundLlmTransport,
  type KnowledgeMaintenanceContext,
} from './background-llm.ts';
import { TeachingError } from './provider.ts';

const sampleContext: KnowledgeMaintenanceContext = {
  currentDate: '2026-11-24',
  concepts: [
    { id: 'concept-1', title: '一元二次方程判别式', summary: '旧摘要', masteryLevel: 'fragile', attemptCount: 3, errorStages: ['formula'] },
    { id: 'concept-2', title: '二次函数图像与零点', summary: null, masteryLevel: 'new', attemptCount: 1 },
  ],
  edges: [{ fromId: 'concept-1', toId: 'concept-2', kind: 'related_to' }],
  recentSignals: [{ id: 'sig-1', kind: 'attempt', title: '判别式错题', excerpt: '忘记检验 Δ >= 0' }],
};

describe('createSettingsUnderstandingTransport', () => {
  it('throws provider_unavailable when no baseUrl is configured', async () => {
    const transport = createSettingsUnderstandingTransport(() => ({ baseUrl: '   ', apiKey: '' }));
    expect(transport.route).toBe('settings:active');
    expect(transport.cost).toBe(0);
    await expect(transport.sample({ instructions: 'sys', input: '{}', providerEffectId: 'eff-1' }))
      .rejects.toMatchObject({ name: 'TeachingError', code: 'provider_unavailable' });
  });

  it('caps reasoning_effort at low, supports keyless OpenAI & Anthropic routes, and enforces timeout', async () => {
    const seen: { endpoint: string; body: Record<string, unknown>; apiKey: string | undefined; id: string }[] = [];
    const mockTransport: BackgroundLlmTransport = async (endpoint, body, apiKey, id) => {
      seen.push({ endpoint, body: JSON.parse(body), apiKey, id });
      return { model: 'proxy/model-a', content: '{"entries":[]}' };
    };

    const openai = createSettingsUnderstandingTransport(
      () => ({ baseUrl: 'http://127.0.0.1:3425/v1', model: 'proxy/model-a', reasoningEffort: 'high' }),
      { transport: mockTransport },
    );
    expect(await openai.sample({ instructions: 'extract', input: '{"k":1}', providerEffectId: 'eff:42' })).toBe('{"entries":[]}');
    expect(seen[0]).toMatchObject({
      endpoint: 'http://127.0.0.1:3425/v1/chat/completions',
      apiKey: undefined,
      id: 'eff:42',
    });
    expect(seen[0]!.body.reasoning_effort).toBe('low');

    const anthropic = createSettingsUnderstandingTransport(
      () => ({ baseUrl: 'https://api.anthropic.com', protocol: 'anthropic', model: 'claude-haiku-4-5', reasoningEffort: 'default', apiKey: 'sk-test' }),
      { transport: mockTransport },
    );
    await anthropic.sample({ instructions: 'extract', input: '{}', providerEffectId: 'eff:43' });
    expect(seen[1]!.endpoint).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[1]!.body).not.toHaveProperty('reasoning_effort');

    const slow = createSettingsUnderstandingTransport(
      () => ({ baseUrl: 'http://127.0.0.1:3425/v1' }),
      { timeoutMs: 60, transport: () => new Promise(() => {}) },
    );
    await expect(slow.sample({ instructions: 'x', input: 'y', providerEffectId: 'eff:slow' }))
      .rejects.toThrow(TeachingError);
  });
});

describe('proposeKnowledgeMaintenanceWithAgent', () => {
  it('tolerates single-backslash LaTeX JSON escapes and strips hallucinated IDs, self-loops, and duplicates', async () => {
    const rawJson = `{
      "shouldAct": true,
      "rationale": "判别式 \\Delta = b^2 - 4ac 与零点存在明确前置关系",
      "suggestedEdges": [
        {"fromId": "concept-1", "toId": "concept-2", "kind": "prereq_of", "rationale": "需先掌握 \\Delta 判定"},
        {"fromId": "concept-1", "toId": "concept-2", "kind": "related_to", "rationale": "重复已有边"},
        {"fromId": "concept-1", "toId": "concept-1", "kind": "prereq_of", "rationale": "自环应过滤"},
        {"fromId": "concept-1", "toId": "ghost-999", "kind": "prereq_of", "rationale": "幻觉节点"}
      ],
      "suggestedSummaryUpdates": [
        {"conceptId": "concept-1", "summary": "判别式 \\Delta \\ge 0 且 \\sqrt{\\Delta} 决定实根个数", "rationale": "补齐易错条件"},
        {"conceptId": "ghost-999", "summary": "应被过滤", "rationale": "无效 ID"}
      ],
      "suggestedPrepNote": {
        "title": "判别式专项复盘",
        "focusConceptIds": ["concept-1", "ghost-999", "concept-1"],
        "summary": "重点检查 \\Delta \\ge 0 与 \\sin x 等定义域边界",
        "actionSteps": ["默写求根公式并检验 \\Delta 符号"]
      }
    }`;

    const result = await proposeKnowledgeMaintenanceWithAgent(sampleContext, {
      provider: { baseUrl: 'http://127.0.0.1:3425/v1', model: 'proxy/m1', reasoningEffort: 'max' },
      transport: async () => ({ model: 'proxy/m1', content: rawJson, usage: { prompt_tokens: 120, completion_tokens: 80 } }),
    });

    expect(result.proposal.shouldAct).toBe(true);
    expect(result.proposal.suggestedEdges).toEqual([
      { fromId: 'concept-1', toId: 'concept-2', kind: 'prereq_of', rationale: '需先掌握 \\Delta 判定' },
    ]);
    expect(result.proposal.suggestedSummaryUpdates).toHaveLength(1);
    expect(result.proposal.suggestedSummaryUpdates[0]!.summary).toContain('\\Delta');
    expect(result.proposal.suggestedPrepNote?.focusConceptIds).toEqual(['concept-1']);
    expect(result.usage.inputTokens).toBe(120);
  });

  it('forces shouldAct false when no valid grounded actions remain', async () => {
    const result = await proposeKnowledgeMaintenanceWithAgent(sampleContext, {
      provider: { baseUrl: 'http://127.0.0.1:3425/v1' },
      transport: async () => ({
        content: JSON.stringify({
          shouldAct: true,
          rationale: '全都是幻觉节点',
          suggestedEdges: [{ fromId: 'ghost-1', toId: 'ghost-2', kind: 'prereq_of', rationale: 'bad' }],
          suggestedSummaryUpdates: [{ conceptId: 'ghost-1', summary: 'x', rationale: 'y' }],
          suggestedPrepNote: { title: 'x', focusConceptIds: ['ghost-1'], summary: 'y', actionSteps: ['z'] },
        }),
      }),
    });
    expect(result.proposal).toMatchObject({
      shouldAct: false,
      suggestedEdges: [],
      suggestedSummaryUpdates: [],
    });
    expect(result.proposal.suggestedPrepNote).toBeUndefined();
  });
});
