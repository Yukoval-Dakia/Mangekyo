import type { EffectReceipt, EffectRequest, FactSnapshot, GatherContext, GatherInput, Outcome, ReadContext } from '@mangekyo/kernel';
import { captureObject, captureRef, captureText } from './parse.ts';
import { captureSourceType, sourceEnvelope, sourceBlocks, type Block, type SourceEnvelope } from './source.ts';

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
      !fact.purpose.some(purpose => purpose === 'teaching' || purpose === 'learning'))
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

export function mergeLayeredSource(fact: FactSnapshot, outcome: Outcome<LayeredExtractionValue> | null) {
  if (fact.type !== captureSourceType) throw new Error('不是捕获原件。');
  const source = sourceEnvelope(fact.value);
  if (outcome?.kind !== 'value') return { source, differences: [] };
  const { basis, originals, blocks } = outcome.value;
  if (basis.target.id !== fact.ref.id || basis.learner !== fact.ref.learner || basis.target.rev > fact.ref.rev ||
      basis.accessEpoch !== fact.accessEpoch || !sameJson(originals, source.originals))
    return { source, differences: [] };

  const candidate = extractedBlocks(source, blocks);
  const byId = new Map(candidate.map(block => [block.id, block]));
  const byCrop = new Map(candidate.map(block => [cropKey(block), block]));
  const differences = source.unit.blocks.flatMap(previous => {
    if (previous.body.status !== 'known' || !previous.body.sticky) return [];
    const key = cropKey(previous);
    const next = byId.get(previous.id) ?? (key ? byCrop.get(key) : undefined);
    if (next?.body.status === 'known' && next.body.text === previous.body.text && next.body.layer === previous.body.layer)
      return [];
    return [{ blockId: previous.id, candidate: next?.body ?? null }];
  });
  return { source: { ...source, unit: { ...source.unit, blocks: mergeExtraction(source, candidate) } }, differences };
}

export function extractedBlocks(source: VisualSource, input: unknown): readonly Block[] {
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

export function voiceTranscriptionResult(receipts: readonly EffectReceipt[]): Outcome<string> {
  try {
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
  if (saved || input === undefined) return saved;
  const row = captureObject(input);
  const parentId = source.unit.blocks.some(block => block.id === row.parentId) ? row.parentId : null;
  const blocks = sourceBlocks([...source.unit.blocks, { ...row, parentId }], source.kind, source.originals);
  const block = blocks.at(-1);
  if (!block || block.id !== blockId || !block.body.crop_ref ||
      (block.body.status === 'unknown' ? block.body.clarification !== 'pending' : block.body.sticky))
    throw new Error('请先打开原件的抽取位置。');
  return block;
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
  if (!fact.purpose.some(purpose => purpose === 'teaching' || purpose === 'learning'))
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
