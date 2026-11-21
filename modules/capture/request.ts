import { LifecycleError } from '@mangekyo/kernel';

export class RequestError extends Error {
  constructor(readonly status: number, message: string, readonly responseCode?: string) {
    super(message);
  }
}

export function submittedWatermark(input: unknown): string {
  const raw = input && typeof input === 'object' && 'deletionWatermark' in input ? input.deletionWatermark : undefined;
  if (raw === undefined) return '0';
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(raw)) throw new LifecycleError(400, '删除水位无效。');
  return raw;
}

export function clientRequest(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) {
    throw new RequestError(400, '请求标识无效。');
  }
  return value;
}
