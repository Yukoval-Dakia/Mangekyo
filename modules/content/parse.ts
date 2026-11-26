import { factId, type Revision } from '@mangekyo/kernel';

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('教材数据必须是对象。');
  return value as Record<string, unknown>;
}

export function fields(value: Record<string, unknown>, ...keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('教材数据含有未声明字段。');
}

export function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('教材数据必须是数组。');
  return value;
}

export function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\u0000') || (!allowEmpty && !value.trim())) {
    throw new Error(`${label}无效。`);
  }
  return value;
}

export function key(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) throw new Error('教材标识无效。');
  return value;
}

export function optionalKey(value: unknown): string | null { return value === null ? null : key(value); }

export function pageId(value: unknown) { return factId(text(value, '事实标识')); }

export function revision(value: unknown): Revision {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('教材基版本无效。');
  return value as Revision;
}

export function editSequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('客户端编辑序号无效。');
  return value;
}

const isoPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function requireIso(value: unknown, label: string): string {
  const match = typeof value === 'string' ? isoPattern.exec(value) : null;
  if (!match) throw new Error(`${label}不是合法的 ISO 时间戳。`);
  const [year, month, day, hour, minute, second] = [
    Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]),
  ];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  const zone = match[7]!;
  const badZone = zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59);
  if (month < 1 || month > 12 || day < 1 || day > maxDay || hour > 23 || minute > 59 || second > 59 || badZone) {
    throw new Error(`${label}不是合法的 ISO 时间戳。`);
  }
  return value as string;
}

export function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const match = allowed.find(item => item === value);
  if (match === undefined) throw new Error(`${label}无效。`);
  return match;
}

export function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => jsonDeepEqual(entry, right[index]));
  }
  const keys = Object.keys(left);
  const read = (object: unknown, key: string) => (object as Record<string, unknown>)[key];
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && jsonDeepEqual(read(left, key), read(right, key)));
}

/** Truncates by Unicode code points so surrogate pairs are never split. */
export function safeSlice(value: string, maxChars: number): string { return Array.from(value).slice(0, maxChars).join(''); }

/** Drops undefined-valued keys, matching the conditional-spread shape without per-key boilerplate. */
export function compact<T extends Record<string, unknown>>(value: T): { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as never;
}

export type Rational = { readonly numerator: bigint; readonly denominator: bigint };
const decimalNumberPattern = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const fractionNumberPattern = /^([+-]?\d+)\s*\/\s*(\d+)$/;

// Rationals are never normalized: exact comparisons and arithmetic stay correct under cross-multiplication,
// and skipping the gcd keeps parsing linear in digit count. Only the denominator sign is canonicalized.
function makeRational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new Error('有理分数的分母不能为 0。');
  return denominator < 0n ? { numerator: -numerator, denominator: -denominator } : { numerator, denominator };
}

function decimalRational(raw: string): Rational | null {
  const match = decimalNumberPattern.exec(raw.trim());
  if (!match) return null;
  const [, sign = '', integer = '', fraction, leading = '', exponent = ''] = match;
  const digits = integer + (fraction ?? leading);
  const shift = Number(exponent || 0) - (fraction ?? leading).length;
  if (!digits || !Number.isSafeInteger(shift) || Math.abs(shift) > 512 || digits.replace(/^0+/, '').length > 512) return null;
  const coefficient = BigInt((sign === '-' ? '-' : '') + digits);
  return makeRational(coefficient * 10n ** BigInt(Math.max(0, shift)), 10n ** BigInt(Math.max(0, -shift)));
}

/** Exact decimal or `a/b` fraction parse; huge magnitudes stay exact instead of overflowing to Infinity. */
export function rationalOf(value: number | string): Rational | null {
  if (typeof value === 'number') return Number.isFinite(value) ? decimalRational(String(value)) : null;
  const trimmed = value.trim();
  const fraction = fractionNumberPattern.exec(trimmed);
  if (!fraction) return decimalRational(trimmed);
  if (fraction[1]!.replace(/^[+-]/, '').replace(/^0+/, '').length > 512 || fraction[2]!.replace(/^0+/, '').length > 512) return null;
  const denominator = BigInt(fraction[2]!);
  return denominator === 0n ? null : makeRational(BigInt(fraction[1]!), denominator);
}

export function compareRationals(left: Rational, right: Rational): number {
  const diff = left.numerator * right.denominator - right.numerator * left.denominator;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

export function addRationals(left: Rational, right: Rational): Rational {
  return makeRational( left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator);
}

export function subtractRationals(left: Rational, right: Rational): Rational {
  return addRationals(left, { numerator: -right.numerator, denominator: right.denominator });
}

export function absRational(value: Rational): Rational {
  return value.numerator < 0n ? { numerator: -value.numerator, denominator: value.denominator } : value;
}

export function rationalToNumber(value: Rational): number {
  const raw = Number(value.numerator) / Number(value.denominator);
  if (Number.isFinite(raw)) return raw;
  const approx = Number((value.numerator * 1_000_000_000_000n) / value.denominator) / 1e12;
  return Number.isFinite(approx) ? approx : (value.numerator < 0n ? -Infinity : Infinity);
}
