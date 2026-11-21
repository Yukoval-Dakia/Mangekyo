import { CancelledFailure } from '@temporalio/common';
import { expect, it, vi } from 'vitest';
import { scoutReceipt } from '../src/research-scout.ts';

let aborted = false;
vi.mock('@temporalio/activity', () => ({
  heartbeat: vi.fn(),
  cancellationSignal: () => ({ aborted }) as AbortSignal,
}));
const { createCoordinatorActivity } = await import('../src/coordinator-activity.ts');

it('fails closed on malformed/overrun scout cost, invalid reserve, oversized UTF-8, and SyntaxError', () => {
  const parse = vi.fn((raw: string) => (JSON.parse(raw) as { ok: string }).ok);
  const reply = JSON.stringify({ ok: 'review' });
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, '10' as unknown as number, null as unknown as number])
    expect(scoutReceipt({ reply, actualUsdMicros: bad }, 10, parse)).toEqual({ decision: 'price_exceeded', actualUsdMicros: null, servedModel: null });
  expect(scoutReceipt({ reply, actualUsdMicros: 11 }, 10, parse)).toEqual({ decision: 'price_exceeded', actualUsdMicros: 11, servedModel: null });
  expect(scoutReceipt({ reply, actualUsdMicros: 5 }, 0, parse)).toEqual({ decision: 'price_exceeded', actualUsdMicros: 5, servedModel: null });
  expect(scoutReceipt({ reply: '中'.repeat(2731), actualUsdMicros: 5 }, 10, parse)).toEqual({ decision: 'invalid_reply', actualUsdMicros: 5, servedModel: null });
  expect(parse).not.toHaveBeenCalled();
  expect(scoutReceipt({ reply: '{bad', actualUsdMicros: 4 }, 10, parse)).toEqual({ decision: 'invalid_reply', actualUsdMicros: 4, servedModel: null });
  expect(scoutReceipt({ reply, servedModel: 'scout/v1' }, 10, parse)).toEqual({ decision: 'review', actualUsdMicros: null, servedModel: 'scout/v1' });
});

it('propagates opaque CancelledFailure when coordinator activity is cancelled', async () => {
  const ref = '11111111-1111-4111-8111-111111111111';
  const run = createCoordinatorActivity(async () => { throw new Error('secret-payload'); });
  aborted = true;
  const err = await run({ coordinatorRef: ref }).catch(error => error);
  expect(err).toBeInstanceOf(CancelledFailure);
  expect(err.stack).toBeUndefined();
  expect(err.message).not.toContain('secret-payload');
  aborted = false;
  await expect(run({ coordinatorRef: ref })).rejects.toMatchObject({ type: 'CoordinatorAdvanceFailed', nonRetryable: false });
});
