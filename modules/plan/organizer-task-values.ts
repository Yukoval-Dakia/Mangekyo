import { factId, type Revision } from '@mangekyo/kernel';

export const organizerTaskType = 'activity.organizerTask';
export const createOrganizerTask = 'activity.organizerCreateTask';
export const setOrganizerTaskDone = 'activity.organizerSetTaskDone';

const titleLimit = 240;

export type OrganizerTask = {
  readonly title: string;
  readonly date: string;
  readonly done: boolean;
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

export function organizerTask(input: unknown): OrganizerTask {
  const value = record(input);
  const done = value.done;
  if (typeof done !== 'boolean') throw new Error('完成状态无效。');
  return { title: title(value), date: calendarDate(value), done };
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
