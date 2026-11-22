import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { extractPhotoWithVisionOrFallback, type PhotoVisionExtractionInput, type VisionLlmConfig } from './vision-ocr.ts';
const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
const reply = (content: string, finishReason = 'stop') =>
  Response.json({ choices: [{ message: { content }, finish_reason: finishReason }] });
const okJson = JSON.stringify({ version: 'v1', questions: [{ number: '1' }], warnings: [] });
const base = async (visionConfig: VisionLlmConfig = { baseUrl: 'https://v.test', model: 'm' }): Promise<PhotoVisionExtractionInput> =>
  ({ bytes: await png(), storedPath: 'x.png', textLimit: 500, visionConfig,
    fallbackExtractLocal: vi.fn(async () => ({ status: 'ok' })) as never });
const tokens = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)).max_tokens as number;
it('retries once on empty content and returns vision_llm', async () => {
  const send = vi.fn().mockResolvedValueOnce(reply('')).mockResolvedValueOnce(reply(okJson));
  const result = await extractPhotoWithVisionOrFallback({ ...(await base()), fetch: send });
  expect(result.kind).toBe('vision_llm');
  expect(send).toHaveBeenCalledTimes(2);
});
it('doubles max_tokens on retry when finish_reason is length', async () => {
  const send = vi.fn().mockResolvedValueOnce(reply('', 'length')).mockResolvedValueOnce(reply(okJson));
  const result = await extractPhotoWithVisionOrFallback({ ...(await base()), fetch: send });
  expect(result.kind).toBe('vision_llm');
  expect(tokens(send.mock.calls[0]!)).toBe(16_384);
  expect(tokens(send.mock.calls[1]!)).toBe(32_768);
});
it('falls back after a second empty response or small budget', async () => {
  const bothEmpty = vi.fn().mockResolvedValueOnce(reply('')).mockResolvedValueOnce(reply(''));
  expect((await extractPhotoWithVisionOrFallback({ ...(await base()), fetch: bothEmpty })).kind).toBe('vision_fallback');
  expect(bothEmpty).toHaveBeenCalledTimes(2);
  const lowBudget = vi.fn().mockResolvedValueOnce(reply('')).mockResolvedValueOnce(reply(okJson));
  const input = await base({ baseUrl: 'https://v.test', model: 'm', timeoutMs: 15_000 });
  expect((await extractPhotoWithVisionOrFallback({ ...input, fetch: lowBudget })).kind).toBe('vision_fallback');
  expect(lowBudget).toHaveBeenCalledTimes(1);
  expect(input.fallbackExtractLocal).toHaveBeenCalledTimes(1);
});
