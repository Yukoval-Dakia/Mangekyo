import { factId } from '@mangekyo/kernel';
import { captureObject, captureText } from './parse.ts';

export function paperInteger(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${label}无效。`);
  return value;
}

export function paperMarker(input: unknown) {
  const { issuanceId, page } = captureObject(input);
  return { issuanceId: factId(captureText(issuanceId, '发卷标识', 26)),
    page: paperInteger(page, 1, 1_000_000, '回收页码') };
}

export function paperAssignment(input: unknown) {
  const row = captureObject(input);
  return { ...paperMarker(row), original: paperInteger(row.original, 0, 1_000_000, '回收图片位置'),
    ...(row.retryId === undefined ? {} : { retryId: factId(captureText(row.retryId, '再做标识', 26)) }) };
}
