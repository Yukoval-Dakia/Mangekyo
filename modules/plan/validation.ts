import { factId, type Revision } from '@mangekyo/kernel';

export function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要对象。');
  return value as Record<string, unknown>;
}
export function text(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4000 ||
    !value.isWellFormed() ||
    value.includes('\0')
  )
    throw new Error('文字字段无效。');
  return value;
}
export function integer(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error('数值超出范围。');
  return value;
}
export function oneOf<const T extends string>(value: unknown, allowed: readonly T[]): T {
  const match = allowed.find((item) => item === value);
  if (!match) throw new Error('无法识别的规划选项。');
  return match;
}
export function date(value: unknown) {
  const day = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(day).toISOString().slice(0, 10) !== day)
    throw new Error('日期无效。');
  return day;
}
export function instant(value: unknown) {
  const at = text(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(at) ||
    !Number.isFinite(Date.parse(at))
  )
    throw new Error('需要带时区的时间。');
  date(at.slice(0, 10));
  return new Date(at).toISOString();
}
export function target(input: Record<string, unknown>) {
  return { id: factId(text(input.id)), expectedRev: integer(input.expectedRev, 1, 2147483647) as Revision };
}
