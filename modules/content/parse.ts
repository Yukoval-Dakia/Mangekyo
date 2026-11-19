import { factId, type Revision } from '@mangekyo/kernel';

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('教材数据必须是对象。');
  }
  return value as Record<string, unknown>;
}

export function fields(value: Record<string, unknown>, ...keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('教材数据含有未声明字段。');
  }
}

export function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('教材数据必须是数组。');
  return value;
}

export function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\u0000')
    || (!allowEmpty && !value.trim())) {
    throw new Error(`${label}无效。`);
  }
  return value;
}

export function key(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) {
    throw new Error('教材标识无效。');
  }
  return value;
}

export function optionalKey(value: unknown): string | null {
  return value === null ? null : key(value);
}

export function pageId(value: unknown) {
  return factId(text(value, '事实标识'));
}

export function revision(value: unknown): Revision {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error('教材基版本无效。');
  }
  return value as Revision;
}

export function editSequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('客户端编辑序号无效。');
  }
  return value;
}
