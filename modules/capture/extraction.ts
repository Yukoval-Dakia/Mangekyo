import type { EffectReceipt, EffectRequest, FactId, GatherContext, Outcome } from '@mangekyo/kernel';
import { captureObject, captureRef, captureText } from './parse.ts';
import { captureSourceType, sourceEnvelope, sourceBlocks, type Block, type SourceEnvelope } from './source.ts';

export const visualExtractionVersion = 'capture-visual-v1';
export const voiceTranscriptionVersion = 'capture-voice-v1';
export const visualExtractionEffect = 'capture.extractLayers';
export const voiceTranscriptionEffect = 'capture.transcribeVoice';

type VisualSource = Pick<SourceEnvelope, 'kind' | 'originals'>;

export function visualExtractionRequest(source: VisualSource, redInkMeaning?: string): EffectRequest {
  if (source.kind !== 'photo' && source.kind !== 'pdf' && source.kind !== 'paper-return')
    throw new Error('分层识别需要图像或 PDF。');
  return {
    label: visualExtractionEffect,
    stepKey: visualExtractionVersion,
    input: {
      version: visualExtractionVersion,
      originals: source.originals,
      redInkMeaning: redInkMeaning === undefined ? null : captureText(redInkMeaning, '红笔说明', 400),
    },
  };
}

// The host executes and settles this plan. The current kernel deriver callback
// accepts only gather input, so an effect receipt cannot be consumed there.
export async function gatherVisualExtraction(ctx: GatherContext, sourceId: FactId, redInkMeaning?: string) {
  const fact = await ctx.read.fact(sourceId, { mode: 'following' });
  if (fact.type !== captureSourceType || !fact.purpose.some(purpose => purpose === 'teaching' || purpose === 'learning'))
    return null;
  const { kind, originals } = sourceEnvelope(fact.value);
  if (kind !== 'photo' && kind !== 'pdf' && kind !== 'paper-return') return null;
  const source = { kind, originals };
  return { source, target: fact.ref, effect: visualExtractionRequest(source, redInkMeaning) };
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
    blocks.set(preserved?.id ?? block.id, preserved ?? block);
  }
  for (const block of prior.values()) {
    if (keepLearnerState(block)) blocks.set(block.id, block);
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
  return blocks.flatMap(({ id, body }) => body.status === 'unknown' && body.itemId && body.slotId
    ? [{ blockId: id, itemId: body.itemId, slotId: body.slotId, status: 'waiting' as const }]
    : []);
}
