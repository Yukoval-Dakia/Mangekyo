import { factId, isJson, type FactId, type JsonObject, type Revision, type Tick } from '@mangekyo/kernel';
import { compact, fields, key, record, revision, safeSlice, text } from './parse.ts';
import { parseQuestionMetaProposal, parseQuestionWrite } from './question-writes.ts';
import { assetType, freezeQuestionAssessment } from './asset.ts';
import { isExtendedQuestionEvaluator, validateExtendedQuestionCriterion } from './assessment-values.ts';
import { questionTagKey, validateQuestionMetaReferences } from './question-state.ts';
import { parseEdgeWrite } from './knowledge-edge.ts';
import { contentStableId } from './knowledge-entity.ts';
import { authoringEndpointKind, authoringSourceUse, authoringWitness, type AuthoringWitnessInput } from './textbook-authoring.ts';

const questionFields = ['title', 'prompt', 'response_schema', 'assessment_contract', 'interaction', 'sources', 'shared_materials'] as const;
const tagKinds = ['target_skill', 'prerequisite', 'optional_method', 'discriminator'] as const;
const variantRelations = [
  'same_source', 'translation', 'numbers_only', 'single_condition', 'representation_transfer', 'confusable',
] as const;
const spoilsNextValues = ['unknown', 'none', 'former', 'latter'] as const;

export class QuestionAuthoringError extends Error {
  constructor(readonly code: 'invalid_args' | 'limit_exceeded', readonly field: string, message: string) {
    super(message);
  }
}

function invalid(field: string, message: string): never {
  throw new QuestionAuthoringError('invalid_args', field, message);
}

function bounded(value: unknown, field: string, length: number, allowEmpty = false) {
  if (typeof value === 'string' && value.length > length)
    throw new QuestionAuthoringError('limit_exceeded', field, `${field}超过 ${length} 字。`);
  return text(value, field, allowEmpty);
}

function array(value: unknown, field: string, limit: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum) invalid(field, `${field}须为列表。`);
  if (value.length > limit) throw new QuestionAuthoringError('limit_exceeded', field, `${field}最多 ${limit} 项。`);
  return value;
}

function jsonObject(value: unknown, field: string): JsonObject {
  const object = record(value);
  if (!isJson(object)) invalid(field, `${field}须为 JSON 对象。`);
  if (JSON.stringify(object).length > 48_000) throw new QuestionAuthoringError('limit_exceeded', field, `${field}载荷过大。`);
  return object;
}

function source(value: unknown) { return bounded(value, '来源引用', 4096); }

function references(value: unknown, field: string) {
  const parsed = array(value, field, 8).map(source);
  if (new Set(parsed).size !== parsed.length) invalid(field, '已打开的引用不能重复。');
  return parsed;
}

function parseHintLadder(input: unknown) {
  const value = record(input);
  fields(value, 'l1', 'l2', 'l3', 'worked_example', 'source_ref');
  const l1 = bounded(value.l1, 'L1 方向轻推', 25);
  if (/[\r\n\u2028\u2029]/u.test(l1)) throw new Error('L1 方向轻推须为单行。');
  return compact({
    l1, l2: bounded(value.l2, 'L2 关键第一步', 1600), l3: bounded(value.l3, 'L3 完整思路与参考解', 4000),
    worked_example: value.worked_example === undefined ? undefined : bounded(value.worked_example, 'L3 局部示范', 1600),
    source_ref: source(value.source_ref),
  });
}

export function parseQuestionMetadata(input: unknown, allowEmpty = false) {
  const value = record(input);
  fields(value, 'solutions', 'tags', 'hint_ladder');
  const ladder = value.hint_ladder === undefined ? undefined : parseHintLadder(value.hint_ladder);
  const solutions = array(value.solutions ?? [], 'solutions', 8).map(entry => {
    const solution = record(entry);
    fields(solution, 'method', 'explanation', 'source_ref', 'steps', 'hints', 'discriminator');
    const steps = array(solution.steps ?? [], 'steps', 16).map((step, index) => bounded(step, `步骤 ${index + 1}`, 1600));
    const hints = array(solution.hints ?? [], 'hints', 3).map((hint, index) => bounded(hint, `提示 L${index + 1}`, 1600));
    return compact({
      method: bounded(solution.method, '解法名称', 160), explanation: bounded(solution.explanation, '解法步骤', 4000),
      steps: steps.length ? steps : undefined, hints: hints.length ? hints : undefined,
      discriminator: solution.discriminator === undefined ? undefined : bounded(solution.discriminator, '最短辨别题', 4000),
      source_ref: solution.source_ref === undefined ? undefined : source(solution.source_ref),
    });
  });
  const tags = array(value.tags ?? [], 'tags', 16).map(entry => {
    const tag = record(entry);
    fields(tag, 'kind', 'term', 'scope', 'source_ref', 'version', 'contrast');
    const contrast = tag.contrast === undefined ? undefined : record(tag.contrast);
    if (contrast) fields(contrast, 'change', 'before', 'after');
    const kind = tagKinds.find(item => item === tag.kind);
    if (!kind) invalid('tags', '术语标签类别无效。');
    if (contrast && kind !== 'discriminator') throw new Error('最小条件改变只属于辨别标签。');
    let discriminator;
    if (contrast) {
      const before = bounded(contrast.before, '原条件下的预测', 500);
      const after = array(contrast.after, '辨别结果', 2, 2).map(item => bounded(item, '改变后的预测', 500));
      if (after[0] === after[1]) throw new Error('变式后的两种预测必须分离。');
      discriminator = { change: bounded(contrast.change, '最小条件改变', 500), before, after };
    }
    return compact({ kind, term: bounded(tag.term, '术语', 64), scope: bounded(tag.scope, '适用范围', 240),
      source_ref: source(tag.source_ref), version: tag.version === undefined ? undefined : key(tag.version), contrast: discriminator });
  });
  if (!allowEmpty && !solutions.length && !tags.length && !ladder)
    invalid('append_metadata', '请填写解法、术语标签或三阶微提示。');
  return { solutions, tags, ...(ladder === undefined ? {} : { hint_ladder: ladder }) };
}

function promptPatch(input: unknown) {
  const value = record(input);
  fields(value, 'block_id', 'anchor', 'replacement');
  return {
    block_id: bounded(value.block_id, '题干块标识', 128), anchor: bounded(value.anchor, '题干锚点', 2000),
    replacement: bounded(value.replacement, '替换内容', 4000, true),
  };
}

function jsonArray32(raw: unknown, field: string, label: string) {
  return raw === undefined ? undefined : array(raw, field, 32, 1).map(entry => jsonObject(entry, label));
}

function frozenFields(value: Record<string, unknown>) {
  return compact({
    response_schema: jsonArray32(value.response_schema, 'response_schema', '作答位'),
    assessment_contract: jsonArray32(value.assessment_contract, 'assessment_contract', '评估标准'),
    interaction: value.interaction === undefined ? undefined : jsonObject(value.interaction, '交互块'),
    sources: value.sources === undefined ? undefined : references(value.sources, 'sources'),
    shared_materials: value.shared_materials === undefined ? undefined : references(value.shared_materials, 'shared_materials'),
  });
}

export function parseSaveQuestion(input: unknown) {
  try {
    const value = record(input);
    const metadata = value.append_metadata === undefined ? {} : { append_metadata: parseQuestionMetadata(value.append_metadata) };
    if (value.ref === undefined) {
      fields(value, ...questionFields, 'append_metadata');
      return { kind: 'create' as const, question: {
        title: bounded(value.title, 'title', 240).trim(), prompt: bounded(value.prompt, 'prompt', 8000), ...frozenFields(value),
      }, ...metadata };
    }
    fields(value, 'ref', 'expected_rev', 'patch', 'append_metadata');
    const patch = value.patch === undefined ? {} : record(value.patch);
    fields(patch, ...questionFields);
    if (!Object.keys(patch).length && !('append_metadata' in metadata))
      invalid('patch', '请传局部修改或要追加的解法、标签。');
    return {
      kind: 'revise' as const, ref: source(value.ref), expected_rev: revision(value.expected_rev),
      patch: compact({
        title: patch.title === undefined ? undefined : bounded(patch.title, 'title', 240).trim(),
        prompt: patch.prompt === undefined ? undefined : promptPatch(patch.prompt), ...frozenFields(patch),
      }),
      ...metadata,
    };
  } catch (error) {
    if (error instanceof QuestionAuthoringError) throw error;
    throw new QuestionAuthoringError('invalid_args', 'args', '请按题库新建参数或固定版本的局部修改格式填写。');
  }
}

export type AuthoredQuestionMode = 'concept_gap' | 'mistake_variant';
export type AuthoredQuestionDraftInput = {
  readonly title?: string; readonly prompt: string; readonly answer: string; readonly explanation?: string;
  readonly rubric?: string | readonly string[]; readonly hints?: readonly string[]; readonly difficulty?: string;
  readonly conceptIds?: readonly string[]; readonly sourceIds?: readonly string[]; readonly sourceQuestionId?: string;
  readonly errorStage?: string; readonly mistakeReason?: string; readonly variantRationale?: string;
  readonly variant?: {
    readonly familyId?: string; readonly preserved?: readonly string[]; readonly changed?: readonly string[];
    readonly relation?: 'same_source' | 'translation' | 'numbers_only' | 'single_condition' | 'representation_transfer' | 'confusable';
    readonly spoilsNext?: 'unknown' | 'none' | 'former' | 'latter';
  };
  readonly discriminator?: {
    readonly term?: string; readonly scope?: string; readonly change: string;
    readonly before: string; readonly after: readonly [string, string];
  };
  readonly verification?: { readonly status: string; readonly method?: string; readonly summary?: string };
  readonly format?: 'text' | 'interactive'; readonly interaction?: Readonly<Record<string, unknown>>;
  readonly response_schema?: readonly Readonly<Record<string, unknown>>[];
  readonly assessment_contract?: readonly Readonly<Record<string, unknown>>[];
};
export type AuthoredQuestionCommand = {
  readonly key: string; readonly type: 'content.saveQuestion' | 'content.createKnowledgeEdge' | 'content.proposeQuestionMeta';
  readonly input: JsonObject;
};
export type QuestionMetaOptions = {
  readonly purpose: 'storage' | 'teaching'; readonly questionEpoch?: string;
  readonly basis?: readonly { readonly id: string; readonly rev: number; readonly epoch: string; readonly type: string }[];
  readonly concepts?: readonly { readonly id: string; readonly title?: string | undefined }[];
};

function authoredVariant(draft: AuthoredQuestionDraftInput, sourceQuestionId: FactId) {
  const input = draft.variant;
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input) ||
      Object.keys(input).some(field => !['familyId', 'relation', 'preserved', 'changed', 'spoilsNext'].includes(field))))
    invalid('variant', '变式条件须为对象。');
  const conditions = (value: readonly string[] | undefined, fallback: string) => {
    if (value !== undefined && (!Array.isArray(value) || value.length > 32 || !value.length ||
        value.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000)))
      invalid('variant', '保留条件与改变条件须为非空字符串列表。');
    return value?.map(item => item.trim()) ?? [fallback];
  };
  const preserved = conditions(input?.preserved, '核心考查目标与解题模型');
  const changed = conditions(input?.changed, draft.variantRationale?.trim() || draft.mistakeReason?.trim() || '题面条件与具体情境');
  if (preserved.some(item => changed.includes(item))) invalid('variant', '保留条件与改变条件不能重叠。');
  const relation = input?.relation ?? (changed.length === 1 ? 'single_condition' : 'representation_transfer');
  const spoilsNext = input?.spoilsNext ?? 'unknown';
  if (!variantRelations.some(item => item === relation) || !spoilsNextValues.some(item => item === spoilsNext) ||
      (relation === 'single_condition' && changed.length !== 1))
    invalid('variant', '变式关系、改变条件或剧透方向无效。');
  const familyId = input?.familyId?.trim() || sourceQuestionId;
  try { key(familyId); }
  catch { invalid('variant', '变式族标识无效。'); }
  return { familyId, relation, preserved, changed, spoilsNext };
}

function authoredText(value: unknown, field: string, limit: number) {
  const result = bounded(value, field, limit).trim();
  if (!result) invalid(field, `${field}不能为空。`);
  return result;
}

function rubricText(draft: AuthoredQuestionDraftInput, field = 'rubric') {
  return draft.rubric === undefined ? undefined : Array.isArray(draft.rubric)
    ? array(draft.rubric, field, 16).map(item => authoredText(item, field, 1000)).filter(Boolean).join('\n') || undefined
    : authoredText(draft.rubric, field, 8000);
}

/** Build a proposal independently so a host can bind the epoch from its actual save receipt. */
export function buildAuthoredQuestionMetaProposal(questionRef: { readonly id: FactId }, draft: AuthoredQuestionDraftInput,
  options: QuestionMetaOptions) {
  const { id } = questionRef;
  const questionEpoch = options.questionEpoch ?? '0';
  const promptSourceRef = JSON.stringify({ v: 1, fact: { id, rev: 1, type: assetType }, anchor: { kind: 'block', blockId: 'prompt' } });
  const basis = [...new Map([{ id, rev: 1 as Revision, epoch: questionEpoch, type: assetType }, ...(options.basis ?? [])]
    .map(witness => [`${witness.id}:${witness.rev}`, witness])).values()];
  const answer = authoredText(draft.answer, 'answer', 4000);
  const rubric = rubricText(draft) ?? '';
  let explanation = [draft.explanation?.trim(), `参考答案：${answer}`, rubric ? `评分要点：${rubric}` : ''].filter(Boolean).join('\n');
  if (draft.verification?.status === 'verified')
    explanation += `\n独立验算：${draft.verification.summary?.trim() || draft.verification.method?.trim() || '已通过独立验算'}`;
  const discriminator = draft.discriminator;
  if (discriminator && (!Array.isArray(discriminator.after) || discriminator.after.length !== 2 ||
      authoredText(discriminator.after[0], 'discriminator.after', 500) === authoredText(discriminator.after[1], 'discriminator.after', 500)))
    invalid('discriminator', '变式后的两种预测必须分离。');
  type Tag = { kind: string; term: string; scope: string; source_ref: string;
    contrast?: { change: string; before: string; after: [string, string] } };
  // Concept titles may exceed the 64-character term cap, so truncation is code-point-safe by construction.
  const tags: Tag[] = (options.concepts ?? []).map(concept => ({ kind: 'target_skill',
    term: safeSlice(concept.title?.trim() || concept.id, 64), scope: '本题考查目标', source_ref: promptSourceRef }));
  if (discriminator) tags.push({ kind: 'discriminator', term: discriminator.term?.trim() || '最小条件辨别',
    scope: safeSlice(discriminator.scope?.trim() || '辨别条件改变前后的预测', 240), source_ref: promptSourceRef,
    contrast: { change: discriminator.change, before: discriminator.before, after: [discriminator.after[0], discriminator.after[1]] } });
  const uniqueTags = [...new Map(tags.map(tag => [questionTagKey(tag), tag])).values()];
  const append_metadata = compact({
    solutions: [{ method: '参考解法', explanation, ...(draft.hints?.length ? { hints: [...draft.hints] } : {}), source_ref: promptSourceRef }],
    tags: uniqueTags,
    hint_ladder: options.purpose === 'teaching' && draft.hints?.length === 3
      ? { l1: draft.hints[0]!, l2: draft.hints[1]!, l3: draft.hints[2]!, source_ref: promptSourceRef } : undefined,
  });
  try {
    const parsedMeta = parseQuestionMetaProposal({ id, expectedRev: 1, append_metadata, basis });
    validateQuestionMetaReferences({ ...parsedMeta, sticky: true });
    const input = { id, expectedRev: 1, append_metadata: parsedMeta.append_metadata, basis: parsedMeta.basis };
    return { key: '', type: 'content.proposeQuestionMeta' as const, input: input as unknown as JsonObject };
  } catch (error) {
    if (error instanceof QuestionAuthoringError) throw error;
    throw new QuestionAuthoringError('invalid_args', 'append_metadata', '题目活元信息或来源引用无效。');
  }
}

function normalizedPrompt(value: string) {
  // Core math operators survive normalization so `1+2=?` and `1-2=?` never collapse into the same signature.
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}+*/=<>^≠≤≥-]+/gu, '');
}

function bigrams(value: string) {
  const normalized = normalizedPrompt(value);
  return new Set(normalized.length < 2 ? [normalized]
    : Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)));
}

function similarPrompt(left: string, right: string) {
  if (normalizedPrompt(left) === normalizedPrompt(right)) return true;
  const a = bigrams(left), b = bigrams(right);
  const intersection = [...a].filter(item => b.has(item)).length;
  return intersection / (a.size + b.size - intersection) >= 0.85;
}

function authoredHints(value: readonly string[] | undefined) {
  if (value === undefined) return undefined;
  const hints = array(value, 'hints', 3).map((item, index) => authoredText(item, `hints[${index}]`, index === 0 ? 25 : 1600));
  if (hints.length === 3 && /[\r\n\u2028\u2029]/u.test(hints[0]!)) invalid('hints', 'L1 方向轻推须为单行。');
  return hints;
}

function questionEdge(id: FactId, purpose: 'storage' | 'teaching', edge: JsonObject): JsonObject {
  try { return parseEdgeWrite({ id, purpose, edge }) as unknown as JsonObject; }
  catch { throw new QuestionAuthoringError('invalid_args', 'conceptIds', '题目关系或依据无效。'); }
}

type Witness = NonNullable<ReturnType<typeof authoringWitness>>;

export async function buildAuthoredQuestionCommands(input: {
  readonly requestId: string; readonly mode: AuthoredQuestionMode;
  readonly drafts: readonly AuthoredQuestionDraftInput[]; readonly witnesses: readonly AuthoringWitnessInput[];
  readonly conceptIds?: readonly string[]; readonly sourceQuestionId?: string; readonly mistakeWitnessId?: string;
  readonly existingQuestionPrompts?: readonly string[]; readonly purpose?: 'storage' | 'teaching';
  readonly questionEpoch?: string;
}) {
  const requestId = authoredText(input.requestId, 'requestId', 128);
  if (input.mode !== 'concept_gap' && input.mode !== 'mistake_variant') invalid('mode', '题目创作模式无效。');
  const drafts = array(input.drafts, 'drafts', 3, 1) as readonly AuthoredQuestionDraftInput[];
  const purpose = input.purpose ?? 'teaching';
  const questionEpoch = input.questionEpoch ?? '0';
  if (!/^(0|[1-9][0-9]{0,18})$/.test(questionEpoch) || BigInt(questionEpoch) > 9223372036854775807n)
    invalid('questionEpoch', '题目访问代次无效。');
  if (purpose !== 'storage' && purpose !== 'teaching') invalid('purpose', '题目用途无效。');
  const witnesses = new Map<string, Witness>();
  for (const item of input.witnesses) {
    const witness = authoringWitness(item);
    if (witness) witnesses.set(witness.id, witnesses.get(witness.id) ?? witness);
  }
  const sourceQuestionId = input.sourceQuestionId ?? drafts.find(draft => draft.sourceQuestionId)?.sourceQuestionId;
  const sourceQuestion = sourceQuestionId === undefined ? undefined : witnesses.get(sourceQuestionId);
  if (input.mode === 'mistake_variant' && (!sourceQuestionId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(sourceQuestionId) || !sourceQuestion ||
      (!['content.asset:question', 'activity.workspaceEntry:question'].includes(sourceQuestion.type) &&
        !(sourceQuestion.type === 'content.asset' && sourceQuestion.kind === undefined)))) {
    invalid('sourceQuestionId', '错题变式需要原题的固定版本见证。');
  }
  const concepts = new Map<string, Witness>();
  for (const id of [...(input.conceptIds ?? []), ...drafts.flatMap(draft => draft.conceptIds ?? [])]) {
    const witness = witnesses.get(id);
    if (witness?.type === 'content.asset:concept' || witness?.type === 'activity.workspaceEntry:concept') concepts.set(id, witness);
  }
  const existing = array(input.existingQuestionPrompts ?? [], 'existingQuestionPrompts', 128)
    .map(item => authoredText(item, 'existingQuestionPrompts', 8000));
  const accepted: { readonly draft: AuthoredQuestionDraftInput; readonly prompt: string; readonly answer: string;
    readonly explanation?: string; readonly rubric?: string; readonly hints?: readonly string[] }[] = [];
  for (const draft of drafts) {
    const prompt = authoredText(draft.prompt, 'prompt', 8000);
    if (accepted.some(item => similarPrompt(item.prompt, prompt)) || existing.some(item => similarPrompt(item, prompt))) continue;
    const answer = authoredText(draft.answer, 'answer', 4000);
    const explanation = draft.explanation === undefined ? undefined : authoredText(draft.explanation, 'explanation', 8000);
    const rubric = rubricText(draft);
    if (!explanation && !rubric) invalid('explanation', '每道题需要解析或评分要点。');
    const hints = authoredHints(draft.hints);
    accepted.push(compact({ draft, prompt, answer, explanation, rubric, hints }) as (typeof accepted)[number]);
  }
  if (!accepted.length) invalid('drafts', '没有通过校验且不与现有题重复的新题。');
  const questions: { readonly id: FactId; readonly prompt: string; readonly difficulty?: string }[] = [];
  const commands: AuthoredQuestionCommand[] = [];
  for (const [index, item] of accepted.entries()) {
    const { draft } = item;
    const id = await contentStableId('content.authoredQuestion', requestId, input.mode, String(index), normalizedPrompt(item.prompt));
    const questionUse = { id, rev: 1 as Revision, accessEpoch: questionEpoch as Tick };
    // Each draft owns its own concept set: explicit draft.conceptIds intersect the witness pool, otherwise the shared input list.
    const draftConceptIds = draft.conceptIds?.length ? draft.conceptIds : (input.conceptIds ?? []);
    const draftConcepts = [...concepts.values()].filter(concept => draftConceptIds.includes(concept.id));
    const basis = [...new Map([...witnesses.values()]
      .filter(witness =>
        draftConcepts.some(concept => concept.id === witness.id) || witness.id === sourceQuestionId ||
        (draft.sourceIds ?? []).includes(witness.id))
      .map(witness => [witness.id, {
        id: witness.id, rev: witness.rev, epoch: witness.epoch, type: witness.type.split(':')[0]!,
      }] as const))
      .values()];
    if (draft.format !== undefined && draft.format !== 'text' && draft.format !== 'interactive') invalid('format', '题目形式无效。');
    const interaction = draft.interaction === undefined ? undefined : jsonObject(draft.interaction, 'interaction');
    const responseSchema = jsonArray32(draft.response_schema, 'response_schema', '作答位');
    const assessmentContract = jsonArray32(draft.assessment_contract, 'assessment_contract', '评估标准');
    const solution = `参考答案：${item.answer}${item.rubric ? `\n评分要点：${item.rubric}` : ''}`;
    const blocks = [{ id: 'prompt', parentId: null, body: { kind: 'text', text: item.prompt } },
      ...(interaction ? [{ id: 'interaction', parentId: null, body: { kind: 'interaction', view: interaction } }] : []),
      { id: 'answer', parentId: null, body: { kind: 'text', text: solution } },
      ...(item.explanation ? [{ id: 'explanation', parentId: null, body: { kind: 'text', text: item.explanation } }] : []),
      ...(item.hints?.length
        ? [{ id: 'hints', parentId: null, body: { kind: 'text', text: item.hints.map((hint, n) => `提示 L${n + 1}：${hint}`).join('\n') } }]
        : [])];
    const asset = compact({
      kind: 'question', title: draft.title?.trim() || safeSlice(item.prompt, 80), promptBlockId: 'prompt', blocks,
      response_schema: responseSchema, assessment_contract: assessmentContract, basis: basis.length ? basis : undefined,
    });
    try {
      const parsed = parseQuestionWrite({ id, asset, purpose });
      if (!('asset' in parsed)) throw new Error('题目缺少资产体。');
      if (parsed.asset.response_schema !== undefined && parsed.asset.assessment_contract !== undefined) {
        const frozen = freezeQuestionAssessment(parsed.asset, { id, rev: 1 as Revision }).items[0]!;
        for (const criterion of frozen.criteria) {
          if (isExtendedQuestionEvaluator(criterion.evaluator)) validateExtendedQuestionCriterion(criterion, frozen.slots);
        }
      }
      commands.push({
        key: `question-${index + 1}`, type: 'content.saveQuestion', input: { id, asset: parsed.asset, purpose } as unknown as JsonObject,
      });
    } catch { invalid('drafts', '题目不符合题库事实契约。'); }
    commands.push({ ...buildAuthoredQuestionMetaProposal({ id }, draft, {
      purpose, questionEpoch, basis,
      concepts: draftConcepts.map(concept => ({ id: concept.id, title: concept.title })),
    }), key: `meta-${index + 1}` });
    questions.push(compact({ id, prompt: item.prompt, difficulty: draft.difficulty || undefined }) as (typeof questions)[number]);
    const addEdge = async (kind: string, name: string, to: Witness, extra: JsonObject = {}) => {
      const target = authoringSourceUse(to);
      const targetKind = authoringEndpointKind(to);
      if (!targetKind) invalid('witnesses', '知识边端点体裁无效。');
      const edgeId = await contentStableId('content.authoredQuestionEdge', id, kind, to.id, String(to.rev));
      commands.push({ key: `${name}-${index + 1}`, type: 'content.createKnowledgeEdge', input: questionEdge(edgeId, purpose, {
        kind, from: { kind: 'question', sourceUse: questionUse }, to: { kind: targetKind, sourceUse: target },
        sourceUses: [questionUse, target],
        scope: safeSlice(draft.variantRationale ?? draft.mistakeReason ?? draft.explanation ?? item.prompt, 1000), ...extra }) });
    };
    for (const concept of draftConcepts) await addEdge('targets_concept', `concept-${concept.id}`, concept);
    if (sourceQuestion) await addEdge('variant_of', 'variant', sourceQuestion, { variant: authoredVariant(draft, factId(sourceQuestion.id)) });
    const mistake = input.mistakeWitnessId === undefined ? undefined : witnesses.get(input.mistakeWitnessId);
    if (mistake && ['work', 'claim'].includes(authoringEndpointKind(mistake) ?? '')) await addEdge('addresses_pitfall', 'mistake', mistake);
  }
  return { questions, commands };
}
