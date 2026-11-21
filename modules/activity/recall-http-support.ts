import { createHmac, timingSafeEqual } from '@mangekyo/kernel';
import { parseRecallMount, type RecallMount } from './recall-values.ts';
import { workbookRequestId } from './workbook-values.ts';
export class RecallRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const recallDisplayToken = 'x-recall-display-token';
const idPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);

export function readMount(value: unknown) {
  try { return parseRecallMount(value); }
  catch { throw new RecallRequestError(400, '回忆题挂载标识无效。'); }
}

export function readRequestId(value: unknown) {
  try { return workbookRequestId(value); }
  catch { throw new RecallRequestError(400, '回忆题请求标识无效。'); }
}

export type DisplayReceipt = { sessionId: string; mount: RecallMount; revealId: string; requestId: string; token: string };
export type DisplayHeaders = Record<string, string | string[] | undefined>;

export function displaySigner(learner: string, key: Buffer) {
  return ({ sessionId, mount, revealId, requestId }: Omit<DisplayReceipt, 'token'>) =>
    createHmac('sha256', key).update(JSON.stringify([
      learner, sessionId, mount.turnId, mount.derivationId, mount.itemId, revealId, requestId,
    ])).digest();
}

export function verifyDisplayReceipt(receipt: unknown, sign: ReturnType<typeof displaySigner>) {
  const report = receipt as DisplayReceipt;
  const supplied = Buffer.from(report.token, 'hex');
  if (supplied.length !== 32 || !timingSafeEqual(supplied, sign(report))) return null;
  return { mount: report.mount, revealId: report.revealId };
}

export function parseDisplayBody(body: Record<string, unknown>, headers: DisplayHeaders) {
  const token = headers[recallDisplayToken];
  const { revealId, requestId, observed } = body;
  if (headers['sec-fetch-site'] !== 'same-origin' || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token) ||
      observed !== 'mounted-visible') throw new RecallRequestError(403, '缺少获准的回忆题显示回执。');
  if (Object.keys(body).length !== 4 || !isId(revealId)) throw new RecallRequestError(400, '回忆题显示回执格式无效。');
  return { mount: readMount(body.mount), requestId: readRequestId(requestId), revealId, token };
}
