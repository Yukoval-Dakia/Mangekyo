import { factId, isJson, type Asset as KernelAsset, type FactSnapshot, type JsonObject } from '@mangekyo/kernel';
import { parseAssetBlocks, type Block as AssetBlock, type ContentUnit } from '@mangekyo/module-content/facts/asset-contract';
import { captureObject as object, captureText as text, sha256 } from './parse.ts';

import { notionEpoch, notionRoot } from './notion-selection.ts';
import type { NotionRoot } from './notion-api.ts';

export const captureSourceType = 'capture.source';
export const captureSourceCommand = 'capture.ingest';
export const confirmSourceCommand = 'capture.confirmSource';
export const sourceKinds = ['photo', 'pdf', 'text', 'document', 'url', 'voice', 'notion', 'paper-return'] as const;
export const blockLayers = ['source', 'material', 'prompt', 'handwriting', 'correction', 'annotation', 'reference-answer', 'rubric'] as const;

type SourceKind = (typeof sourceKinds)[number];
type Layer = (typeof blockLayers)[number];
type Original = {
  readonly blobRef: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
};
type Crop = {
  readonly original: number;
  readonly page: number;
  readonly bbox: readonly [number, number, number, number];
};
type Location = {
  readonly kind: 'capture';
  readonly layer: Layer;
  readonly itemId?: string;
  readonly slotId?: string;
  readonly contentHash?: string;
  readonly crop_ref?: Crop;
};
export type CaptureBlockBody = Location & (
  | { readonly status: 'known'; readonly text: string; readonly author?: 'learner'; readonly sticky?: true; readonly notionBody?: JsonObject }
  | { readonly status: 'unknown'; readonly crop_ref: Crop; readonly candidates: readonly string[]; readonly clarification: 'pending' | 'asked' }
);
export type Block = AssetBlock<CaptureBlockBody>;
export type Asset = KernelAsset<ContentUnit & { readonly kind: 'capture' }, Block>;
export type SourceEnvelope = {
  readonly kind: SourceKind;
  readonly externalId?: string;
  readonly sourceSelectionId?: string;
  readonly sourceSelectionEpoch?: string;
  readonly sourceRoot?: NotionRoot;
  readonly occurredAt: string | null;
  readonly recordedAt: string | null;
  readonly retentionPolicy: 'retained';
  readonly originals: readonly Original[];
  readonly unit: Asset;
  readonly url?: string;
  readonly transcriptConfirmed?: true;
  readonly retainAudio?: true;
  readonly urlReadConfirmed?: true;
};

function timestamp(value: unknown): string {
  const iso = text(value, '原件时间', 24);
  if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString() !== iso) throw new Error('原件时间无效。');
  return iso;
}

function intakeBlob(input: unknown): Original {
  const row = object(input);
  if (typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < 1) throw new Error('原件大小无效。');
  return {
    blobRef: text(row.blobRef, '原件句柄', 500),
    name: text(row.name, '原件名称', 180),
    mediaType: text(row.mediaType, '原件类型', 180),
    size: row.size,
    sha256: sha256(row.sha256),
  };
}

function cropRef(input: unknown): Crop {
  const { original, page, bbox } = object(input);
  if (typeof original !== 'number' || !Number.isSafeInteger(original) || original < 0 ||
      typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 ||
      !Array.isArray(bbox) || bbox.length !== 4 ||
      !bbox.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) {
    throw new Error('原图坐标无效。');
  }
  const [left, top, right, bottom] = bbox as [number, number, number, number];
  if (left >= right || top >= bottom) throw new Error('原图范围为空。');
  return { original, page, bbox: [left, top, right, bottom] };
}

function captureBlockBody(input: unknown): CaptureBlockBody {
  const row = object(input);
  const layer = row.layer as Layer;
  if (row.kind !== 'capture' || !blockLayers.includes(layer)) throw new Error('内容块层无效。');
  const location: Location = {
    kind: 'capture',
    layer,
    ...(row.itemId === undefined ? {} : { itemId: text(row.itemId, '题目标识', 200) }),
    ...(row.slotId === undefined ? {} : { slotId: text(row.slotId, '作答位标识', 200) }),
    ...(row.contentHash === undefined ? {} : { contentHash: sha256(row.contentHash) }),
    ...(row.crop_ref === undefined ? {} : { crop_ref: cropRef(row.crop_ref) }),
  };
  if (location.slotId && !location.itemId) throw new Error('作答位必须关联题目。');
  if (row.status === 'unknown') {
    if (!location.crop_ref || row.text !== undefined || row.sticky !== undefined || row.author !== undefined || row.notionBody !== undefined)
      throw new Error('未知内容必须保留局部原图，不得附确定文字。');
    const candidates = row.candidates === undefined ? [] : row.candidates;
    if (!Array.isArray(candidates) || candidates.length > 8) throw new Error('澄清候选无效。');
    if (row.clarification !== undefined && row.clarification !== 'pending' && row.clarification !== 'asked')
      throw new Error('澄清状态无效。');
    return { ...location, status: 'unknown', crop_ref: location.crop_ref,
      candidates: candidates.map(item => text(item, '澄清候选', 500)), clarification: row.clarification ?? 'pending' };
  }
  if (row.status !== 'known' || (row.sticky !== undefined && (row.sticky !== true || row.author !== 'learner')) ||
      (row.author !== undefined && (row.author !== 'learner' || row.sticky !== true)))
    throw new Error('内容块状态或作者无效。');
  const notionBody = row.notionBody === undefined ? undefined : object(row.notionBody);
  if (notionBody !== undefined && !isJson(notionBody)) throw new Error('外部原块语义无效。');
  return { ...location, status: 'known', text: text(row.text, '块正文', 2_000_000, true),
    ...(row.sticky === true ? { sticky: true, author: 'learner' } : {}),
    ...(notionBody === undefined ? {} : { notionBody }) };
}

export function sourceBlocks(input: unknown, kind: SourceKind, originals: readonly Original[]): readonly Block[] {
  const blocks = parseAssetBlocks(input, captureBlockBody);
  const seen = new Set<string>();
  for (const { id, body, parentId } of blocks) {
    if (parentId !== null && !seen.has(parentId)) throw new Error('父块须在子块之前。');
    seen.add(id);
    if (body.crop_ref && !originals[body.crop_ref.original]) throw new Error('内容块缺少原图。');
    if ((kind === 'photo' || kind === 'pdf' || kind === 'paper-return') && !body.crop_ref)
      throw new Error('卷面内容块缺少坐标。');
    if (kind === 'notion' && (body.layer !== 'source' || !body.contentHash || body.status !== 'known' || body.sticky || !body.notionBody))
      throw new Error('外部快照块缺少原块语义、内容哈希或层无效。');
    if (kind !== 'notion' && body.status === 'known' && body.notionBody !== undefined)
      throw new Error('此原件不支持 Notion 原块。');
  }
  return blocks;
}

export function sourceEnvelope(input: unknown): SourceEnvelope {
  const row = object(input);
  const kind = row.kind as SourceKind;
  if (!sourceKinds.includes(kind) || row.retentionPolicy !== 'retained' || !Array.isArray(row.originals))
    throw new Error('原件类型或留存策略无效。');
  const originals = row.originals.map(intakeBlob);
  const asset = object(row.unit);
  if (asset.kind !== 'capture') throw new Error('原件内容单元无效。');
  const unit = { kind: 'capture' as const, title: text(asset.title, '内容标题', 240), blocks: sourceBlocks(asset.blocks, kind, originals) };
  const externalId = row.externalId === undefined ? undefined : text(row.externalId, '外部来源标识', 200);
  const sourceSelectionId = row.sourceSelectionId === undefined ? undefined : text(row.sourceSelectionId, '选源标识', 200);
  const sourceSelectionEpoch = row.sourceSelectionEpoch === undefined ? undefined : notionEpoch(row.sourceSelectionEpoch);
  const sourceRoot = row.sourceRoot === undefined ? undefined : notionRoot(row.sourceRoot);
  if ((sourceSelectionEpoch === undefined) !== (sourceRoot === undefined) ||
      (sourceRoot && kind !== 'notion')) throw new Error('原件选源见证无效。');
  if (kind === 'notion' && (!externalId || !sourceSelectionId)) throw new Error('外部快照缺少获准来源标识。');
  if (['photo', 'pdf', 'document', 'paper-return'].includes(kind) && originals.length === 0) throw new Error('没有保存原件。');
  if (kind === 'voice') {
    if (row.transcriptConfirmed !== true || !unit.blocks.some(({ body: block }) => block.status === 'known' && block.layer === 'source' && block.text.trim()))
      throw new Error('请先确认口述转写。');
    if (originals.length && row.retainAudio !== true) throw new Error('保存录音须单独同意。');
  }
  let url: string | undefined;
  if (kind === 'url') {
    url = text(row.url, '原始链接', 4000);
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('链接格式无效。');
    if ((originals.length || unit.blocks.length) && row.urlReadConfirmed !== true) throw new Error('读取链接须单独同意。');
  }
  return {
    kind, retentionPolicy: 'retained', originals, unit,
    occurredAt: row.occurredAt === null && kind !== 'notion' ? null : timestamp(row.occurredAt),
    recordedAt: row.recordedAt === null && kind !== 'notion' ? null : timestamp(row.recordedAt),
    ...(externalId === undefined ? {} : { externalId }),
    ...(sourceRoot && sourceSelectionEpoch ? { sourceRoot, sourceSelectionEpoch } : {}),
    ...(sourceSelectionId === undefined ? {} : { sourceSelectionId }),
    ...(url === undefined ? {} : { url }),
    ...(kind === 'voice' ? { transcriptConfirmed: true } : {}),
    ...(kind === 'voice' && row.retainAudio === true ? { retainAudio: true } : {}),
    ...(kind === 'url' && row.urlReadConfirmed === true ? { urlReadConfirmed: true } : {}),
  };
}

export function createSourceWrite(id: string, envelope: unknown, purpose: readonly string[] = ['storage']) {
  const data = sourceEnvelope(envelope);
  if (!purpose.includes('storage') || purpose.includes('all')) throw new Error('原件用途须显式指定。');
  if (data.kind === 'url' && data.urlReadConfirmed && !purpose.includes('learning') && !purpose.includes('teaching'))
    throw new Error('仅保存的链接不能抓取正文。');
  if (data.unit.blocks.some(({ body: block }) => block.status === 'unknown' ? block.clarification === 'asked' : block.sticky))
    throw new Error('创建原件不能声明已澄清或手改。');
  return { kind: 'create' as const, id: factId(id), factType: captureSourceType, data, purpose };
}

export function sourceInputWrite(input: unknown, confirmed: boolean) {
  const row = object(input);
  const purpose = row.purpose;
  if (purpose !== undefined && !Array.isArray(purpose)) throw new Error('原件用途无效。');
  const write = createSourceWrite(text(row.id, '原件标识', 26), row.envelope,
    purpose?.map(value => text(value, '原件用途', 100)));
  const needsConfirmation = write.data.kind === 'voice' || (write.data.kind === 'url' && write.data.urlReadConfirmed === true);
  if (needsConfirmation !== confirmed) {
    throw new Error(needsConfirmation ? '请由学习者确认转写或读取链接后保存。' : '本次交入无需确认，请直接保存原件。');
  }
  return write;
}

export function reviseSourceWrite(current: FactSnapshot, expectedRev: number, envelope: unknown) {
  if (current.type !== captureSourceType || current.ref.rev !== expectedRev) throw new Error('原件版本已变更。');
  const prior = sourceEnvelope(current.value);
  const data = sourceEnvelope(envelope);
  if (prior.kind !== 'notion' || data.kind !== prior.kind || data.externalId !== prior.externalId ||
      data.sourceSelectionEpoch !== prior.sourceSelectionEpoch || data.sourceRoot?.kind !== prior.sourceRoot?.kind ||
      data.sourceRoot?.id !== prior.sourceRoot?.id || data.sourceSelectionId !== prior.sourceSelectionId || !prior.occurredAt || !data.occurredAt ||
      data.occurredAt < prior.occurredAt || !prior.recordedAt || !data.recordedAt || data.recordedAt < prior.recordedAt) {
    throw new Error('外部原件来源或时间不匹配。');
  }
  return { kind: 'revise' as const, id: current.ref.id, expectedRev: current.ref.rev, data };
}
