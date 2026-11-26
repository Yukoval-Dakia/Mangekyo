import { describe, expect, it } from 'vitest';
import {
  createSettingsUnderstandingTransport,
  proposeKnowledgeMaintenanceWithAgent, createSettingsResearchScoutHost,
  type BackgroundLlmTransport,
  type KnowledgeMaintenanceContext,
} from './background-llm.ts';
import { authorTextbookWithModel } from './textbook-author.ts'; import { authorQuestionsWithModel } from './question-author.ts'; import { gardenQuestionMetadataWithModel } from './question-meta-gardener.ts'; import { answersEquivalent, runIsolatedPythonCheck } from './question-verifier.ts';
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

describe('Wave Feature-2 interactive authoring and meta gardening', () => {
  const provider = { baseUrl: 'http://127.0.0.1:3425/v1', model: 'proxy/m1' };
  const artifact = { version: 1, id: 'duanjue', revision: 'r1', title: '文言断句', fallback: '选出正确断句位置', sections: [{ id: 'work', title: '断句', layout: 'stack', nodes: [{ kind: 'selection', id: 'breaks', label: '断句位置', layout: 'passage', items: [{ id: 'gap-1', label: '后' }, { id: 'gap-2', label: '门' }, { id: 'gap-3', label: '户' }], tail: '', selected: [] }, { kind: 'action', id: 'submit', label: '提交断句', inputs: ['breaks'], intent: 'submit' }] }] };
  const contracts = { response_schema: [{ slotId: 'breaks', schemaVersion: 'selection-v1', fields: [{ path: '', kind: 'structured' }] }], assessment_contract: [{ criterionId: 'breaks-match', inputs: [{ slotId: 'breaks', path: '' }], evaluator: { id: 'multi-scheme-best', version: '1' }, parameters: { schemes: [{ schemeId: 'canonical', answers: ['gap-1', 'gap-3'] }] }, maximum: 1, missingEvidence: 'insufficient-evidence' }] };
  const pass = (output: object): BackgroundLlmTransport => async (_e, _b, _k, id) => ({ model: 'proxy/m1', content: JSON.stringify(id.startsWith('question-solve') ? { answer: '后、户之间断句' } : { questions: [output] }) });
  const base = { title: '文言断句', prompt: '为「其后门狗吠当户」选出正确断句位置', answer: '后、户之间断句', explanation: '据句意与对称判断。', rubric: ['位置正确'], hints: ['先看句意', '找主谓边界', '逐位核对'], difficulty: 'standard' };
  it('keeps valid interaction with contracts after blind verification and rejects broken artifacts', async () => { const ok = await authorQuestionsWithModel({ topic: '文言断句' }, { mode: 'concept_gap', count: 1, format: 'interactive', provider, transport: pass({ ...base, interaction: artifact, ...contracts }) }); expect(ok.questions[0]).toMatchObject({ format: 'interactive', response_schema: contracts.response_schema, assessment_contract: contracts.assessment_contract, verification: { status: 'verified' } });
    const broken = { ...artifact, sections: artifact.sections.map(section => ({ ...section, nodes: section.nodes.filter(node => node.kind !== 'action') })) }; await expect(authorQuestionsWithModel({ topic: '文言断句' }, { mode: 'concept_gap', count: 1, format: 'interactive', provider, transport: pass({ ...base, interaction: broken, ...contracts }) })).rejects.toMatchObject({ code: 'model_failed', status: 502 }); });
  it('gardens valid metadata, filters illegal discriminator and honors locked sticky fields', async () => { const output = { tags: [{ kind: 'target_skill', label: '一元一次方程', conceptId: 'c1' }, { kind: 'discriminator', label: '常数项辨别', term: '常数项', scope: '一元一次方程', change: '1改3', before: 'x=1', after: ['x=2', 'x=4'] }, { kind: 'discriminator', label: '非法辨别', term: '常数项', scope: '方程', change: '1改1', before: 'x=1', after: ['x=2', 'x=2'] }], hint_ladder: { l1: '先找等式两边', l2: '移项合并', l3: '把常数项移到右边后求解并回代检验', source_ref: 'question:q1' }, solutions: [{ method: '移项法', explanation: '移项后除以系数。', hints: ['先移常数'], source_ref: 'question:q1' }], estimatedMinutes: 4, rationale: '补齐目标技能与辨别标签' }; const transport: BackgroundLlmTransport = async () => ({ model: 'proxy/m1', content: JSON.stringify(output) });
    const gardened = await gardenQuestionMetadataWithModel({ questionId: 'q1', prompt: '求 x+1=2 的解', answer: '1', conceptIds: ['c1'] }, { provider, transport }); expect(gardened.draft).toMatchObject({ questionId: 'q1', tags: [{ kind: 'target_skill' }, { kind: 'discriminator', after: ['x=2', 'x=4'] }], estimatedMinutes: 4 }); expect(gardened.draft.tags).toHaveLength(2); expect(gardened.draft.hint_ladder?.l1).toBe('先找等式两边');
    const locked = await gardenQuestionMetadataWithModel({ questionId: 'q1', prompt: '求 x+1=2 的解', lockedStickyFields: ['hint_ladder', 'solutions'] }, { provider, transport }); expect(locked.draft.hint_ladder).toBeUndefined(); expect(locked.draft.solutions).toEqual([]); await expect(gardenQuestionMetadataWithModel({ questionId: 'q1', prompt: '求 x+1=2 的解' })).rejects.toMatchObject({ code: 'model_unavailable', status: 503 }); });
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
  const provider = { baseUrl: 'http://127.0.0.1:3425/v1', model: 'proxy/m1' }; const transport = (draft: object, solves?: readonly [string, string]): BackgroundLlmTransport => async (_e, b, _k, id) => { if (id.startsWith('question-solve-')) expect(b).not.toMatch(/代入即可验证|先找已知量/); return { model: 'proxy/m1', content: JSON.stringify(id.startsWith('question-solve-1') && solves ? { answer: solves[0] } : id.startsWith('question-solve-2') && solves ? { answer: solves[1] } : draft) }; };
  it('authors both textbook modes and maps failures', async () => { const draft = { title: '判别式精讲', summary: '掌握判别与零点', tags: [], sections: [{ heading: '核心结论', kind: 'formula', body: '判别式决定实根数量', latex: '\\Delta=b^2-4ac', sourceIds: ['s1', 'ghost'] }, { heading: '错因辨析', kind: 'pitfall', body: '比较根的情况前先确认二次项系数', sourceIds: [] }], sourceIds: ['s1', 'ghost'] };
    for (const mode of ['full', 'cheatsheet'] as const) expect((await authorTextbookWithModel({ topic: '一元二次方程', stickingPoints: [{ kind: 'misconception', id: 'm1', title: '错因', excerpt: '漏检验', errorStage: 'formula', errorStageLabel: '公式', occurredAt: null }], existingTextbookPages: [{ id: 'p1', rev: 1, title: '旧页' }], sourceSnippets: [{ id: 's1', title: '笔记', excerpt: '判别式' }] }, { provider, mode, transport: transport(draft) })).draft).toMatchObject({ mode, sourceIds: ['s1'], sections: [{ sourceIds: ['s1'] }, {}] });
    await expect(authorTextbookWithModel({ topic: '方程' })).rejects.toMatchObject({ code: 'model_unavailable', status: 503 }); await expect(authorTextbookWithModel({ topic: '方程' }, { provider, transport: async () => ({ content: '{}' }) })).rejects.toMatchObject({ code: 'model_failed', status: 502 });
  });
  it('cleans gap questions and rejects copied mistake variants', async () => { const base = { title: '新题', answer: '2', explanation: '代入即可验证', rubric: [], hints: ['先找已知量', '列方程', '完整求解'], difficulty: 'standard', conceptIds: ['c1', 'ghost'], sourceIds: ['q1', 'ghost'] };
    const gap = await authorQuestionsWithModel({ topic: '方程', concept: { id: 'c1', title: '方程' }, sourceSnippets: [{ id: 'q1', title: '来源', excerpt: '例题' }] }, { mode: 'concept_gap', count: 1, provider, transport: transport({ questions: [{ ...base, prompt: '一个数的二倍加一是五，求这个数', pythonCheck: '2*2 + 1 == 5' }] }, ['$\\mathrm{2}$', '4/2']) }); expect(gap.questions[0]).toMatchObject({ hints: ['先找已知量', '列方程', '完整求解'], conceptIds: ['c1'], sourceIds: ['q1'], verification: { status: 'verified', method: 'dual_solve_and_python', pythonChecked: true, pythonPassed: true } });
    const context = { topic: '方程', sourceQuestion: { id: 'q1', prompt: '求方程 x+1=2 的解', learnerAnswer: '3', errorStage: 'calculation', conceptIds: ['c1'] }, concept: { id: 'c1', title: '方程' } };
    await expect(authorQuestionsWithModel(context, { mode: 'mistake_variant', provider, transport: transport({ questions: [{ ...base, prompt: context.sourceQuestion.prompt }] }) })).rejects.toMatchObject({ code: 'model_failed' }); await expect(authorQuestionsWithModel(context, { mode: 'mistake_variant', provider, transport: transport({ questions: [{ ...base, prompt: '新情境求方程', hints: ['这条方向提示已经超过二十五个字因此必须被清洗拒绝才行', '列式', '求解'] }] }) })).rejects.toMatchObject({ code: 'model_failed' });
    const variant = await authorQuestionsWithModel(context, { mode: 'mistake_variant', provider, transport: transport({ questions: [{ ...base, prompt: '一个数加三是五，求这个数', variant: { relation: 'single_condition', preserved: ['未知数系数'], changed: ['常数项'] }, discriminator: { term: '常数项', scope: '一元一次方程', change: '1改3', before: 'x=1', after: ['x=2', 'x=4'] } }] }, ['2', '2']) }); expect(variant.questions[0]).toMatchObject({ prompt: '一个数加三是五，求这个数', sourceQuestionId: 'q1', variant: { spoilsNext: 'unknown' }, verification: { status: 'verified', method: 'dual_solve' } });
  });
  it('verifies answers via blind dual-solve + isolated python AST checks and rejects conflicts', async () => {
    expect(await runIsolatedPythonCheck('2*2 + 1 == 5')).toEqual({ ran: true, passed: true }); expect(await runIsolatedPythonCheck('1 == 2')).toEqual({ ran: true, passed: false }); expect(await runIsolatedPythonCheck('float("nan")')).toEqual({ ran: true, passed: false });
    expect(answersEquivalent('$\\left(\\frac{1}{2}\\right)$', '0.5')).toBe(true); for (const bad of ["__import__('os').system('id')", '(lambda x: x)(1)', '(1).__class__']) expect(await runIsolatedPythonCheck(bad)).toMatchObject({ ran: false });
    const ctx = { topic: '方程', concept: { id: 'c1', title: '方程' } }; const q = { title: '题', prompt: '求 x+1=3', answer: '2', explanation: '代入即可验证', hints: ['先找已知量', '相减', 'x=2'], conceptIds: ['c1'] };
    await expect(authorQuestionsWithModel(ctx, { mode: 'concept_gap', provider, transport: transport({ questions: [q] }, ['2', '3']) })).rejects.toMatchObject({ code: 'model_failed' }); await expect(authorQuestionsWithModel(ctx, { mode: 'concept_gap', provider, transport: transport({ questions: [{ ...q, pythonCheck: '2 + 2 == 5' }] }, ['2', '2']) })).rejects.toMatchObject({ code: 'model_failed' });
    const res = await authorQuestionsWithModel(ctx, { mode: 'concept_gap', provider, verify: false, transport: transport({ questions: [{ ...q, variant: { relation: 'single_condition', preserved: ['a'], changed: ['a'] }, discriminator: { term: 't', scope: 's', change: 'c', before: 'b', after: ['x', 'x'] } }] }) }); expect(res.questions[0]?.variant).toBeUndefined(); expect(res.questions[0]?.discriminator).toBeUndefined(); expect(res.questions[0]?.verification).toEqual({ status: 'unverified', method: 'none', solverAnswers: [], pythonChecked: false });
    await expect(authorQuestionsWithModel(ctx, { mode: 'concept_gap', provider, transport: transport({ questions: [q] }) })).rejects.toMatchObject({ code: 'model_failed' });
  });
  it('safely skips scout failures and sanitizes maintenance authoring suggestions', async () => { const skipped = await createSettingsResearchScoutHost(() => null).sample({ providerEffectId: 'e1', prompt: '{}', maxOutputTokens: 256, reserveUsdMicros: 20_000 }, new AbortController().signal);
    expect(JSON.parse(skipped.reply).actions).toEqual([{ kind: 'noop' }]); expect(skipped.actualUsdMicros).toBe(0);
    const live = createSettingsResearchScoutHost(() => provider, { transport: transport({ actions: [{ kind: 'noop' }] }) }); expect(await live.sample({ providerEffectId: 'e2', prompt: '{}', maxOutputTokens: 256, reserveUsdMicros: 20_000 }, new AbortController().signal)).toMatchObject({ actualUsdMicros: 0, servedModel: 'proxy/m1' });
    const maintained = await proposeKnowledgeMaintenanceWithAgent({ ...sampleContext, textbookPages: [{ id: 'p1', title: '教材' }] }, { provider, transport: transport({ shouldAct: true, rationale: '补充练习', suggestedTextbookUpdates: [{ pageId: 'p1', conceptIds: ['concept-1', 'ghost'], changeSummary: '补充错因', rationale: '针对错题' }, { pageId: 'ghost', changeSummary: '丢弃', rationale: '无效页' }], suggestedQuestions: [{ conceptId: 'concept-1', prompt: '判别实根数', answer: '看判别式', explanation: '比较与零', rationale: '补足缺口' }] }) }); expect(maintained.proposal).toMatchObject({ shouldAct: true, suggestedTextbookUpdates: [{ pageId: 'p1', conceptIds: ['concept-1'] }], suggestedQuestions: [{ conceptId: 'concept-1' }] });
  });
});
