import type { EffectReceipt, EffectRequest, FactId, FactRef, GatherContext, GatherInput } from '@mangekyo/kernel';
import { isNotionBlockPurpose, notionBlockWitness, openCurrentNotionBlock, planNotionBlockWork, type NotionBlockPurpose, type NotionBlockWitness } from './notion-blocks.ts';
import type { SelectedNotionAccess } from './notion-source.ts';
import { captureRef } from './parse.ts';
import { notionEpoch, type NotionFactReader } from './notion-selection.ts';
import { notionRecord } from './notion-values.ts';
import { captureSourceType, sourceEnvelope } from './source.ts';

export const notionBlockSlot = 'capture.notionBlock';
export const notionBlockDeriver = 'capture/notion-block';
export const notionBlockLinkEffect = 'resolve-notion-block-links';
export class NotionBlockResolverUnavailable extends Error {
  constructor() { super('尚无获准的 Notion 概念解析器及连边核验回执。'); }
}

export function notionBlockLinkRequest(basis: NotionBlockWitness) {
  return { stepKey: 'links', label: notionBlockLinkEffect, input: basis };
}

export function notionBlockWorkKey(ref: NotionBlockWitness) {
  return JSON.stringify(notionBlockWitness(ref));
}

export function parseNotionBlockWorkKey(key: string) {
  return notionBlockWitness(JSON.parse(key));
}

export async function* changedNotionBlockWork(read: NotionFactReader, purpose: NotionBlockPurpose,
  changes: readonly {ref: FactRef; factType: string; kind: string}[]) {
  for (const {ref, factType, kind} of changes) {
    if (factType !== captureSourceType || (kind !== 'create' && kind !== 'revise')) continue;
    const current = await read.fact(ref.id, {mode:'pinned', rev:ref.rev});
    const previous = kind === 'create' ? null : await read.fact(ref.id, {mode:'pinned', rev:(ref.rev - 1) as typeof ref.rev});
    yield* planNotionBlockWork(previous, current, purpose).rebuild;
  }
}

export function notionBlockRecoveryPages(sources: readonly {id: FactId; pageId: string}[], work: readonly {slotKey: string}[]) {
  const blockedSources = new Set(work.map(({slotKey}) => parseNotionBlockWorkKey(slotKey).id));
  return sources.filter(source => blockedSources.has(source.id)).map(source => source.pageId);
}

export function planNotionBlockRecovery(access: SelectedNotionAccess, confirmed: ReadonlySet<FactId>, withdrawn: (error: unknown) => boolean) {
  return async (slotKey: string) => {
    const basis = parseNotionBlockWorkKey(slotKey);
    try {
      await openCurrentNotionBlock(access,basis);
      return confirmed.has(basis.id) ? 'retry' as const : undefined;
    } catch (error) {
      if (withdrawn(error)) return 'cancel' as const;
      throw error;
    }
  };
}

type Slice = { readonly basis: NotionBlockWitness; readonly contentHash: string; readonly parentId: string | null };
type Link = { readonly target: ReturnType<typeof targetWitness>; readonly confidence?: number };

function targetWitness(input: unknown) {
  const row = notionRecord(input);
  if (Object.keys(row).some(key => key !== 'id' && key !== 'rev' && key !== 'accessEpoch')) {
    throw new Error('Notion 连边的概念见证无效。');
  }
  return { ...captureRef(row), accessEpoch: notionEpoch(row.accessEpoch) };
}

export async function gatherNotionBlock(ctx: GatherContext, rawKey: string): Promise<GatherInput<Slice>> {
  const basis = parseNotionBlockWorkKey(rawKey);
  const fact = await ctx.read.fact(basis.id, { mode: 'pinned', rev: basis.rev });
  const source = sourceEnvelope(fact.value);
  const block = source.unit.blocks.find(({ id }) => id === basis.blockId);
  if (fact.ref.learner !== ctx.learner || fact.type !== captureSourceType || source.kind !== 'notion' ||
      fact.accessEpoch !== basis.accessEpoch || !block?.body.contentHash ||
      !fact.purpose.some(isNotionBlockPurpose)) {
    throw new Error('Notion 块版本或抽取用途已变更。');
  }
  return { kind: 'input', data: { basis, contentHash: block.body.contentHash, parentId: block.parentId },
    effects: [notionBlockLinkRequest(basis)] };
}

function parseLinks(input: unknown): Link[] {
  if (!Array.isArray(input) || input.length > 32) throw new Error('Notion 块的概念连边结果无效。');
  const seen = new Set<string>();
  return input.map(value => {
    const row = notionRecord(value);
    if (Object.keys(row).some(key => key !== 'target' && key !== 'confidence')) throw new Error('Notion 连边结果只能携带概念见证。');
    const target = targetWitness(row.target);
    if (seen.has(target.id)) throw new Error('Notion 块的概念连边重复。');
    seen.add(target.id);
    const confidence = row.confidence;
    if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence) ||
        confidence < 0 || confidence > 1)) throw new Error('Notion 块的连边置信度无效。');
    return { target, ...(confidence === undefined ? {} : { confidence }) };
  });
}

/** The injected resolver uses the shared authorized entity resolver and
 * returns canonical, established concept witnesses. No match means [].
 * Its egress must also re-open using the live actual-recipient access.
 */
export async function consumeNotionBlockLink(
  request: Pick<EffectRequest, 'label' | 'stepKey' | 'input'>,
  access: SelectedNotionAccess,
  resolveConcepts?: (input: { readonly basis: NotionBlockWitness; readonly text: string }) => Promise<readonly Link[]>,
) {
  if (request.label !== notionBlockLinkEffect || request.stepKey !== 'links' ||
      !isNotionBlockPurpose(access.purpose)) throw new Error('Notion 连边用途或效果无效。');
  const basis = notionBlockWitness(request.input);
  const block = await openCurrentNotionBlock(access, basis);
  if (!resolveConcepts) throw new NotionBlockResolverUnavailable();
  return block.text.trim() ? parseLinks(await resolveConcepts({ basis, text: block.text })) : [];
}

export function settleNotionBlock({ basis, contentHash, parentId }: Slice, receipts: readonly EffectReceipt[]) {
  const [receipt] = receipts;
  if (receipt && (receipts.length !== 1 || receipt.request.label !== notionBlockLinkEffect || receipt.request.stepKey !== 'links' ||
      notionBlockWorkKey(notionBlockWitness(receipt.request.input)) !== notionBlockWorkKey(basis))) {
    throw new Error('Notion 连边结果的块见证不匹配。');
  }
  if (!receipt || receipt.state === 'unknown') {
    return { kind: 'unknown' as const, reason: 'Notion 概念连边结果尚未确认。' };
  }
  return { kind: 'value' as const, value: { slice: { basis, contentHash, parentId }, links: parseLinks(receipt.result) } };
}

/** Recheck under the existing acceptance/write fence and hand the resolved
 * claims to content's Edge command and proposal rules.
 */
export async function verifyNotionBlockEdges(access: SelectedNotionAccess,
  value: { readonly slice: Slice; readonly links: readonly Link[] },
) {
  const { basis, contentHash, parentId } = value.slice;
  const current = await openCurrentNotionBlock(access, basis);
  if (!isNotionBlockPurpose(access.purpose) || current.contentHash !== contentHash || current.parentId !== parentId) {
    throw new Error('Notion 连边依据已变更。');
  }
  const { id, rev, accessEpoch, blockId } = basis;
  const source = { id, rev, accessEpoch };
  return parseLinks(value.links).map(({ target, confidence }) => ({
    kind: 'explains' as const, scope: 'Notion 笔记',
    from: { kind: 'note' as const, sourceUse: source, blockId },
    to: { kind: 'concept' as const, sourceUse: target },
    sourceUses: [source, target],
    ...(confidence === undefined ? {} : { confidence }),
  }));
}
