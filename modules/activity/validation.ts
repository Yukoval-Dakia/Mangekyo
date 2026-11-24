import { factId, type FactId, type Revision } from '@mangekyo/kernel';

type ErrorFactory = () => Error;
type TextErrorFactory = (reason: 'type' | 'invalid' | 'storage' | 'length') => Error;
type TextOptions = {
  readonly limit?: number; readonly requireNonempty?: boolean;
  readonly preserveWhitespace?: boolean; readonly trimBeforeStorage?: boolean;
  readonly storable?: boolean; readonly storageBeforeLength?: boolean;
};

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
export const isStorable = (value: string): boolean => value.isWellFormed() && !value.includes('\u0000');
export const isPositiveRevision = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

export const recordParser = (invalid: ErrorFactory) => (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  return input as Record<string, unknown>;
};

export const optionalRecord = (input: unknown): Record<string, unknown> | undefined =>
  input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined;

export function exactRecordParser(invalid: ErrorFactory) {
  return (input: unknown, names: readonly string[]): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== names.length || names.some(name => !Object.hasOwn(input, name))) throw invalid();
    return input as Record<string, unknown>;
  };
}

export const unknownFieldsParser = (invalid: ErrorFactory) =>
  (value: Record<string, unknown>, allowed: readonly string[]): void => {
    if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
  };

export function textValue(value: unknown, invalid: TextErrorFactory, options: TextOptions): string {
  if (typeof value !== 'string') throw invalid('type');
  const result = options.preserveWhitespace === false ? value.trim() : value;
  if ((options.requireNonempty ?? true) && !result.trim()) throw invalid('invalid');
  const tooLong = options.limit !== undefined && result.length > options.limit;
  const unstorable = (options.storable ?? true) && !isStorable(options.trimBeforeStorage ? result : value);
  if (options.storageBeforeLength === true) {
    if (unstorable) throw invalid('storage');
    if (tooLong) throw invalid('length');
  } else {
    if (tooLong) throw invalid('length');
    if (unstorable) throw invalid('storage');
  }
  return result;
}

export const positiveRevision = (value: unknown, invalid: ErrorFactory): Revision => {
  if (!isPositiveRevision(value)) throw invalid();
  return value as Revision;
};

export function patternParser(pattern: RegExp, invalid: ErrorFactory) {
  return (value: unknown): string => {
    if (typeof value !== 'string' || !pattern.test(value)) throw invalid();
    return value;
  };
}

export function factIdParser(invalid: ErrorFactory) {
  return (value: unknown): FactId => {
    if (typeof value !== 'string') throw invalid();
    return factId(value);
  };
}

export function utcTimestamp(value: unknown, invalid: ErrorFactory, catchInvalidDate = false): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw invalid();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) && catchInvalidDate) throw invalid();
  if (parsed.toISOString() !== value) throw invalid();
  return value;
}
