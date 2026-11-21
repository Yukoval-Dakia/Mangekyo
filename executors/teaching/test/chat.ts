import { onTestFinished, vi } from 'vitest';
import type { TeachingDependencies } from '../index.ts';
import type { ToolArgs, ToolDefinition } from '../learning-tools.ts';
import type { FunctionCall } from '../provider-stream.ts';

export const model = 'auto/deepseek-v4.1-flash';
export const providerModel = 'raccoon/sn-deepseek-v4-1-flash-1017';
export const deps = {
  provider: { baseUrl: 'https://example.test/v1' },
  runEffect: (step, invoke) => invoke(String(step.index)),
} satisfies Pick<TeachingDependencies, 'provider' | 'runEffect'>;

export function toolCall(id: string, name: string, args: ToolArgs): FunctionCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

export function chatReply(output: string | FunctionCall[], reportedModel = model) {
  const message = typeof output === 'string'
    ? { role: 'assistant', content: output }
    : { role: 'assistant', content: null, tool_calls: output };
  return Response.json({ model: reportedModel, choices: [{
    message, finish_reason: typeof output === 'string' ? 'stop' : 'tool_calls',
  }] });
}

export function responseFrame(delta: object, model = providerModel, finishReason: string | null = null) {
  return 'data: ' + JSON.stringify({model, choices: [{index: 0, delta, finish_reason: finishReason}]}) + '\r\n\r\n';
}

export function sseEvent(type: string, value: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
}

export function anthropicBlock(index: number, contentBlock: object, ...deltas: object[]) {
  return [sseEvent('content_block_start', {index, content_block: contentBlock}),
    ...deltas.map(delta => sseEvent('content_block_delta', {index, delta})),
    sseEvent('content_block_stop', {index})];
}

export type ChatRequest = { model: string; reasoning_effort: string; tools: ToolDefinition[];
  messages: { role: string; content: string }[] };

export function mockChat(plan: (body: ChatRequest, round: number) => string | FunctionCall[]) {
  let round = 0;
  return watchFetch().mockImplementation(async (_url, init) => chatReply(plan(bodyOf(init), round++)));
}

export function watchFetch() {
  const send = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected fetch'));
  onTestFinished(() => { send.mockRestore(); });
  return send;
}

export const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body));

export function sseResponse(body: string | ReadableStream<Uint8Array>) {
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
