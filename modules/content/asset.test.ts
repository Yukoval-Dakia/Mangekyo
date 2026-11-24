import { describe, expect, it } from 'vitest';
import { applyAssetQuestionSolutions, assetSummary, assetWorkspaceDisplay, parseAsset, questionSolutionFields, type QuestionAsset } from './asset.ts';

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
