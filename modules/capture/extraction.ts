import type { EffectReceipt, EffectRequest, FactId, FactSnapshot, GatherContext, GatherInput, Outcome, ReadContext } from '@mangekyo/kernel';
import { questionPrompt, type QuestionAsset } from '@mangekyo/module-content/facts/asset-contract';
import { openQuestionForRelease } from '@mangekyo/module-content/facts/question-release';
import { captureObject, captureRef, captureText } from './parse.ts';
import { captureSourceType, requireSourceCropPage, sourceEnvelope, sourceBlocks, validSourceCropPage,
  type Block, type SourceEnvelope } from './source.ts';

export const layeredExtractionSlot = 'capture.layeredExtraction';
export const layeredExtractionDeriver = 'capture/layered-extraction-v1';
export const visualExtractionVersion = 'capture-visual-v1';
export const voiceTranscriptionVersion = 'capture-voice-v1';
export const visualExtractionEffect = 'capture.extractLayers';
export const voiceTranscriptionEffect = 'capture.transcribeVoice';

type VisualSource = Pick<SourceEnvelope, 'kind' | 'originals'>;

export function visualExtractionRequest(source: VisualSource, redInkMeaning?: string, modelMethod = visualExtractionVersion): EffectRequest {
  if (source.kind !== 'photo' && source.kind !== 'pdf' && source.kind !== 'paper-return')
    throw new Error('分层识别需要图像或 PDF。');
  return {
    label: visualExtractionEffect,
    stepKey: visualExtractionVersion,
    input: {
      version: visualExtractionVersion,
      modelMethod: captureText(modelMethod, '识别方法版本', 200),
      originals: source.originals,
      redInkMeaning: redInkMeaning === undefined ? null : captureText(redInkMeaning, '红笔说明', 400),
    },
  };
}

export type LayeredExtractionKey = {
  readonly target: ReturnType<typeof captureRef>;
  readonly accessEpoch: string;
  readonly modelMethod: string;
  readonly redInkMeaning?: string;
};

type LayeredPlan = {
  readonly basis: {
    readonly target: ReturnType<typeof captureRef>;
    readonly learner: FactSnapshot['ref']['learner'];
    readonly accessEpoch: string;
    readonly modelMethod: string;
  };
  readonly source: VisualSource;
  readonly effect: EffectRequest;
};

export type LayeredExtractionValue = {
  readonly basis: LayeredPlan['basis'];
  readonly originals: SourceEnvelope['originals'];
  readonly blocks: readonly Block[];
};

export async function gatherLayeredExtraction(ctx: GatherContext, key: LayeredExtractionKey): Promise<GatherInput<LayeredPlan>> {
  const target = captureRef(key.target);
  const fact = await ctx.read.fact(target.id, { mode: 'pinned', rev: target.rev });
  if (fact.type !== captureSourceType || fact.accessEpoch !== key.accessEpoch ||
      !mayExtract(fact))
    throw new Error('原件版本或识别用途已变更。');
  const { kind, originals } = sourceEnvelope(fact.value);
  const source = { kind, originals };
  const modelMethod = captureText(key.modelMethod, '识别方法版本', 200);
  const effect = visualExtractionRequest(source, key.redInkMeaning, modelMethod);
  const basis = { target, learner: ctx.learner, accessEpoch: fact.accessEpoch, modelMethod };
  // Carry the provenance descriptors, not learner text or previously read blocks, into durable work.
  return { kind: 'input', data: { basis, source, effect }, effects: [effect] };
}

export function settleLayeredExtraction(plan: LayeredPlan, receipts: readonly EffectReceipt[]): Outcome<LayeredExtractionValue> {
  const [receipt] = receipts;
  if (receipt && !sameJson(receipt.request, plan.effect))
    return { kind: 'unknown', reason: '识别回执与冻结请求不匹配。' };
  const result = visualExtractionResult(plan.source, receipts);
  return result.kind === 'unknown' ? result : {
    kind: 'value', value: { basis: plan.basis, originals: plan.source.originals, blocks: result.value },
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every(key =>
    Object.hasOwn(right, key) && sameJson(Reflect.get(left, key), Reflect.get(right, key)));
}

function parsedExtractionForSource(fact: FactSnapshot, source: SourceEnvelope, outcome: Outcome<LayeredExtractionValue> | null) {
  if (outcome?.kind !== 'value') return null;
  const { basis, originals, blocks } = outcome.value;
  if (!mayExtract(fact) || basis.target.id !== fact.ref.id || basis.learner !== fact.ref.learner || basis.target.rev > fact.ref.rev ||
      basis.accessEpoch !== fact.accessEpoch || !sameJson(originals, source.originals)) return null;
  return parseExtractionBlocks(source, blocks);
}

function validCropBranches(source: SourceEnvelope, blocks: readonly Block[]) {
  const retained = new Set<string>();
  return blocks.filter(({ id, parentId, body }) => {
    if ((parentId !== null && !retained.has(parentId)) ||
        (body.crop_ref && !validSourceCropPage(body.crop_ref, source.originals))) return false;
    retained.add(id);
    return true;
  });
}

function extractionForSource(fact: FactSnapshot, source: SourceEnvelope, outcome: Outcome<LayeredExtractionValue> | null) {
  const blocks = parsedExtractionForSource(fact, source, outcome);
  return blocks && validCropBranches(source, blocks);
}

// Only paper projection can reconstruct the old printable text from these blocks.
export function frozenPaperBlocks(fact: FactSnapshot, source: SourceEnvelope, outcome: Outcome<LayeredExtractionValue>) {
  const all = parsedExtractionForSource(fact, source, outcome);
  if (!all) throw new Error('分层抽取未获准用于此卷。');
  const valid = validCropBranches(source, all);
  return { blocks: mergeExtraction(source, valid),
    historical: valid.length === all.length ? null : mergeExtraction(source, all) };
}

export function mayExtract(fact: FactSnapshot) {
  return fact.purpose.includes('teaching') || fact.purpose.includes('learning');
}

export function mergeLayeredSource(fact: FactSnapshot, outcome: Outcome<LayeredExtractionValue> | null) {
  if (fact.type !== captureSourceType) throw new Error('不是捕获原件。');
  const source = sourceEnvelope(fact.value);
  const candidate = extractionForSource(fact, source, outcome);
  if (!candidate) return { source, differences: [] };
  const byId = new Map(candidate.map(block => [block.id, block]));
  const byCrop = new Map(candidate.map(block => [cropKey(block), block]));
  const differences = source.unit.blocks.flatMap(previous => {
    if (previous.body.status !== 'known' || !previous.body.sticky) return [];
    const key = cropKey(previous);
    const next = byId.get(previous.id) ?? (key ? byCrop.get(key) : undefined);
    if (next?.body.status === 'known' && next.body.text === previous.body.text && next.body.layer === previous.body.layer &&
        next.body.itemId === previous.body.itemId && next.body.slotId === previous.body.slotId)
      return [];
    return [{ blockId: previous.id, candidate: next?.body ?? null }];
  });
  return { source: { ...source, unit: { ...source.unit, blocks: mergeExtraction(source, candidate) } }, differences };
}

function parseExtractionBlocks(source: VisualSource, input: unknown): readonly Block[] {
  const blocks = sourceBlocks(input, source.kind, source.originals);
  for (const { body } of blocks) {
    if (body.status === 'known' ? body.sticky : body.clarification !== 'pending')
      throw new Error('自动抽取不得声明本人更正或已澄清。');
    if ((body.layer === 'prompt' || body.layer === 'handwriting') && !body.itemId)
      throw new Error('题干或手写内容缺少题目锚点。');
    if (body.layer === 'handwriting' && !body.slotId) throw new Error('手写内容缺少作答位。');
  }
  return blocks;
}

export function extractedBlocks(source: VisualSource, input: unknown): readonly Block[] {
  const blocks = parseExtractionBlocks(source, input);
  for (const { body } of blocks) requireSourceCropPage(body.crop_ref, source.originals);
  return blocks;
}

function effectResult(receipts: readonly EffectReceipt[], version: string, label: string) {
  const [receipt] = receipts;
  if (receipts.length !== 1 || receipt?.state !== 'done' || receipt.request.stepKey !== version ||
      receipt.request.label !== label || receipt.result === undefined) return null;
  const result = captureObject(receipt.result);
  if (result.version !== version) throw new Error('识别结果版本不匹配。');
  return result;
}

export function visualExtractionResult(source: VisualSource, receipts: readonly EffectReceipt[]): Outcome<readonly Block[]> {
  try {
    const result = effectResult(receipts, visualExtractionVersion, visualExtractionEffect);
    return result ? { kind: 'value', value: extractedBlocks(source, result.blocks) }
      : { kind: 'unknown', reason: '分层识别未完成。' };
  } catch {
    return { kind: 'unknown', reason: '分层识别返回的块或坐标无效。' };
  }
}

// The host resolves the short-lived handle. The command that saves a confirmed
// transcript separately checks whether the learner opted to retain any audio.
export function voiceTranscriptionRequest(audioRef: string): EffectRequest {
  return {
    label: voiceTranscriptionEffect,
    stepKey: voiceTranscriptionVersion,
    input: { version: voiceTranscriptionVersion, audioRef: captureText(audioRef, '录音句柄', 500) },
  };
}

export function voiceTranscriptionResult(request: EffectRequest, receipts: readonly EffectReceipt[]): Outcome<string> {
  try {
    if (!receipts[0] || !sameJson(receipts[0].request, request))
      return { kind: 'unknown', reason: '转写回执与当前录音不匹配。' };
    const result = effectResult(receipts, voiceTranscriptionVersion, voiceTranscriptionEffect);
    return result ? { kind: 'value', value: captureText(result.transcript, '待确认转写', 2_000_000) }
      : { kind: 'unknown', reason: '录音转写未完成。' };
  } catch {
    return { kind: 'unknown', reason: '录音转写结果无效。' };
  }
}

export function extractionTarget(input: unknown) {
  const row = captureObject(input);
  return { target: captureRef(row.target), row };
}

export function extractionAnchor(source: SourceEnvelope, blockId: string, input: unknown): Block | undefined {
  const saved = source.unit.blocks.find(block => block.id === blockId);
  requireSourceCropPage(saved?.body.crop_ref, source.originals);
  if (saved || input === undefined) return saved;
  const row = captureObject(input);
  const parentId = source.unit.blocks.some(block => block.id === row.parentId) ? row.parentId : null;
  const blocks = sourceBlocks([...source.unit.blocks, { ...row, parentId }], source.kind, source.originals);
  const block = blocks.at(-1);
  if (!block || block.id !== blockId || !block.body.crop_ref ||
      (block.body.status === 'unknown' ? block.body.clarification !== 'pending' : block.body.sticky))
    throw new Error('请先打开原件的抽取位置。');
  const key = cropKey(block);
  requireSourceCropPage(block.body.crop_ref, source.originals);
  return source.unit.blocks.find(entry => cropKey(entry) === key && keepLearnerState(entry)) ?? block;
}

export function extractionInput(input: unknown) {
  const { target, row } = extractionTarget(input);
  if (!Array.isArray(row.blocks)) throw new Error('缺少分层抽取块。');
  return { target, blocks: row.blocks };
}

export async function extractionRevision(read: ReadContext, input: ReturnType<typeof extractionInput>) {
  const { id, rev } = input.target;
  const fact = await read.fact(id, { mode: 'following' });
  if (fact.type !== captureSourceType || fact.ref.rev !== rev) throw new Error('原件版本已变更。');
  if (!mayExtract(fact))
    throw new Error('原件未获准学习使用。');
  const source = sourceEnvelope(fact.value);
  if (source.kind !== 'photo' && source.kind !== 'pdf' && source.kind !== 'paper-return')
    throw new Error('分层抽取需要卷面原件。');
  const blocks = mergeExtraction(source, extractedBlocks(source, input.blocks));
  if (JSON.stringify(blocks) === JSON.stringify(source.unit.blocks)) return null;
  return { id, expectedRev: rev, data: sourceEnvelope({ ...source, unit: { ...source.unit, blocks } }) };
}

export function cropKey(block: Block): string | undefined {
  const crop = block.body.crop_ref;
  return crop && JSON.stringify([block.body.layer, crop.original, crop.page, ...crop.bbox]);
}

function keepLearnerState({ body }: Block): boolean {
  return body.status === 'unknown' ? body.clarification === 'asked' : body.sticky === true;
}

export function mergeExtraction(original: SourceEnvelope, candidate: readonly Block[]) {
  const prior = new Map(original.unit.blocks.map(block => [block.id, block]));
  const protectedAtCrop = new Map<string, Block>();
  for (const block of prior.values()) {
    const key = cropKey(block);
    if (key && keepLearnerState(block)) protectedAtCrop.set(key, block);
  }
  const aliases = new Map<string, string>();
  const blocks = new Map<string, Block>();
  for (const block of candidate) {
    const old = prior.get(block.id);
    const key = cropKey(block);
    if (old && keepLearnerState(old) &&
        (old.body.crop_ref?.original !== block.body.crop_ref?.original || old.body.crop_ref?.page !== block.body.crop_ref?.page)) {
      throw new Error('重抽取将本人保留的块标识改指到另一页。');
    }
    const preserved = old && keepLearnerState(old) ? old : key ? protectedAtCrop.get(key) : undefined;
    if (preserved) aliases.set(block.id, preserved.id);
    blocks.set(preserved?.id ?? block.id, preserved ? { ...preserved, parentId: preserved.parentId ?? block.parentId } : block);
  }
  for (const block of prior.values()) {
    if (keepLearnerState(block) && !blocks.has(block.id)) blocks.set(block.id, block);
  }
  const ordered = new Map<string, Block>();
  const visiting = new Set<string>();
  function visit(block: Block) {
    if (ordered.has(block.id)) return;
    if (visiting.has(block.id)) throw new Error('重抽取的块层级与本人更正冲突。');
    visiting.add(block.id);
    const parentId = block.parentId === null ? null : aliases.get(block.parentId) ?? block.parentId;
    if (parentId !== null) {
      const parent = blocks.get(parentId) ?? prior.get(parentId);
      if (!parent) throw new Error('重抽取后缺少父块。');
      visit(parent);
    }
    visiting.delete(block.id);
    ordered.set(block.id, { ...block, parentId });
  }
  for (const block of blocks.values()) visit(block);
  return [...ordered.values()];
}

export function waitingAnswerSlots(blocks: readonly Block[]) {
  return blocks.flatMap(({ id, body }) => body.status === 'unknown' && body.itemId && (body.layer === 'handwriting' || body.layer === 'prompt')
    ? [{ blockId: id, itemId: body.itemId, slotId: body.slotId ?? null, status: 'waiting' as const }]
    : []);
}

/** Call with the recipient-authorized original and slot. Region coordinates are normalized to one source page. */
export function clarificationRegions(fact: FactSnapshot, outcome: Outcome<LayeredExtractionValue> | null) {
  if (fact.type !== captureSourceType || !mayExtract(fact)) return [];
  const source = sourceEnvelope(fact.value);
  const candidate = extractionForSource(fact, source, outcome);
  const seen = new Set<string>();
  const blocks = candidate ? mergeExtraction(source, candidate) : source.unit.blocks;
  return blocks.flatMap(block => {
    const { body } = block;
    if (body.status !== 'unknown' || !validSourceCropPage(body.crop_ref, source.originals)) return [];
    const key = cropKey(block)!;
    if (seen.has(key)) return [];
    seen.add(key);
    return [clarificationRegion(fact, source, { id: block.id, body })];
  });
}

export function clarificationRegion(fact: FactSnapshot, source: SourceEnvelope, { id, body }: {
  id: string; body: Extract<Block['body'], { status: 'unknown' }>;
}) {
  const { original, page, bbox: [left, top, right, bottom] } = body.crop_ref;
  return {
    id, origin: 'ocr' as const, sourceId: fact.ref.id, revision: fact.ref.rev, accessEpoch: fact.accessEpoch,
    originalSha256: source.originals[original]!.sha256, page, crop: { left, top, width: right - left, height: bottom - top },
    clarification: body.clarification, candidates: body.candidates,
  };
}

function questionBlocks(blocks: readonly Block[], itemId: string) {
  const publicBlocks = new Map<string, { block: Block; owner: string | undefined }>();
  const ancestors = new Set<string>();
  const itemIds = new Set<string>();
  for (const block of blocks) {
    const { id, parentId, body } = block;
    if (body.layer !== 'material' && body.layer !== 'prompt') continue;
    const parent = parentId === null ? undefined : publicBlocks.get(parentId);
    if (parentId !== null && !parent) continue;
    const owner = body.itemId ?? parent?.owner;
    publicBlocks.set(id, { block, owner });
    if (body.layer !== 'prompt' || !owner) continue;
    itemIds.add(owner);
    if (owner !== itemId) continue;
    let ancestor = parent;
    while (ancestor && !ancestors.has(ancestor.block.id)) {
      ancestors.add(ancestor.block.id);
      ancestor = ancestor.block.parentId === null ? undefined : publicBlocks.get(ancestor.block.parentId);
    }
  }
  return Array.from(publicBlocks.values()).flatMap(({ block, owner }) => {
    if (owner === itemId || ancestors.has(block.id)) return [block];
    // A single-item paper may supply its passage as a separate top-level material.
    if (itemIds.size === 1 && !owner && block.body.layer === 'material') return [block];
    return [];
  });
}

export function firstAnswerBlocks(blocks: readonly Block[], itemId?: string) {
  const allowed = new Map<string, string | undefined>();
  return blocks.filter(({ id, body, parentId }) => {
    const handwriting = body.layer === 'handwriting' && (itemId === undefined || body.itemId === itemId);
    if ((body.layer !== 'material' && body.layer !== 'prompt' && !handwriting) ||
        (parentId !== null && !allowed.has(parentId))) return false;
    const owner = parentId === null ? undefined : allowed.get(parentId);
    if (itemId === undefined && handwriting && owner && owner !== body.itemId) return false;
    allowed.set(id, body.itemId ?? owner);
    return handwriting;
  });
}

type AssessmentSource = {
  readonly sourceId: FactId;
  readonly itemId: string;
  readonly extraction?: 'saved' | 'layered';
  readonly questionId?: FactId;
};

async function matchesCapturedPassages(
  read: ReadContext, source: FactSnapshot['ref'], saved: readonly Block[], asset: QuestionAsset,
  passages: readonly { blockId: string; text: string }[],
) {
  const materials = asset.blocks.flatMap(({ body }) => body.kind === 'sharedMaterial' ? [body.source] : []);
  if (materials.length !== passages.length) return false;
  const revisions = new Map([[source.rev, saved]]);
  for (const [index, { fact, type, anchor }] of materials.entries()) {
    const passage = passages[index]!;
    if (type !== captureSourceType || fact.id !== source.id || anchor.kind !== 'block' || anchor.blockId !== passage.blockId)
      return false;
    let blocks = revisions.get(fact.rev);
    if (!blocks) {
      const pinned = await read.fact(fact.id, { mode: 'pinned', rev: fact.rev });
      blocks = sourceEnvelope(pinned.value).unit.blocks;
      revisions.set(fact.rev, blocks);
    }
    const original = blocks.find(block => block.id === anchor.blockId)?.body;
    if (original?.layer !== 'material' || original.status !== 'known' || original.text !== passage.text) return false;
  }
  return true;
}

/** Server-side grading input. Keep the ready result within the authorized assessment host. */
export async function openCapturedAssessment(read: ReadContext, request: AssessmentSource) {
  const { sourceId, itemId, questionId } = request;
  const fact = await read.fact(sourceId, { mode: 'following' });
  if (fact.type !== captureSourceType || !mayExtract(fact)) throw new Error('卷面原件未获准学习使用。');
  const source = sourceEnvelope(fact.value);
  if (source.kind !== 'photo' && source.kind !== 'pdf' && source.kind !== 'paper-return')
    throw new Error('需要照片或 PDF 卷面。');
  const waiting = (reason: string) => ({ kind: 'waiting' as const, reason });
  const outcome = request.extraction === 'layered' ? (await read.slot<LayeredExtractionValue>(
    { learner: fact.ref.learner, type: layeredExtractionSlot, key: sourceId }, { mode: 'following' },
  )).outcome : null;
  if (outcome?.kind === 'unknown') return waiting(outcome.reason);
  const candidate = extractionForSource(fact, source, outcome);
  if (outcome && !candidate) return waiting('分层识别与当前原件或授权不匹配。');
  const { blocks: saved } = source.unit;
  const blocks = candidate ? mergeExtraction(source, candidate) : saved;
  const visible = questionBlocks(blocks, itemId);
  if (!visible.some(({ body }) => body.layer === 'prompt' && body.itemId === itemId))
    return waiting('尚未识别到此题的题干。');
  const passages = [];
  const prompts = [];
  for (const { id, body } of visible) {
    if (body.status === 'unknown' || !body.text.trim()) return waiting('题干或共享材料尚待澄清。');
    if (body.layer === 'material') passages.push({ blockId: id, text: body.text });
    else prompts.push(body.text);
  }
  const prompt = prompts.join('\n');
  if (!questionId) return { kind: 'question-gap' as const, source: fact.ref, accessEpoch: fact.accessEpoch, itemId, prompt, passages };

  const answers = firstAnswerBlocks(blocks, itemId);
  const unresolved = waitingAnswerSlots(answers);
  if (unresolved.length) return { ...waiting('首次手写作答尚待澄清。'), slots: unresolved };
  const question = await openQuestionForRelease(read, questionId, 'assessment');
  const slots = question.contract.items[0]!.slots;
  if (questionPrompt(question.asset) !== prompt || !await matchesCapturedPassages(read, fact.ref, saved, question.asset, passages)) {
    throw new Error('核验题目的题干或共享材料与拍卷题位不符。');
  }
  const slotIds = new Set(slots.map(slot => slot.slotId));
  if (answers.some(({ body }) => !body.slotId || !slotIds.has(body.slotId)))
    return waiting('手写位置尚未与已核验作答位对应。');
  const submitted = new Set(answers.filter(({ body }) => body.status === 'known' && body.text.trim()).map(({ body }) => body.slotId));
  if (slots.some(slot => !submitted.has(slot.slotId))) return waiting('有作答位尚未收到首次作答。');
  return { kind: 'ready' as const, source: fact.ref, itemId, answers, question: question.ref, contract: question.contract };
}
