import { describe, expect, it } from 'vitest';
import {
  createSettingsUnderstandingTransport,
  proposeKnowledgeMaintenanceWithAgent, createSettingsResearchScoutHost,
  type BackgroundLlmTransport,
  type KnowledgeMaintenanceContext,
} from './background-llm.ts';
import { authorTextbookWithModel } from './textbook-author.ts'; import { authorQuestionsWithModel } from './question-author.ts';
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
  it('rejects unconfigured, remote, or API-keyed providers on the zero-cost route', async () => {
    const maySend = () => true;
    const cases = [
      { baseUrl: '   ', apiKey: '' },
      { baseUrl: 'https://api.anthropic.com', protocol: 'anthropic' as const, model: 'claude-haiku-4-5', apiKey: 'sk-test' },
      { baseUrl: 'https://api.openai.com/v1', model: 'proxy/model-a' },
      { baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'sk-local-paid' },
    ];
    for (const provider of cases) {
      const transport = createSettingsUnderstandingTransport(() => provider, { maySend });
      expect(transport).toMatchObject({ route: 'settings:active', cost: 0, maySend });
      await expect(transport.sample({ instructions: 'sys', input: '{}', providerEffectId: 'eff-1' }))
        .rejects.toMatchObject({ name: 'TeachingError', code: 'provider_unavailable' });
    }
  });

  it('allows keyless loopback OpenAI & Anthropic routes, caps reasoning_effort, and enforces timeout', async () => {
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
    expect(seen[0]).toMatchObject({ endpoint: 'http://127.0.0.1:3425/v1/chat/completions', apiKey: undefined, id: 'eff:42' });
    expect(seen[0]!.body.reasoning_effort).toBe('low');

    const anthropic = createSettingsUnderstandingTransport(
      () => ({ baseUrl: 'http://localhost:8080', protocol: 'anthropic', model: 'claude-haiku-4-5', reasoningEffort: 'default' }),
      { transport: mockTransport },
    );
    await anthropic.sample({ instructions: 'extract', input: '{}', providerEffectId: 'eff:43' });
    expect(seen[1]!.endpoint).toBe('http://localhost:8080/v1/messages');
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
  it('tolerates single-backslash LaTeX JSON escapes and strips hallucinated IDs, self-loops, duplicates, and summary updates', async () => {
    const rawJson = `{
      "shouldAct": true,
      "rationale": "判别式 \\Delta = b^2 - 4ac 与零点存在明确前置关系",
      "suggestedEdges": [
        {"fromId": "concept-1", "toId": "concept-2", "kind": "prereq_of", "rationale": "需先掌握 \\Delta 判定"},
        {"fromId": "concept-1", "toId": "concept-2", "kind": "related_to", "rationale": "重复已有边"},
        {"fromId": "concept-1", "toId": "concept-1", "kind": "prereq_of", "rationale": "自环应过滤"},
        {"fromId": "concept-1", "toId": "ghost-999", "kind": "prereq_of", "rationale": "幻觉节点"}
      ],
      "suggestedSummaryUpdates": [{"conceptId": "concept-1", "summary": "应收敛忽略", "rationale": "未消费"}],
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
    expect(result.proposal.suggestedSummaryUpdates).toEqual([]);
    expect(result.proposal.suggestedPrepNote?.focusConceptIds).toEqual(['concept-1']);
    expect(result.usage.inputTokens).toBe(120);
  });

  it('forces shouldAct false when only summary updates or invalid items remain', async () => {
    const result = await proposeKnowledgeMaintenanceWithAgent(sampleContext, {
      provider: { baseUrl: 'http://127.0.0.1:3425/v1' },
      transport: async () => ({
        content: JSON.stringify({
          shouldAct: true,
          rationale: '仅含未消费摘要或幻觉节点',
          suggestedEdges: [{ fromId: 'ghost-1', toId: 'ghost-2', kind: 'prereq_of', rationale: 'bad' }],
          suggestedSummaryUpdates: [{ conceptId: 'concept-1', summary: 'x', rationale: 'y' }],
          suggestedPrepNote: { title: 'x', focusConceptIds: ['ghost-1'], summary: 'y', actionSteps: ['z'] },
        }),
      }),
    });
    expect(result.proposal).toMatchObject({ shouldAct: false, suggestedEdges: [], suggestedSummaryUpdates: [] });
    expect(result.proposal.suggestedPrepNote).toBeUndefined();
  });
});

describe('Wave Feature-1 authoring', () => {
  const provider = { baseUrl: 'http://127.0.0.1:3425/v1', model: 'proxy/m1' }; const transport = (draft: object): BackgroundLlmTransport => async () => ({ model: 'proxy/m1', content: JSON.stringify(draft) });
  it('authors both textbook modes and maps failures', async () => { const draft = { title: '判别式精讲', summary: '掌握判别与零点', tags: [], sections: [{ heading: '核心结论', kind: 'formula', body: '判别式决定实根数量', latex: '\\Delta=b^2-4ac', sourceIds: ['s1', 'ghost'] }, { heading: '错因辨析', kind: 'pitfall', body: '比较根的情况前先确认二次项系数', sourceIds: [] }], sourceIds: ['s1', 'ghost'] };
    for (const mode of ['full', 'cheatsheet'] as const) expect((await authorTextbookWithModel({ topic: '一元二次方程', sourceSnippets: [{ id: 's1', title: '笔记', excerpt: '判别式' }] }, { provider, mode, transport: transport(draft) })).draft).toMatchObject({ mode, sourceIds: ['s1'], sections: [{ sourceIds: ['s1'] }, {}] });
    await expect(authorTextbookWithModel({ topic: '方程' })).rejects.toMatchObject({ code: 'model_unavailable', status: 503 }); await expect(authorTextbookWithModel({ topic: '方程' }, { provider, transport: async () => ({ content: '{}' }) })).rejects.toMatchObject({ code: 'model_failed', status: 502 });
  });
  it('cleans gap questions and rejects copied mistake variants', async () => { const base = { title: '新题', answer: '2', explanation: '代入即可验证', rubric: [], hints: ['先找已知量', '列方程', '完整求解'], difficulty: 'standard', conceptIds: ['c1', 'ghost'], sourceIds: ['q1', 'ghost'] };
    const gap = await authorQuestionsWithModel({ topic: '方程', concept: { id: 'c1', title: '方程' }, sourceSnippets: [{ id: 'q1', title: '来源', excerpt: '例题' }] }, { mode: 'concept_gap', count: 1, provider, transport: transport({ questions: [{ ...base, prompt: '一个数的二倍加一是五，求这个数' }] }) }); expect(gap.questions[0]).toMatchObject({ hints: ['先找已知量', '列方程', '完整求解'], conceptIds: ['c1'], sourceIds: ['q1'] });
    const context = { topic: '方程', sourceQuestion: { id: 'q1', prompt: '求方程 x+1=2 的解', learnerAnswer: '3', errorStage: 'calculation', conceptIds: ['c1'] }, concept: { id: 'c1', title: '方程' } };
    await expect(authorQuestionsWithModel(context, { mode: 'mistake_variant', provider, transport: transport({ questions: [{ ...base, prompt: context.sourceQuestion.prompt }] }) })).rejects.toMatchObject({ code: 'model_failed' }); await expect(authorQuestionsWithModel(context, { mode: 'mistake_variant', provider, transport: transport({ questions: [{ ...base, prompt: '新情境求方程', hints: ['这条方向提示已经超过二十五个字因此必须被清洗拒绝才行', '列式', '求解'] }] }) })).rejects.toMatchObject({ code: 'model_failed' });
    const variant = await authorQuestionsWithModel(context, { mode: 'mistake_variant', provider, transport: transport({ questions: [{ ...base, prompt: '一个数加三是五，求这个数' }] }) }); expect(variant.questions[0]).toMatchObject({ prompt: '一个数加三是五，求这个数', sourceQuestionId: 'q1' });
  });
  it('safely skips scout failures and sanitizes maintenance authoring suggestions', async () => { const skipped = await createSettingsResearchScoutHost(() => null).sample({ providerEffectId: 'e1', prompt: '{}', maxOutputTokens: 256, reserveUsdMicros: 20_000 }, new AbortController().signal);
    expect(JSON.parse(skipped.reply).actions).toEqual([{ kind: 'noop' }]); expect(skipped.actualUsdMicros).toBe(0);
    const live = createSettingsResearchScoutHost(() => provider, { transport: transport({ actions: [{ kind: 'noop' }] }) }); expect(await live.sample({ providerEffectId: 'e2', prompt: '{}', maxOutputTokens: 256, reserveUsdMicros: 20_000 }, new AbortController().signal)).toMatchObject({ actualUsdMicros: 0, servedModel: 'proxy/m1' });
    const maintained = await proposeKnowledgeMaintenanceWithAgent({ ...sampleContext, textbookPages: [{ id: 'p1', title: '教材' }] }, { provider, transport: transport({ shouldAct: true, rationale: '补充练习', suggestedTextbookUpdates: [{ pageId: 'p1', conceptIds: ['concept-1', 'ghost'], changeSummary: '补充错因', rationale: '针对错题' }, { pageId: 'ghost', changeSummary: '丢弃', rationale: '无效页' }], suggestedQuestions: [{ conceptId: 'concept-1', prompt: '判别实根数', answer: '看判别式', explanation: '比较与零', rationale: '补足缺口' }] }) }); expect(maintained.proposal).toMatchObject({ shouldAct: true, suggestedTextbookUpdates: [{ pageId: 'p1', conceptIds: ['concept-1'] }], suggestedQuestions: [{ conceptId: 'concept-1' }] });
  });
});
