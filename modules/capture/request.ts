export class RequestError extends Error {
  constructor(readonly status: number, message: string, readonly responseCode?: string) {
    super(message);
  }
}

export function clientRequest(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) {
    throw new RequestError(400, '请求标识无效。');
  }
  return value;
}
