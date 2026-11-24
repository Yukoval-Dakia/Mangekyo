import type { FactSnapshot } from '@mangekyo/kernel';
import { assetType } from '@mangekyo/module-content/facts/asset-contract';
import { textbookPageType } from '@mangekyo/module-content/facts/textbook-page';
import goal from '@mangekyo/module-plan/facts/goal';
import task from '@mangekyo/module-plan/facts/organizer-task';
import { materialType } from './library-values.ts';
import { organizerNoteType } from './organizer-values.ts';
import { ridingPracticeType } from './practice-values.ts';
import { studyRecordType } from './values.ts';
import { workbookAttemptType, workbookPaperType } from './workbook-values.ts';
import type { WorkspaceDisplay } from './workspace-projection.ts';
import { workspaceOccurredAt } from './workspace-search.ts';
import { isSourceFactId } from './source-values.ts';
import { workspaceEntryKinds as entryKinds, workspaceEntryType } from './workspace-values.ts';

export class WorkspaceCatalogInputError extends Error {}

const maximumPage = 50;
const defaultPage = 20;
const maximumTextChunk = 12_000;
const defaultTextChunk = 6_000;

type AccessCategory = {
  readonly id: string;
  readonly label: string;
  readonly types: readonly string[];
};
export const categories: readonly AccessCategory[] = [
  { id: 'practice', label: '练习', types: [ridingPracticeType] },
  { id: 'paper', label: '试卷', types: [workbookPaperType] },
  { id: 'attempt', label: '作答', types: [workbookAttemptType] },
  { id: 'textbook', label: '个人教材', types: [textbookPageType] },
  { id: 'note', label: '笔记', types: [organizerNoteType] },
  { id: 'material', label: '材料', types: [materialType] },
  { id: 'record', label: '学习记录', types: [studyRecordType] },
  { id: 'goal', label: '目标', types: [goal.type] },
  { id: 'task', label: '任务', types: [task.type] },
  { id: 'entry', label: '生成条目', types: [workspaceEntryType, assetType] },
];
export const allowedTypes = new Set(categories.flatMap((category) => category.types));
export type AccessRow = {
  readonly id: string;
  readonly type: string;
  readonly current_rev: number;
  readonly purpose: unknown;
  readonly created_tick: string | number | bigint;
  readonly author: string;
};

type AccessItem = {
  readonly id: string;
  readonly rev: number;
  readonly type: string;
  readonly category: string;
  readonly kind?: string;
  readonly title: string;
  readonly excerpt: string;
  readonly occurredAt: string | null;
  readonly tags: readonly string[];
  readonly author: string;
  readonly teaching: boolean;
  readonly eligible: boolean;
  readonly purposes: readonly string[];
};

type Cursor = { readonly tick: string; readonly id: string };

export function purposesOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    return [];
  }
  return [...new Set(value)];
}

function categoryOfType(type: string) {
  return categories.find((category) => category.types.includes(type));
}

function categoryOf(value: string | null): AccessCategory | undefined {
  if (!value || value === 'all') return undefined;
  const category = categories.find((entry) => entry.id === value);
  if (!category) throw new WorkspaceCatalogInputError('学习记录分类无效。');
  return category;
}

function readLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null || value === '') return fallback;
  if (!/^[1-9][0-9]{0,5}$/.test(value)) throw new WorkspaceCatalogInputError('分页数量无效。');
  return Math.min(Number(value), maximum);
}

function readOffset(value: string | null): number {
  if (value === null || value === '') return 0;
  if (!/^(?:0|[1-9][0-9]{0,7})$/.test(value)) throw new WorkspaceCatalogInputError('内容位置无效。');
  return Number(value);
}

function readSearch(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 120 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new WorkspaceCatalogInputError('搜索词无效。');
  }
  return trimmed;
}

export function encodeCursor(row: AccessRow): string {
  return Buffer.from(JSON.stringify([String(row.created_tick), row.id]), 'utf8').toString('base64url');
}

function decodeCursor(value: string | null): Cursor | undefined {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(value)) throw new WorkspaceCatalogInputError('分页位置无效。');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error();
    const [tick, id] = parsed;
    if (typeof tick !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(tick)) throw new Error();
    if (!isSourceFactId(id)) throw new Error();
    return { tick, id };
  } catch {
    throw new WorkspaceCatalogInputError('分页位置无效。');
  }
}

function authorOf(value: string): string {
  if (value === 'learner' || value === 'companion') return value;
  return 'unknown';
}

export type AccessDisplay = { display: WorkspaceDisplay; purposes: readonly string[]; fact: FactSnapshot };

export function itemOf(row: AccessRow, {display, purposes, fact}: AccessDisplay): AccessItem {
  const category = categoryOfType(row.type);
  return {
    id: row.id,
    rev: row.current_rev,
    type: row.type,
    category: category?.id ?? 'other',
    ...(display.kind ? { kind: display.kind } : {}),
    title: display.title,
    excerpt: display.excerpt,
    occurredAt: workspaceOccurredAt(fact),
    tags: display.tags ?? [],
    author: authorOf(row.author),
    teaching: purposes.includes('teaching') || purposes.includes('all'),
    eligible: row.type !== assetType && !purposes.includes('all'),
    purposes,
  };
}

export function workspaceRecordPage(row: AccessRow, read: AccessDisplay, offset: number, limit: number) {
  const start = Math.min(offset, read.display.text.length);
  const end = Math.min(start + limit, read.display.text.length);
  return {
    ...itemOf(row, read),
    related: [] as { id: string; title: string }[],
    ...(read.display.question ? { question: read.display.question } : {}),
    text: read.display.text.slice(start, end),
    offset: start,
    nextOffset: end < read.display.text.length ? end : null,
  };
}

const catalogKinds = new Set<string>([...entryKinds, 'discipline', 'method', 'archetype', 'textbook', 'capture']);
export function workspaceCatalogQuery(params: URLSearchParams) {
  const limit = readLimit(params.get('limit'), defaultPage, maximumPage);
  const cursor = decodeCursor(params.get('cursor'));
  const category = categoryOf(params.get('category'));
  const kind = params.get('kind');
  if (kind && !catalogKinds.has(kind)) throw new WorkspaceCatalogInputError('工作区条目类型无效。');
  const query = readSearch(params.get('query'));
  const types = category ? [...category.types] : [...allowedTypes];
  return {limit, cursor, kind, query, types};
}

export function workspaceCatalogPage(params: URLSearchParams) {
  const offset = readOffset(params.get('offset'));
  const limit = readLimit(params.get('limit'), defaultTextChunk, maximumTextChunk);
  return {offset, limit};
}
