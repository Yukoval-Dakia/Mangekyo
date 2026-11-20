import { factId, FactNotFoundError, type FactId, type Json } from '@mangekyo/kernel';
import { notionEpoch, type NotionFactReader } from './notion-selection.ts';
import { notionHash, notionJsonDigest, notionRecord, notionTimestamp } from './notion-values.ts';
import { sha256 } from './parse.ts';
import type { SourceEnvelope } from './source.ts';

export const notionPageObservationType = 'capture.notionPageObservation';
export type NotionObservation = { lastEditedTime: string; contentDigest: string };
export type NotionRefreshTarget = { id: string; expectedRev: number; accessEpoch: string; selectionId: string };

type ClockOnly = { selectionEpoch: string; observation: NotionObservation };
export type NotionRefreshInput = NotionRefreshTarget & (ClockOnly | { envelope: SourceEnvelope });

export class UnchangedNotionSourceError extends Error {
  readonly code = 'notion_source_unchanged';
  constructor() { super('Notion 原件内容未变化。'); }
}

function observation(input: unknown): NotionObservation {
  const row = notionRecord(input);
  if (Object.keys(row).some(key => key !== 'lastEditedTime' && key !== 'contentDigest'))
    throw new Error('Notion 观测只接受时间和内容摘要。');
  return { lastEditedTime: notionTimestamp(row.lastEditedTime), contentDigest: sha256(row.contentDigest) };
}

export function observationInput(input: unknown) {
  const row = notionRecord(input);
  if (Object.keys(row).some(key => !['id', 'expectedRev', 'accessEpoch', 'selectionId', 'selectionEpoch', 'observation'].includes(key)))
    throw new Error('Notion 无变化观测不能携带正文。');
  return { selectionEpoch: notionEpoch(row.selectionEpoch), observation: observation(row.observation) };
}

export function notionPageObservation(input: unknown) {
  const row = notionRecord(input);
  if (typeof row.sourceId !== 'string') throw new Error('Notion 页观测缺少原件标识。');
  return { sourceId: factId(row.sourceId), selectionEpoch: notionEpoch(row.selectionEpoch),
    lastEditedTime: notionTimestamp(row.lastEditedTime), contentDigest: sha256(row.contentDigest) };
}

export async function notionPageObservationId(sourceId: FactId) {
  const hash = await notionHash(JSON.stringify([notionPageObservationType, sourceId]));
  return factId(hash.slice(0, 26).toUpperCase());
}

async function pageVersion(envelope: SourceEnvelope): Promise<NotionObservation> {
  if (envelope.kind !== 'notion' || !envelope.occurredAt) throw new Error('Notion 页面缺少编辑时间。');
  return { lastEditedTime: envelope.occurredAt, contentDigest: await notionJsonDigest(envelope.unit as Json) };
}

/** Run on the worker with the dispatched envelope, before submitting a refresh command. */
export async function prepareNotionRefreshInput(target: NotionRefreshTarget, current: SourceEnvelope, received: SourceEnvelope): Promise<NotionRefreshInput> {
  if (!received.sourceSelectionEpoch || received.sourceSelectionEpoch !== current.sourceSelectionEpoch ||
      received.sourceSelectionId !== current.sourceSelectionId || target.selectionId !== current.sourceSelectionId ||
      received.externalId !== current.externalId || received.sourceRoot?.id !== current.sourceRoot?.id ||
      received.sourceRoot?.kind !== current.sourceRoot?.kind) throw new Error('Notion 观测来源已变更。');
  const prior = await pageVersion(current);
  const next = await pageVersion(received);
  return prior.contentDigest === next.contentDigest
    ? { ...target, selectionEpoch: received.sourceSelectionEpoch, observation: next }
    : { ...target, envelope: received };
}

async function readMarker(read: NotionFactReader, id: FactId) {
  try {
    const fact = await read.fact(id, { mode: 'following' });
    if (fact.type !== notionPageObservationType) throw new Error('Notion 观测记录类型无效。');
    return { value: notionPageObservation(fact.value), rev: fact.ref.rev };
  } catch (error) {
    if (error instanceof FactNotFoundError) return null;
    throw error;
  }
}

/** The initial ingest and each changed revision already store their own remote
 * timestamp. Only later observations of unchanged bytes need a separate mark.
 */
export async function compareNotionObservation(read: NotionFactReader, sourceId: FactId, source: SourceEnvelope,
  incoming: ClockOnly | { envelope: SourceEnvelope }) {
  const prior = await pageVersion(source);
  const selectionEpoch = source.sourceSelectionEpoch;
  const id = await notionPageObservationId(sourceId);
  const marker = await readMarker(read, id);
  if (!selectionEpoch || (marker && (marker.value.sourceId !== sourceId || marker.value.selectionEpoch !== selectionEpoch)))
    throw new Error('Notion 观测来源已变更。');
  const floor = marker && marker.value.lastEditedTime > prior.lastEditedTime ? marker.value : prior;
  const raw = 'envelope' in incoming;
  if (!raw && incoming.selectionEpoch !== selectionEpoch) throw new Error('Notion 观测代次已变更。');
  const next = raw ? await pageVersion(incoming.envelope) : incoming.observation;
  if (next.lastEditedTime < floor.lastEditedTime ||
      (next.lastEditedTime === floor.lastEditedTime && next.contentDigest !== floor.contentDigest))
    throw new Error('Notion 页面观测已过时或同一版本不一致。');
  if (raw) {
    if (next.contentDigest === prior.contentDigest) {
      if (next.lastEditedTime === floor.lastEditedTime) throw new UnchangedNotionSourceError();
      throw new Error('请使用无正文的 Notion 观测命令提交本次刷新。');
    }
    return [];
  }
  if (next.contentDigest !== prior.contentDigest) throw new Error('Notion 无变化观测内容与原件不符。');
  if (next.lastEditedTime === floor.lastEditedTime) return [];
  const data = { sourceId, selectionEpoch, ...next };
  return marker
    ? [{ kind: 'revise' as const, id, expectedRev: marker.rev, data }]
    : [{ kind: 'create' as const, id, factType: notionPageObservationType, data, purpose: ['storage'] }];
}
