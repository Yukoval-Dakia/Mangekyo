import { describe, expect, it } from 'vitest';
import { factId, learnerId, type FactId, type Revision } from '@mangekyo/kernel'; import { applyAssetQuestionSolutions, assetSummary, assetWorkspaceDisplay, parseAsset, questionSolutionFields, type QuestionAsset } from './asset.ts';
import { buildAuthoredQuestionCommands, parseSaveQuestion, QuestionAuthoringError } from './question-authoring.ts'; import { parseQuestionMetaProposal, parseQuestionWrite } from './question-writes.ts';
import { parseKnowledgeEdge, type KnowledgeEdge } from './knowledge-edge.ts'; import { findUnexposedVariantInPool } from './variant-pool.ts'; import { buildAuthoredTextbookCommands, buildCompanionTextbookRevisionProposal, TextbookAuthoringNotFoundError } from './textbook-authoring.ts'; import { evaluateExtendedQuestionCriterion, evaluateMultiSchemeBest, evaluateNumericEquivalence, evaluateRangeConstraint, isExtendedQuestionEvaluator, multiSchemeBestEvaluator, numericEquivalenceEvaluator, rangeConstraintEvaluator, validateExtendedQuestionCriterion, type AnswerSlot, type AssessmentCriterion } from './assessment-values.ts'; import { buildQuestionMetaGardeningProposal, selectQuestionsForMetaGardening } from './question-meta-gardening.ts'; import { buildWorkspaceQuestionCommands } from './workspace-slice.ts';

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
  const id = (tail: string): FactId => factId(`01KFS4AAA000000000000000${tail}`);
  const variantEdge = (suffix: string, from: string, to: string, relation: 'single_condition' | 'representation_transfer' | 'numbers_only' | 'translation' | undefined, spoilsNext: 'unknown' | 'none' | 'former' | 'latter', familyId = 'family') => ({ id: id(suffix), edge: parseKnowledgeEdge({ kind: 'variant_of', from: { kind: 'question', sourceUse: { id: id(from), rev: 1, accessEpoch: '0' } }, to: { kind: 'question', sourceUse: { id: id(to), rev: 1, accessEpoch: '0' } }, sourceUses: [{ id: id(from), rev: 1, accessEpoch: '0' }, { id: id(to), rev: 1, accessEpoch: '0' }], scope: '变式', variant: { familyId, relation, preserved: ['目标'], changed: relation === 'single_condition' ? ['倾角'] : ['数字', '情境'], spoilsNext } }) as KnowledgeEdge });
  it('builds schema-valid textbook, revision and variant writes with protected append-only edits', async () => {
    const concept = { id: id('01'), rev: 2, accessEpoch: '3', type: 'content.asset', kind: 'concept', title: '牛顿第二定律' }, source = { id: id('02'), rev: 1, epoch: '0', type: 'capture.source', kind: 'material', title: '讲义' };
    const built = await buildAuthoredTextbookCommands({ requestId: 'lesson-1', context: { concept, sourceSnippets: [source] }, draft: { mode: 'full', title: '受力分析', summary: '从合外力出发。', sections: [{ heading: '公式', kind: 'formula', body: '先分解重力。', latex: 'F=ma', bullets: ['确定研究对象', '列方程'], table: [['量', '关系'], ['a', 'F/m']], sourceIds: [source.id] }] } });
    expect(built.commands.map(command => command.type)).toEqual(['content.createTextbookPage', 'content.createKnowledgeEdge', 'content.createKnowledgeEdge']); expect(built.commands[0]?.input).toMatchObject({ clientEditSeq: 0, purpose: ['storage', 'teaching'], page: { basis: expect.arrayContaining([{ id: source.id, rev: 1, epoch: '0', type: 'capture.source' }]) } }); expect(built.commands[1]?.input).toMatchObject({ edge: { kind: 'explains', from: { sourceUse: { rev: 1, accessEpoch: '0' } } } });
    const proposal = await buildCompanionTextbookRevisionProposal({ id: built.summary.id, rev: 1 as Revision, blocks: [{ id: 'manual', parentId: null, body: { kind: 'text', text: '本人笔记' } }], retiredBlockIds: ['retired'] }, { dedupKey: 'add-1', rationale: '补充错因', proposedAddition: '只追加，不改写。' }); expect(proposal).toMatchObject({ actor: 'companion', changeSummary: '补充错因', input: { edits: [{ kind: 'insert_after', afterId: 'manual' }] } });
    await expect(buildAuthoredTextbookCommands({ requestId: 'empty', context: { hasSufficientBasis: false }, draft: { mode: 'full', title: '无依据' } })).rejects.toBeInstanceOf(TextbookAuthoringNotFoundError);
    const retained = await buildAuthoredTextbookCommands({ requestId: 'retain-rev', context: { witnesses: [{ id: concept.id, rev: 2, epoch: '5',
      type: concept.type, kind: concept.kind }], concept: { id: concept.id, title: concept.title } },
      draft: { mode: 'full', title: '保留真实见证', sections: [{ heading: '正文', kind: 'overview', body: '内容' }] } });
    expect((retained.commands[0]!.input as any).page.basis.filter((basis: any) => basis.id === concept.id))
      .toEqual([{ id: concept.id, rev: 2, epoch: '5', type: 'content.asset' }]);
  });
  it('deduplicates prompts, extracts answers and creates variant/pitfall edges while retaining legacy parsing', async () => {
    const witnesses = [{ id: id('01'), rev: 2, epoch: '3', type: 'content.asset', kind: 'concept', title: '牛顿第二定律' }, { id: id('03'), rev: 4, epoch: '0', type: 'content.asset', kind: 'question' }, { id: id('04'), rev: 1, epoch: '0', type: 'activity.workbookAttempt' }], drafts = [{ prompt: '重复题干', answer: '略', explanation: '略' }, { title: '斜面变式', prompt: '改变斜面倾角后，加速度如何变化？', answer: 'a=g sinθ', explanation: '分解重力。', rubric: ['写出受力方程', '说明单调性'], hints: ['先画受力图', '沿斜面分解', '比较正弦值'], difficulty: 'standard', variantRationale: '改变倾角', sourceIds: [witnesses[1]!.id], verification: { status: 'verified', summary: '数值代入一致' }, discriminator: { term: '斜面倾角', change: '仅增大倾角', before: '原加速度', after: ['增大', '减小'] as [string, string] } }];
    const result = await buildAuthoredQuestionCommands({ requestId: 'variant-1', mode: 'mistake_variant', sourceQuestionId: witnesses[1]!.id, mistakeWitnessId: witnesses[2]!.id, witnesses, conceptIds: [witnesses[0]!.id], existingQuestionPrompts: ['重复题干'], drafts });
    expect(result.commands.map(command => command.type)).toEqual(['content.saveQuestion', 'content.proposeQuestionMeta', 'content.createKnowledgeEdge', 'content.createKnowledgeEdge', 'content.createKnowledgeEdge']);
    const meta = parseQuestionMetaProposal(result.commands[1]!.input); expect(meta.append_metadata.solutions[0]?.explanation).toContain('数值代入一致'); expect(meta.append_metadata).toMatchObject({ hint_ladder: { l1: '先画受力图' }, tags: [{ kind: 'target_skill', term: '牛顿第二定律' }, { kind: 'discriminator', contrast: { change: '仅增大倾角', after: ['增大', '减小'] } }] }); expect(meta.basis).toContainEqual({ id: result.questions[0]!.id, rev: 1, epoch: '0', type: 'content.asset' }); expect(parseQuestionWrite(result.commands[0]!.input)).toMatchObject({ id: result.questions[0]!.id, teaching: true }); expect(result.commands[0]!.input).toMatchObject({ purpose: 'teaching' }); expect(result.commands[0]!.input).not.toHaveProperty('teaching');
    expect(questionSolutionFields((result.commands[0]!.input as unknown as { asset: Parameters<typeof questionSolutionFields>[0] }).asset)).toMatchObject({ answer: 'a=g sinθ', rubric: expect.stringContaining('写出受力方程\n说明单调性') });
    expect(result.commands[2]?.input).toMatchObject({ edge: { kind: 'targets_concept', to: { sourceUse: { id: witnesses[0]!.id } } } }); expect(result.commands[3]?.input).toMatchObject({ edge: { kind: 'variant_of', variant: { familyId: witnesses[1]!.id, relation: 'single_condition', preserved: ['核心考查目标与解题模型'], changed: ['改变倾角'], spoilsNext: 'unknown' } } }); expect(result.commands[4]?.input).toMatchObject({ edge: { kind: 'addresses_pitfall', to: { kind: 'work', sourceUse: { id: witnesses[2]!.id } } } });
    expect(parseSaveQuestion({ title: '旧接口', prompt: '仍兼容' })).toEqual({ kind: 'create', question: { title: '旧接口', prompt: '仍兼容' } });
    const exposures: string[] = [], pool = [variantEdge('05', '10', '11', 'single_condition', 'unknown'), variantEdge('06', '10', '11', 'numbers_only', 'none'), variantEdge('07', '11', '12', 'representation_transfer', 'none'), variantEdge('08', '10', '13', 'single_condition', 'former'), variantEdge('09', '10', '14', 'translation', 'none')], selected = await findUnexposedVariantInPool({ sourceQuestionId: id('10'), edges: pool, excludeIds: new Set([id('11')]), isExposed: questionId => (exposures.push(questionId), questionId === id('13')) }); expect(selected).toMatchObject({ questionId: id('12'), relation: 'representation_transfer', hop: 2 }); expect(exposures).toEqual([id('13'), id('12')]); await expect(findUnexposedVariantInPool({ sourceQuestionId: id('10'), edges: pool, excludeIds: new Set([id('11'), id('12'), id('13')]), isExposed: () => false })).resolves.toBeUndefined();
  });
});

describe('Wave Feature-2 evaluators, gardening and workspace question commands', () => { const wid = (tail: string): FactId => factId(`01KFS4AAA000000000000000${tail}`), num = (value: number, unit: string | null = null) => ({ kind: 'numeric', value, unit }) as const, txt = (value: string) => ({ kind: 'text', value }) as const, brk = (ids: string[]) => ({ kind: 'structured', value: { kind: 'breaks', ids } }) as const, criterion = (evaluator: object, parameters: AssessmentCriterion['parameters'], inputs = 1, maximum = 3): AssessmentCriterion => ({ criterionId: 'c1', inputs: Array.from({ length: inputs }, (_, index) => ({ slotId: 's', path: `/${index}` })), evaluator: evaluator as never, parameters, source: { kind: 'product-rubric', ref: { id: wid('21'), rev: 1 as Revision } }, maximum, missingEvidence: 'insufficient-evidence' });
  it('scores rational-exact numeric, weighted multi-scheme order-insensitive breaks and decaying range answers', () => { const eq = criterion(numericEquivalenceEvaluator, { expected: '-1.5', tolerance: 0 }), slots: AnswerSlot[] = [{ slotId: 's', schemaVersion: '1', fields: [{ path: '/0', kind: 'text' }, { path: '/1', kind: 'structured' }] }];
    expect(evaluateNumericEquivalence(eq, [txt('-6/4')])).toMatchObject({ matched: true, proportion: 1, earned: 3 }); expect(evaluateExtendedQuestionCriterion(eq, [txt('-6/4')])).toBe(1); expect(evaluateExtendedQuestionCriterion(criterion(numericEquivalenceEvaluator, { expected: 0.5, tolerance: 0.01 }), [txt('0.5 m/s')])).toBe(1); expect(evaluateExtendedQuestionCriterion(criterion(numericEquivalenceEvaluator, { expected: '2.5e-1', tolerance: 0, unit: 'kg' }), [txt('0.25 kg')])).toBe(1); expect(evaluateExtendedQuestionCriterion(criterion(numericEquivalenceEvaluator, { expected: 1, tolerance: 0, unit: 'kg' }), [num(1, 'g')])).toBe(0);
    const schemes = criterion(multiSchemeBestEvaluator, { schemes: [{ schemeId: 'a', match: 'proportional', answers: [txt('甲'), brk(['x', 'y'])] }, { schemeId: 'b', weight: 0.5, answers: [txt('乙'), brk(['z'])] }] }, 2, 4), range = criterion(rangeConstraintEvaluator, { target: 10, tolerance: 2, partialMargin: 4 });
    expect(evaluateMultiSchemeBest(schemes, [txt('甲'), brk(['y', 'x'])])).toMatchObject({ matched: true, proportion: 1, earned: 4, bestSchemeIndex: 0, bestSchemeId: 'a' }); expect(evaluateExtendedQuestionCriterion(schemes, [txt('乙'), brk(['z'])])).toBe(0.5); expect(evaluateExtendedQuestionCriterion(schemes, [txt('乙'), brk(['x', 'x'])])).toBe(0);
    expect(evaluateRangeConstraint(range, [num(15)])).toMatchObject({ proportion: 0.25, earned: 0.75 }); expect(evaluateExtendedQuestionCriterion(range, [{ kind: 'structured', value: { kind: 'range', value: 9, unit: null } }])).toBe(1); expect(evaluateExtendedQuestionCriterion(range, [txt('20')])).toBe(0); expect(validateExtendedQuestionCriterion(schemes, slots)).toBeUndefined(); expect(() => validateExtendedQuestionCriterion(range, [{ slotId: 's', schemaVersion: '1', fields: [{ path: '/0', kind: 'attachment' }] }])).toThrow(); expect(isExtendedQuestionEvaluator(rangeConstraintEvaluator)).toBe(true); expect(isExtendedQuestionEvaluator({ id: 'x', version: '1' })).toBe(false); });
  it('selects gardening gaps deterministically and builds sticky-safe idempotent calibration proposals', () => { const promptRef = JSON.stringify({ v: 1, fact: { id: wid('30'), rev: 2, type: 'content.asset' }, anchor: { kind: 'block', blockId: 'prompt' } }), draft = parseQuestionMetaProposal({ id: wid('30'), expectedRev: 2, append_metadata: { solutions: [{ method: '参考解法', explanation: '略', source_ref: promptRef }], tags: [{ kind: 'target_skill', term: 'x', scope: '本题', source_ref: promptRef }], hint_ladder: { l1: '先看条件', l2: '列式', l3: '完整解', source_ref: promptRef } }, basis: [{ id: wid('30'), rev: 2, epoch: '7', type: 'content.asset' }] });
    const candidates = [{ id: wid('30'), rev: 2 as Revision, accessEpoch: '7', purpose: ['teaching'], title: 'T', prompt: 'P', metaDraft: { ...draft, sticky: true }, attemptDurationsMs: [30_000, 60_000, 40_000] }, { id: wid('31'), rev: 1 as Revision, accessEpoch: '0', purpose: ['teaching'], title: 'T2', prompt: 'P2', metaDraft: null }], picks = selectQuestionsForMetaGardening(candidates);
    expect(picks.map(entry => entry.candidate.id)).toEqual([wid('31'), wid('30')]); expect(picks[1]?.gaps).toEqual(['missing_discriminator', 'missing_time_calibration']); expect(picks[1]?.durationCalibration).toMatchObject({ sampleCount: 3, medianSeconds: 40, p75Seconds: 60 }); expect(picks[1]?.lockedStickyFields).toHaveLength(3);
    const proposal = buildQuestionMetaGardeningProposal({ ...candidates[0]!, metaRev: 3 as Revision }, { tags: [{ kind: 'target_skill', term: 'x', scope: '本题', source_ref: promptRef }, { kind: 'discriminator', term: '条件', scope: '变式辨别', source_ref: promptRef }], solutions: [{ method: '参考解法', explanation: '覆盖', source_ref: promptRef }], hint_ladder: { l1: '先读题', l2: '关键第一步', l3: '完整思路', source_ref: promptRef } });
    expect(proposal).toMatchObject({ type: 'content.proposeQuestionMeta', added: { tags: 1, solutions: 1, hintLadder: false, timeCalibration: true } }); expect(proposal?.skippedStickyFields).toHaveLength(3);
    const meta = parseQuestionMetaProposal(proposal!.input); expect(meta.expectedRev).toBe(2); expect(meta.expectedMetaRev).toBe(3); expect(meta.append_metadata.tags).toHaveLength(1); expect(meta.append_metadata.tags[0]).toMatchObject({ kind: 'discriminator' }); expect(meta.append_metadata.hint_ladder).toBeUndefined();
    expect(meta.append_metadata.solutions).toHaveLength(1); expect(meta.append_metadata.solutions[0]?.method).toBe('作答耗时校准'); expect(meta.append_metadata.solutions[0]?.explanation).toBe('基于 3 次真实作答，中位耗时 40 秒（P75 60 秒）。'); expect(meta.basis).toContainEqual({ id: wid('30'), rev: 2, epoch: '7', type: 'content.asset' }); expect(buildQuestionMetaGardeningProposal({ ...candidates[1]!, metaDraft: { ...draft, sticky: false } }, { includeTimeCalibration: false })).toBeNull(); expect(buildQuestionMetaGardeningProposal({ ...candidates[0]!, metaDraft: { ...parseQuestionMetaProposal({ id: wid('30'), expectedRev: 2, append_metadata: proposal!.input.append_metadata, basis: proposal!.input.basis }), sticky: false }, metaRev: 4 as Revision }, { tags: [{ kind: 'discriminator', term: '条件', scope: '变式辨别', source_ref: promptRef }], includeTimeCalibration: false })).toBeNull(); });
  it('builds create and revise command batches resolving opened interaction, citation and shared-material references', async () => { const learner = learnerId('01KFS4AAA00000000000000099'), opened = [{ id: wid('40'), rev: 1, epoch: '3', type: 'capture.source' }], ref = JSON.stringify({ v: 1, fact: { id: wid('40'), rev: 1, type: 'capture.source' }, anchor: { kind: 'block', blockId: 'm1' } });
    const created = parseSaveQuestion({ title: '题', prompt: '题干', interaction: { version: 1 }, sources: [ref], shared_materials: [wid('40')] }), batch = buildWorkspaceQuestionCommands(created, { id: wid('41'), learner, purpose: 'teaching', basis: opened, questionEpoch: '5' });
    expect(batch.commands.map(command => command.type)).toEqual(['content.saveQuestion']); expect((parseQuestionWrite(batch.commands[0]!.input) as { asset: QuestionAsset }).asset.blocks.map(block => block.body.kind)).toEqual(['text', 'interaction', 'reference', 'sharedMaterial']); expect((parseQuestionWrite(batch.commands[0]!.input) as { asset: QuestionAsset }).asset.basis).toContainEqual({ id: wid('40'), rev: 1, epoch: '3', type: 'capture.source' }); expect(() => buildWorkspaceQuestionCommands(created, { id: wid('41'), basis: opened })).toThrow(QuestionAuthoringError);
    const withMeta = buildWorkspaceQuestionCommands(parseSaveQuestion({ title: '题', prompt: '题干', append_metadata: { tags: [{ kind: 'target_skill', term: 'x', scope: '本题', source_ref: JSON.stringify({ v: 1, fact: { id: wid('41'), rev: 1, type: 'content.asset' }, anchor: { kind: 'block', blockId: 'prompt' } }) }] } }), { id: wid('41'), basis: [] });
    expect(withMeta.commands.map(command => command.type)).toEqual(['content.saveQuestion', 'content.proposeQuestionMeta']); expect((withMeta.commands[1]!.input as { expectedRev: number }).expectedRev).toBe(1); expect((withMeta.commands[1]!.input as { basis: unknown[] }).basis).toContainEqual({ id: wid('41'), rev: 1, epoch: '0', type: 'content.asset' });
    const rb = buildWorkspaceQuestionCommands(parseSaveQuestion({ ref: wid('41'), expected_rev: 3, patch: { interaction: { version: 1 }, sources: [ref], shared_materials: [wid('40')] } }), { id: wid('41'), learner, basis: opened }), patch = (rb.commands[0]!.input as { patch: Record<string, { body: { kind: string } }[]> }).patch;
    expect(rb.commands).toHaveLength(1); expect((rb.commands[0]!.input as { expectedRev: number }).expectedRev).toBe(3); expect('expectedRev' in parseQuestionWrite(rb.commands[0]!.input)).toBe(true); expect(patch.interaction?.[0]?.body.kind).toBe('interaction'); expect(patch.sources?.[0]?.body.kind).toBe('reference'); expect(patch.shared_materials?.[0]?.body.kind).toBe('sharedMaterial');
    const metaOnly = buildWorkspaceQuestionCommands(parseSaveQuestion({ ref: wid('41'), expected_rev: 3, append_metadata: { solutions: [{ method: '新解法', explanation: '略' }] } }), { id: wid('41'), learner, basis: opened });
    expect(metaOnly.commands.map(command => command.type)).toEqual(['content.proposeQuestionMeta']); expect((metaOnly.commands[0]!.input as { expectedRev: number }).expectedRev).toBe(3);
    const authored = await buildAuthoredQuestionCommands({ requestId: 'interactive-1', mode: 'concept_gap', witnesses: [], drafts: [{ prompt: '读数是多少？', answer: '10', explanation: '读表盘。', format: 'interactive', interaction: { version: 1, title: '标尺' }, response_schema: [{ slotId: 'r', schemaVersion: '1', fields: [{ path: '', kind: 'structured' }] }], assessment_contract: [{ criterionId: 'c1', inputs: [{ slotId: 'r', path: '' }], evaluator: rangeConstraintEvaluator, parameters: { target: 10, tolerance: 1 }, maximum: 2, missingEvidence: 'insufficient-evidence' }] }] });
    expect((parseQuestionWrite(authored.commands[0]!.input) as { asset: QuestionAsset }).asset).toMatchObject({ blocks: expect.arrayContaining([expect.objectContaining({ id: 'interaction', body: { kind: 'interaction', view: { version: 1, title: '标尺' } } })]), response_schema: expect.any(Array), assessment_contract: expect.any(Array) }); });
});
