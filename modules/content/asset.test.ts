import { describe, expect, it } from 'vitest';
import type { Revision } from '@mangekyo/kernel';
import { applyAssetQuestionSolutions, assetSummary, assetWorkspaceDisplay, parseAsset, questionSolutionFields, type QuestionAsset } from './asset.ts';
import { buildAuthoredQuestionCommands, parseSaveQuestion } from './question-authoring.ts';
import { buildAuthoredTextbookCommands, buildCompanionTextbookRevisionProposal, TextbookAuthoringNotFoundError } from './textbook-authoring.ts';

describe('content asset helpers', () => {
  it('extracts labeled answer and rubric fields and generic explanation blocks from question assets', () => {
    const onboardingQ = parseAsset({
      kind: 'question', title: '斜面受力', promptBlockId: 'prompt',
      blocks: [
        { id: 'prompt', parentId: null, body: { kind: 'text', text: '求光滑斜面加速度' } },
        { id: 'answer', parentId: null, body: { kind: 'text', text: '参考答案：$a=g\\sin\\theta$\n评分要点：分解重力并列牛顿第二定律' } },
      ],
    }) as QuestionAsset;
    expect(questionSolutionFields(onboardingQ)).toEqual({ answer: '$a=g\\sin\\theta$', rubric: '分解重力并列牛顿第二定律' });

    const genericQ = parseAsset({
      kind: 'question', title: '通用解说', promptBlockId: 'prompt',
      blocks: [
        { id: 'prompt', parentId: null, body: { kind: 'text', text: '题干' } },
        { id: 'notes', parentId: null, body: { kind: 'text', text: '先画受力图再列方程。' } },
      ],
    }) as QuestionAsset;
    expect(questionSolutionFields(genericQ)).toEqual({ rubric: '先画受力图再列方程。' });

    const exactQ = parseAsset({
      kind: 'question', title: '纯答案', promptBlockId: 'prompt',
      blocks: [
        { id: 'prompt', parentId: null, body: { kind: 'text', text: '1+1=?' } },
        { id: 'answer', parentId: null, body: { kind: 'text', text: '2' } },
      ],
    }) as QuestionAsset;
    expect(questionSolutionFields(exactQ)).toEqual({ answer: '2' });

    const enriched = applyAssetQuestionSolutions(
      { title: '自测', questions: [
        { kind: 'rubric', prompt: '求光滑斜面加速度', rubric: '默认', sourceQuestionRef: { id: 'q1', rev: 1 } },
        { kind: 'rubric', prompt: '1+1=?', rubric: '默认', sourceQuestionRef: { id: 'q2', rev: 1 } },
      ] },
      new Map([['q1', questionSolutionFields(onboardingQ)], ['q2', questionSolutionFields(exactQ)]]),
    );
    expect(enriched.questions[0]).toMatchObject({ kind: 'rubric', explanation: '$a=g\\sin\\theta$', rubric: expect.stringContaining('分解重力并列牛顿第二定律') });
    expect(enriched.questions[1]).toMatchObject({ kind: 'exact', answers: ['2'] });
  });

  it('projects concept asset text and formula blocks as summary and workspace display', () => {
    const concept = parseAsset({ kind: 'concept', title: '牛顿第二定律', aliases: [], merged_into: null,
      blocks: [{ id: 'summary', parentId: null, body: { kind: 'text', text: '合外力与加速度成正比：F=ma' } }] });
    expect(assetSummary(concept)).toBe('合外力与加速度成正比：F=ma');
    expect(assetWorkspaceDisplay(concept)).toMatchObject({ title: '牛顿第二定律', kind: 'concept', text: '合外力与加速度成正比：F=ma' });
    const discipline = parseAsset({ kind: 'discipline', title: '物理', blocks: [],
      discipline_context: { learningScope: '高中物理', mastery: '中档题独立求解', assessment: ['限时测'], boundaries: ['不超纲'] } });
    expect(assetWorkspaceDisplay(discipline)).toMatchObject({ title: '物理', kind: 'discipline', text: expect.stringContaining('学习范围：高中物理') });
    const empty = parseAsset({ kind: 'concept', title: '空概念', aliases: [], merged_into: null, blocks: [] });
    expect(assetSummary(empty)).toBeNull();
  });
});

describe('Wave Feature-1 pure authoring command builders', () => {
  const id = (tail: string) => `01KFS4AAA000000000000000${tail}`;
  it('builds schema-valid textbook, revision and variant writes with protected append-only edits', async () => {
    const concept = { id: id('01'), rev: 2, accessEpoch: '3', type: 'content.asset', kind: 'concept', title: '牛顿第二定律' }, source = { id: id('02'), rev: 1, epoch: '0', type: 'capture.source', kind: 'material', title: '讲义' };
    const built = await buildAuthoredTextbookCommands({ requestId: 'lesson-1', context: { concept, sourceSnippets: [source] }, draft: { mode: 'full', title: '受力分析', summary: '从合外力出发。', sections: [{ heading: '公式', kind: 'formula', body: '先分解重力。', latex: 'F=ma', bullets: ['确定研究对象', '列方程'], table: [['量', '关系'], ['a', 'F/m']], sourceIds: [source.id] }] } });
    expect(built.commands.map(command => command.type)).toEqual(['content.createTextbookPage', 'content.createKnowledgeEdge', 'content.createKnowledgeEdge']); expect(built.commands[0]?.input).toMatchObject({ clientEditSeq: 0, purpose: ['storage', 'teaching'], page: { basis: expect.arrayContaining([{ id: source.id, rev: 1, epoch: '0', type: 'capture.source' }]) } }); expect(built.commands[1]?.input).toMatchObject({ edge: { kind: 'explains', from: { sourceUse: { rev: 1, accessEpoch: '0' } } } });
    const proposal = await buildCompanionTextbookRevisionProposal({ id: built.summary.id, rev: 1 as Revision, blocks: [{ id: 'manual', parentId: null, body: { kind: 'text', text: '本人笔记' } }], retiredBlockIds: ['retired'] }, { dedupKey: 'add-1', rationale: '补充错因', proposedAddition: '只追加，不改写。' });
    expect(proposal).toMatchObject({ actor: 'companion', changeSummary: '补充错因', input: { edits: [{ kind: 'insert_after', afterId: 'manual' }] } });
    await expect(buildAuthoredTextbookCommands({ requestId: 'empty', context: { hasSufficientBasis: false }, draft: { mode: 'full', title: '无依据' } })).rejects.toBeInstanceOf(TextbookAuthoringNotFoundError);
  });
  it('deduplicates prompts, extracts answers and creates variant/pitfall edges while retaining legacy parsing', async () => {
    const witnesses = [{ id: id('01'), rev: 2, epoch: '3', type: 'content.asset', kind: 'concept' }, { id: id('03'), rev: 4, epoch: '0', type: 'content.asset', kind: 'question' }, { id: id('04'), rev: 1, epoch: '0', type: 'activity.workbookAttempt' }], drafts = [{ prompt: '重复题干', answer: '略', explanation: '略' }, { title: '斜面变式', prompt: '改变斜面倾角后，加速度如何变化？', answer: 'a=g sinθ', explanation: '分解重力。', rubric: ['写出受力方程', '说明单调性'], hints: ['先画受力图', '沿斜面分解', '比较正弦值'], difficulty: 'standard', variantRationale: '改变倾角', sourceIds: [witnesses[1]!.id] }];
    const result = await buildAuthoredQuestionCommands({ requestId: 'variant-1', mode: 'mistake_variant', sourceQuestionId: witnesses[1]!.id, mistakeWitnessId: witnesses[2]!.id, witnesses, conceptIds: [witnesses[0]!.id], existingQuestionPrompts: ['重复题干'], drafts });
    expect(result.commands.map(command => command.type)).toEqual(['content.saveQuestion', 'content.createKnowledgeEdge', 'content.createKnowledgeEdge', 'content.createKnowledgeEdge']);
    expect(questionSolutionFields((result.commands[0]!.input as unknown as { asset: Parameters<typeof questionSolutionFields>[0] }).asset)).toMatchObject({ answer: 'a=g sinθ', rubric: expect.stringContaining('写出受力方程\n说明单调性') });
    expect(result.commands[1]?.input).toMatchObject({ edge: { kind: 'targets_concept', to: { sourceUse: { id: witnesses[0]!.id } } } }); expect(result.commands[2]?.input).toMatchObject({ edge: { kind: 'variant_of', variant: { familyId: witnesses[1]!.id, preserved: ['核心考查目标与解题模型'], changed: ['改变倾角'], spoilsNext: 'none' } } }); expect(result.commands[3]?.input).toMatchObject({ edge: { kind: 'addresses_pitfall', to: { kind: 'work', sourceUse: { id: witnesses[2]!.id } } } });
    expect(parseSaveQuestion({ title: '旧接口', prompt: '仍兼容' })).toEqual({ kind: 'create', question: { title: '旧接口', prompt: '仍兼容' } });
  });
});
