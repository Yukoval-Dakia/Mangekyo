import {
  factId,
  type CommandContext,
  type FactId,
  type Revision,
} from '@mangekyo/kernel';
import { textMaterial } from './library-values.ts';

export const organizerTaskType = 'activity.organizerTask';
export const organizerNoteType = 'activity.organizerNote';

export const createOrganizerTask = 'activity.organizerCreateTask';
export const setOrganizerTaskDone = 'activity.organizerSetTaskDone';
export const createOrganizerNote = 'activity.organizerCreateNote';
export const saveOrganizerNote = 'activity.organizerSaveNote';
export const restoreOrganizerNote = 'activity.organizerRestoreNote';

const titleLimit = 240;
const markdownLimit = 8000;

export type OrganizerTask = {
  readonly title: string;
  readonly date: string;
  readonly done: boolean;
};

export type OrganizerNoteSource = {
  readonly id: FactId;
  readonly title: string;
};

export type OrganizerNote = {
  readonly title: string;
  readonly markdown: string;
  readonly source: OrganizerNoteSource | null;
};

export type OrganizerNoteDraft = {
  readonly title: string;
  readonly markdown: string;
  readonly materialId: FactId | null;
};

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('安排格式无效。');
  return input as Record<string, unknown>;
}

function storable(value: string): boolean {
  return value.isWellFormed() && !value.includes('\u0000');
}

function text(input: Record<string, unknown>, key: string, limit: number, label: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > limit || !storable(value)) {
    throw new Error(`${label}无效。`);
  }
  return value;
}

function title(input: unknown, key = 'title'): string {
  return text(record(input), key, titleLimit, '标题').trim();
}

function calendarDate(input: Record<string, unknown>): string {
  const value = text(input, 'date', 10, '日期');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error('请选择有效日期。');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 ||
    year > 2200 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error('请选择有效日期。');
  }
  return value;
}

function revision(input: Record<string, unknown>, key: string): Revision {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('版本号无效。');
  }
  return value as Revision;
}

function material(input: Record<string, unknown>): FactId | null {
  const value = input.materialId;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('链接材料无效。');
  return factId(value);
}

function parsedSource(value: unknown): OrganizerNoteSource | null {
  if (value === null) return null;
  const source = record(value);
  if (typeof source.id !== 'string') throw new Error('笔记来源无效。');
  return { id: factId(source.id), title: title(source) };
}

export function organizerTask(input: unknown): OrganizerTask {
  const value = record(input);
  const done = value.done;
  if (typeof done !== 'boolean') throw new Error('完成状态无效。');
  return { title: title(value), date: calendarDate(value), done };
}

export function organizerNote(input: unknown): OrganizerNote {
  const value = record(input);
  const markdown = text(value, 'markdown', markdownLimit, '笔记正文');
  return { title: title(value), markdown, source: parsedSource(value.source) };
}

export function organizerTaskDraft(input: unknown): OrganizerTask {
  return organizerTask({ ...record(input), done: false });
}

export function organizerTaskDoneInput(input: unknown) {
  const value = record(input);
  if (typeof value.id !== 'string') throw new Error('任务标识无效。');
  if (typeof value.done !== 'boolean') throw new Error('完成状态无效。');
  return {
    id: factId(value.id),
    expectedRev: revision(value, 'expectedRev'),
    done: value.done,
  };
}

export function organizerNoteDraft(input: unknown): OrganizerNoteDraft {
  const value = record(input);
  return {
    title: title(value),
    markdown: text(value, 'markdown', markdownLimit, '笔记正文'),
    materialId: material(value),
  };
}

export function organizerNoteSaveInput(input: unknown) {
  const value = record(input);
  if (typeof value.id !== 'string') throw new Error('笔记标识无效。');
  return {
    id: factId(value.id),
    expectedRev: revision(value, 'expectedRev'),
    ...organizerNoteDraft(value),
  };
}

export function organizerNoteRestoreInput(input: unknown) {
  const value = record(input);
  if (typeof value.id !== 'string') throw new Error('笔记标识无效。');
  const expectedRev = revision(value, 'expectedRev');
  const restoreRev = revision(value, 'restoreRev');
  if (restoreRev >= expectedRev) throw new Error('只能恢复更早的版本。');
  return { id: factId(value.id), expectedRev, restoreRev };
}

export async function verifiedSource(
  ctx: CommandContext,
  materialId: FactId | null,
): Promise<OrganizerNoteSource | null> {
  if (materialId === null) return null;
  const material = await ctx.read.fact(materialId, { mode: 'following' });
  const value = textMaterial(material.value);
  return { id: materialId, title: value.title };
}
