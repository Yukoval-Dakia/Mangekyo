import { isJson, type Json, type JsonObject } from '@mangekyo/kernel';
import { notionHash, notionId, notionRecord, notionTimestamp, type NotionCursor } from './notion-values.ts';

export const notionVersion = '2026-03-11';

export type NotionRoot =
  | { readonly kind: 'page'; readonly id: string }
  | { readonly kind: 'data-source'; readonly id: string };

export type NotionReadRequest =
  | { readonly method: 'GET'; readonly path: `/v1/pages/${string}` | `/v1/blocks/${string}/children${string}` }
  | { readonly method: 'POST'; readonly path: `/v1/data_sources/${string}/query`; readonly body: Json };
export type NotionReadResponse = { readonly status: number; readonly body: unknown };

export type NotionInvalidatedSource = { readonly kind: 'selection' } | { readonly kind: 'page'; readonly pageId: string };

export class NotionSourceUnavailable extends Error {
  constructor(message: string, readonly invalidated?: NotionInvalidatedSource) {
    super(message);
  }
}
export class NotionSourceChanged extends Error {}

function response({ status, body }: NotionReadResponse, sourceBoundary?: NotionInvalidatedSource) {
  const invalidated = status === 401 ? { kind: 'selection' } as const
    : status === 403 || status === 404 ? sourceBoundary : undefined;
  if (invalidated) {
    throw new NotionSourceUnavailable('Notion 来源已不可用。', invalidated);
  }
  if (status !== 200) throw new Error(`Notion 读取失败（HTTP ${status}）。`);
  return notionRecord(body);
}

function pagination(value: NotionReadResponse, seen: Set<string>, sourceBoundary?: NotionInvalidatedSource) {
  const { object, results, has_more, next_cursor, request_status } = response(value, sourceBoundary);
  if (request_status !== undefined && notionRecord(request_status).type === 'incomplete') {
    throw new Error('Notion 查询结果不完整。');
  }
  if (object !== 'list' || !Array.isArray(results) ||
      (has_more === false ? next_cursor !== null : has_more !== true || typeof next_cursor !== 'string' || !next_cursor)) {
    throw new Error('Notion 分页响应无效。');
  }
  const next = next_cursor as string | null;
  if (next !== null) {
    if (seen.has(next)) throw new Error('Notion 分页游标重复。');
    seen.add(next);
  }
  return { results, next };
}

function richText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map(item => {
    const part = notionRecord(item);
    if (typeof part.plain_text !== 'string') throw new Error('Notion 富文本响应无效。');
    return part.plain_text;
  }).join('');
}

function pageMetadata(value: unknown, root: NotionRoot, expectedId?: string) {
  const page = notionRecord(value);
  const pageId = notionId(page.id);
  if (page.object !== 'page') throw new Error('Notion 响应不是页面。');
  if (expectedId !== undefined && pageId !== expectedId) throw new Error('Notion 页面响应标识不匹配。');
  if (page.in_trash === true || page.is_archived === true || page.archived === true ||
      (root.kind === 'page' && pageId !== root.id)) {
    throw new NotionSourceUnavailable('Notion 页面不在获准来源内。', pageBoundary(root, pageId));
  }
  if (root.kind === 'data-source') {
    const parent = notionRecord(page.parent);
    if (parent.type !== 'data_source_id' || notionId(parent.data_source_id) !== root.id) {
      throw new NotionSourceUnavailable('Notion 数据行已移出获准来源。', { kind: 'page', pageId });
    }
  }
  const properties = Object.entries(notionRecord(page.properties)).map(([name, property]) => ({ name, value: notionRecord(property) }));
  const title = richText(properties.find(({ value }) => value.type === 'title')?.value.title);
  return { pageId, lastEditedTime: notionTimestamp(page.last_edited_time), title, properties };
}

function pageBoundary(root: NotionRoot, pageId: string): NotionInvalidatedSource {
  return root.kind === 'page' ? { kind: 'selection' } : { kind: 'page', pageId };
}

export function* notionReadRows(root: Extract<NotionRoot, { kind: 'data-source' }>, since?: NotionCursor):
  Generator<NotionReadRequest, readonly NotionCursor[], NotionReadResponse> {
  const selected = { ...root, id: notionId(root.id) };
  const cursors = new Set<string>();
  const rows = new Map<string, NotionCursor>();
  let cursor: string | null = null;
  do {
    const reply = yield {
      method: 'POST', path: `/v1/data_sources/${selected.id}/query`, body: {
        page_size: 100, result_type: 'page', sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
        ...(cursor === null ? {} : { start_cursor: cursor }),
        // Notion does not order rows by page UUID on timestamp ties. Replay the
        // entire boundary timestamp, including IDs below the saved watermark.
        ...(since === undefined ? {} : { filter: { timestamp: 'last_edited_time',
          last_edited_time: { on_or_after: notionTimestamp(since.lastEditedTime) } } }),
      },
    };
    const page = pagination(reply, cursors, { kind: 'selection' });
    for (const result of page.results) {
      const { pageId, lastEditedTime } = pageMetadata(result, selected);
      const previous = rows.get(pageId);
      if (!previous || previous.lastEditedTime < lastEditedTime) rows.set(pageId, { pageId, lastEditedTime });
    }
    cursor = page.next;
  } while (cursor !== null);
  return [...rows.values()];
}

function blockText(kind: string, data: Record<string, unknown>): string {
  if (Array.isArray(data.cells)) return data.cells.map(richText).join(' | ');
  if (kind === 'unsupported') return '[Notion 未返回该块正文]';
  if (typeof data.title === 'string') return data.title;
  if (kind === 'equation' && typeof data.expression === 'string') return data.expression;
  const text = richText(data.rich_text ?? data.caption);
  return text || (['audio', 'embed', 'file', 'image', 'pdf', 'video'].includes(kind) ? `[Notion ${kind}]` : '');
}

function unsignedFileLocator(value: Json): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { url } = value as JsonObject;
  if (typeof url !== 'string') return null;
  try {
    const location = new URL(url);
    if (location.protocol === 'https:' && !location.username && !location.password) {
      return { origin: location.origin, path: location.pathname };
    }
  } catch { /* The provider did not expose a usable locator. */ }
  return null;
}

function semanticBody(value: Json): Json {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(semanticBody);
  const item = value as Record<string, Json>;
  const signedFile = item.type === 'file';
  return Object.fromEntries(Object.entries(item)
    .filter(([key]) => key !== 'expiry_time')
    .map(([key, child]) => [key, signedFile && key === 'file' ? unsignedFileLocator(child) : semanticBody(child)]));
}

type ProjectedBlock = { id: string; parentId: string | null; text: string; body: JsonObject };

function* notionReadChildren(pageId: string, parentId: string | null, seenBlocks: Set<string>, blocks: ProjectedBlock[]):
  Generator<NotionReadRequest, void, NotionReadResponse> {
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? 'page_size=100' : `page_size=100&start_cursor=${encodeURIComponent(cursor)}`;
    const reply = yield { method: 'GET', path: `/v1/blocks/${parentId ?? pageId}/children?${query}` };
    const page = pagination(reply, cursors);
    for (const entry of page.results) {
      const block = notionRecord(entry);
      const id = notionId(block.id);
      const type = block.type;
      if (block.object !== 'block' || typeof type !== 'string' || typeof block.has_children !== 'boolean' ||
          id === pageId || seenBlocks.has(id)) throw new Error('Notion 块响应无效。');
      seenBlocks.add(id);
      if (block.in_trash === true || block.archived === true) continue;
      const data = notionRecord(block[type] ?? (type === 'unsupported' ? {} : null));
      if (!isJson(data)) throw new Error('Notion 块内容无效。');
      blocks.push({ id, parentId, text: blockText(type, data), body: { type, data: semanticBody(data),
        ...(type === 'unsupported' ? { availability: 'unavailable' } : {}) } });
      // A child page/database has its own grant boundary.
      if (block.has_children && type !== 'child_page' && type !== 'child_database') {
        yield* notionReadChildren(pageId, id, seenBlocks, blocks);
      }
    }
    cursor = page.next;
  } while (cursor !== null);
}

function rowPropertyText(type: string, value: unknown): string {
  if (type === 'rich_text') return richText(value);
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return String(value);
  if (type === 'multi_select' && Array.isArray(value)) return value.map(item => notionRecord(item).name).filter(name => typeof name === 'string').join(', ');
  if (type === 'select' || type === 'status') {
    const name = notionRecord(value).name;
    return typeof name === 'string' ? name : '';
  }
  if (type === 'date') {
    const { start, end, time_zone } = notionRecord(value);
    return [start, end, time_zone].filter(value => typeof value === 'string').join(' / ');
  }
  return '';
}

async function notionRowProperties(page: ReturnType<typeof pageMetadata>): Promise<ProjectedBlock[]> {
  const blocks: ProjectedBlock[] = [];
  for (const { name, value: entry } of page.properties) {
    const { id, type } = entry;
    if (typeof type !== 'string' || typeof id !== 'string') throw new Error('Notion 数据行属性标识无效。');
    const raw = entry[type];
    const available = isJson(raw);
    const value = type === 'title' ? richText(raw) : rowPropertyText(type, raw);
    const uid = (await notionHash(JSON.stringify(['notion-property', page.pageId, id]))).slice(0, 32);
    blocks.push({ id: notionId(uid), parentId: null, text: `${name}: ${value || (available ? '' : '[Notion 未返回值]')}`,
      body: { type: 'property', propertyType: type, id, name, value: available ? semanticBody(raw) : null,
        availability: !available ? 'unavailable' : entry.has_more === true ? 'partial' : 'available' } });
  }
  return blocks.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export async function* notionReadPage(root: NotionRoot, requestedPage: string):
  AsyncGenerator<NotionReadRequest, { pageId: string; lastEditedTime: string; title: string; blocks: ProjectedBlock[] }, NotionReadResponse> {
  const selected = { ...root, id: notionId(root.id) };
  const pageId = notionId(requestedPage);
  if (selected.kind === 'page' && selected.id !== pageId) throw new NotionSourceUnavailable('Notion 页面不在获准来源内。');
  const get = { method: 'GET', path: `/v1/pages/${pageId}` } as const;
  const boundary = pageBoundary(selected, pageId);
  const first = pageMetadata(response(yield get, boundary), selected, pageId);
  const blocks: ProjectedBlock[] = [];
  yield* notionReadChildren(pageId, null, new Set(), blocks);
  const last = pageMetadata(response(yield get, boundary), selected, pageId);
  if (first.lastEditedTime !== last.lastEditedTime || first.title !== last.title) {
    throw new NotionSourceChanged('拉取期间 Notion 页面有更新，请重试。');
  }
  const properties = selected.kind === 'data-source' ? await notionRowProperties(last) : [];
  return { pageId, lastEditedTime: last.lastEditedTime, title: last.title, blocks: [...properties, ...blocks] };
}
