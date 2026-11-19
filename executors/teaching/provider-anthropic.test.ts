import { afterEach, expect, it, vi } from 'vitest';
import { readAnthropicCompletion } from './anthropic-provider.ts';
import { requestCompletion } from './provider.ts';

const anthropicProvider = {
  baseUrl: 'https://api.anthropic.test/v1',
  protocol: 'anthropic' as const,
  model: 'claude-sonnet-5',
  reasoningEffort: 'default',
};
const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body));

afterEach(() => vi.restoreAllMocks());

function event(type: string, value: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
}

function anthropicStream(content: string[], stopReason: string, model = anthropicProvider.model) {
  return [
    event('message_start', {message: {id: 'msg_1', type: 'message', model, content: []}}),
    ...content,
    event('message_delta', {delta: {stop_reason: stopReason}, usage: {output_tokens: 1}}),
    event('message_stop', {}),
  ].join('');
}

function block(index: number, content_block: object, ...deltas: object[]) {
  return [
    event('content_block_start', {index, content_block}),
    ...deltas.map(delta => event('content_block_delta', {index, delta})),
    event('content_block_stop', {index}),
  ];
}

function completionBody(messages: Record<string, unknown>[]) {
  return JSON.stringify({
    model: anthropicProvider.model, max_completion_tokens: 2048, messages,
    tools: [{type: 'function', function: {
      name: 'python', description: '验算',
      parameters: {type: 'object', properties: {code: {type: 'string'}}, required: ['code']},
    }}],
  });
}

it('rejects a malformed native tool call without executing it as an empty object', async () => {
  const response = Response.json({type: 'message', model: 'test', stop_reason: 'tool_use',
    content: [{type: 'tool_use', id: 'one', name: 'lookup', input: null}]});
  await expect(readAnthropicCompletion(response, {allowTools: true})).rejects.toThrow('Invalid tool input');
});

it('translates tool history and completes multiple native Messages rounds', async () => {
  const requests: {url: string; headers: Headers; body: Record<string, any>}[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    const body = bodyOf(init);
    requests.push({url: String(url), headers: new Headers(init?.headers), body});
    const toolStream = anthropicStream([
      ...block(0, {type: 'thinking', thinking: ''}, {type: 'thinking_delta', thinking: '私有推理'}),
      ...block(1, {type: 'tool_use', id: 'toolu_1', name: 'python', input: {}},
        {type: 'input_json_delta', partial_json: '{"code":"print'},
        {type: 'input_json_delta', partial_json: '(45)"}'}),
    ], 'tool_use');
    const textStream = anthropicStream(
      block(0, {type: 'text', text: ''}, {type: 'text_delta', text: '验算完成。'}), 'end_turn');
    return new Response(requests.length === 1 ? toolStream : textStream, {
      headers: {'content-type': 'text/event-stream'},
    });
  });
  const endpoint = `${anthropicProvider.baseUrl}/messages`;
  const first = await requestCompletion(endpoint, completionBody([
    {role: 'system', content: '系统'}, {role: 'user', content: '算一下'},
  ]), 'secret', 'request-1', {allowTools: true}, anthropicProvider);
  expect(first).toMatchObject({
    model: 'claude-sonnet-5',
    toolCalls: [{id: 'toolu_1', function: {name: 'python', arguments: '{"code":"print(45)"}'}}],
  });
  expect(first).toMatchObject({
    providerTurn: {protocol: 'anthropic', content: [
      {type: 'thinking', thinking: '私有推理'},
      {type: 'tool_use', id: 'toolu_1', name: 'python', input: {code: 'print(45)'}},
    ]},
  });

  const second = await requestCompletion(endpoint, completionBody([
    {role: 'system', content: '系统'},
    {role: 'user', content: '算一下'},
    {role: 'assistant', content: null, tool_calls: [{
      id: 'toolu_1', type: 'function', function: {name: 'python', arguments: '{"code":"print(45)"}'},
    }], providerTurn: 'providerTurn' in first ? first.providerTurn : undefined},
    {role: 'tool', tool_call_id: 'toolu_1', content: '45'},
  ]), 'secret', 'request-2', {allowTools: true}, anthropicProvider);
  expect(second).toMatchObject({content: '验算完成。', model: 'claude-sonnet-5'});

  expect(requests[0]?.url).toBe('https://api.anthropic.test/v1/messages');
  expect(requests[0]?.headers.get('x-api-key')).toBe('secret');
  expect(requests[0]?.headers.get('anthropic-version')).toBe('2023-06-01');
  expect(requests[0]?.headers.get('authorization')).toBeNull();
  expect(requests[0]?.body).toMatchObject({
    model: 'claude-sonnet-5', max_tokens: 2048, stream: true, system: '系统',
    tools: [{name: 'python', input_schema: {type: 'object'}}],
  });
  expect(requests[0]?.body).not.toHaveProperty('output_config');
  expect(requests[1]?.body.messages).toEqual([
    {role: 'user', content: [{type: 'text', text: '算一下'}]},
    {role: 'assistant', content: [
      {type: 'thinking', thinking: '私有推理'},
      {type: 'tool_use', id: 'toolu_1', name: 'python', input: {code: 'print(45)'}},
    ]},
    {role: 'user', content: [{type: 'tool_result', tool_use_id: 'toolu_1', content: '45'}]},
  ]);
});
