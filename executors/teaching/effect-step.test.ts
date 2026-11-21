import { expect, it } from 'vitest';
import { teachingEffectStep } from './effect-step.ts';
import type { TeachingDispatch, TeachingModelStep } from './index.ts';
import type { Json } from '@mangekyo/kernel';

const step: TeachingModelStep = {
  index: 0,
  provider: 'https://example.test/v1/chat/completions',
  model: 'auto/deepseek-v4.1-flash',
  requestDigest: 'd'.repeat(64),
};

const memorySend = { purpose: 'practice', recipient: { id: 'p', endpoint: 'e', protocol: 'openai', model: 'm', workspaceRevision: 'w' }, requestDigest: step.requestDigest, fragments: [] };

const invoke = async () => JSON.stringify({ reportedModel: 'served/model', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, message: '完成。' });
const dispatch: TeachingDispatch = send => send();

it('surfaces reportedModel and usage alongside a serialized memory-send reply', async () => {
  const recorded = teachingEffectStep(step, invoke, { basis: 1 } as never, memorySend as never);
  const out = await recorded.invoke('req-1', dispatch) as Record<string, unknown>;
  expect(out.reportedModel).toBe('served/model');
  expect(out.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  expect(recorded.reply(out as Json)).toBe(JSON.stringify({ reportedModel: 'served/model', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, message: '完成。' }));
});

it('keeps the raw reply when it is not a JSON object or lacks usage', async () => {
  const plain = teachingEffectStep(step, async () => 'plain text', {} as never, memorySend as never);
  const plainOut = await plain.invoke('req-2', dispatch) as Record<string, unknown>;
  expect(plainOut.reportedModel).toBeUndefined();
  expect(plainOut.usage).toBeUndefined();
  expect(plainOut.reply).toBe('plain text');

  const partial = teachingEffectStep(step, async () => JSON.stringify({ reportedModel: 'served/model', message: 'hi' }), {} as never, memorySend as never);
  const partialOut = await partial.invoke('req-3', dispatch) as Record<string, unknown>;
  expect(partialOut.reportedModel).toBe('served/model');
  expect(partialOut.usage).toBeUndefined();
});
