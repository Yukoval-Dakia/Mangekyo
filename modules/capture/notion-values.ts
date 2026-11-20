import { factId, isJson, type Json, type JsonObject, type LearnerId } from '@mangekyo/kernel';

export type NotionCursor = { readonly pageId: string; readonly lastEditedTime: string };

export function notionId(input: unknown): string {
  if (typeof input !== 'string' || !/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(input)) {
    throw new Error('Notion 标识无效。');
  }
  return input.replaceAll('-', '').toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

export function notionTimestamp(input: unknown): string {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input)) {
    throw new Error('Notion 编辑时间无效。');
  }
  const exact = !input.includes('.') ? input.replace('Z', '.000Z') :
    input.replace(/\.(\d{1,3})Z$/, (_, ms: string) => '.' + ms.padEnd(3, '0') + 'Z');
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== exact) throw new Error('Notion 编辑时间无效。');
  return exact;
}

export function compareNotionCursors(first: NotionCursor, second: NotionCursor): number {
  const left = notionTimestamp(first.lastEditedTime) + notionId(first.pageId);
  const right = notionTimestamp(second.lastEditedTime) + notionId(second.pageId);
  return left < right ? -1 : left > right ? 1 : 0;
}

// Advance after every row in the provider batch has been committed, including
// no-op refreshes. The next query replays the complete boundary timestamp.
export function advanceNotionCursor(previous: NotionCursor | undefined, committed: readonly NotionCursor[]): NotionCursor | undefined {
  return committed.reduce<NotionCursor | undefined>((latest, cursor) =>
    latest === undefined || compareNotionCursors(cursor, latest) > 0 ? cursor : latest, previous);
}

export function notionSelectionId(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input)) {
    throw new Error('Notion 授权来源无效。');
  }
  return input;
}

export function notionRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Notion 记录格式无效。');
  return input as Record<string, unknown>;
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const record = value as Record<string, Json>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(record[key]!)).join(',') + '}';
}

export function notionJsonDigest(value: Json) {
  return notionHash(canonicalJson(value));
}

export async function notionHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function notionSourceId(learner: LearnerId, selectionId: string, pageId: string, selectionEpoch: string) {
  const digest = await notionHash(JSON.stringify(['capture.notion.v2', learner, notionSelectionId(selectionId), selectionEpoch, notionId(pageId)]));
  return factId(digest.slice(0, 26).toUpperCase());
}

function notionText(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) throw new Error('Notion 文本无效。');
  return value;
}

// The host supplies a complete pre-order tree after following all remote
// pagination. The body is a projection of semantic fields (e.g. block type,
// annotations, links or checkbox state), without provider transport metadata.
export async function notionSourceProjection(input: unknown) {
  const { pageId, lastEditedTime, title, blocks } = notionRecord(input);
  if (!Array.isArray(blocks)) throw new Error('Notion 块列表无效。');
  const externalId = notionId(pageId);
  const occurredAt = notionTimestamp(lastEditedTime);
  const unitTitle = notionText(title).trim() || '未命名 Notion 页面';
  const seen = new Set<string>();
  let ancestry: string[] = [];
  const parsed = blocks.map((entry: unknown) => {
    const block = notionRecord(entry);
    const id = notionId(block.id);
    const parentId = block.parentId == null ? null : notionId(block.parentId);
    if (parentId === null) ancestry = [];
    else {
      const index = ancestry.lastIndexOf(parentId);
      if (index === -1) throw new Error('Notion 块的父级不在当前位置。');
      ancestry.length = index + 1;
    }
    if (id === externalId || seen.has(id)) throw new Error('Notion 块标识重复。');
    seen.add(id);
    ancestry.push(id);
    const text = notionText(block.text);
    const body = notionRecord(block.body);
    if (!isJson(body)) throw new Error('Notion 块内容无效。');
    return { id, parentId, text, body: body as JsonObject };
  });
  const projected = await Promise.all(parsed.map(async ({ id, parentId, text, body }) => ({
    id, parentId, body: { kind: 'capture' as const, layer: 'source' as const, status: 'known' as const, text, notionBody: body,
      contentHash: await notionJsonDigest({ text, body }) },
  })));
  return { externalId, occurredAt, unit: { kind: 'capture' as const, title: unitTitle, blocks: projected } };
}
