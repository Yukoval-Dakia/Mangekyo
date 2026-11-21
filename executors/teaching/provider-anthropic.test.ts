import {expect, it} from 'vitest';
import {readAnthropicCompletion} from './anthropic-provider.ts';
import {requestCompletion} from './provider.ts';
import {anthropicBlock, bodyOf, sseEvent, sseResponse, toolCall, watchFetch} from './test/chat.ts';

const anthropicProvider = {baseUrl: 'https://api.anthropic.test/v1', protocol: 'anthropic' as const,
  model: 'claude-sonnet-5', reasoningEffort: 'default'};

function anthropicStream(content: string[], stopReason: string, model = anthropicProvider.model) {
  return [sseEvent('message_start', {message: {id: 'msg_1', type: 'message', model, content: []}}), ...content,
    sseEvent('message_delta', {delta: {stop_reason: stopReason}, usage: {output_tokens: 1}}),
    sseEvent('message_stop', {})].join('');
}

function completionBody(...history: Record<string, unknown>[]) {
  return JSON.stringify({model: anthropicProvider.model, max_completion_tokens: 2048,
    messages: [{role: 'system', content: '系统'}, {role: 'user', content: '算一下'}, ...history],
    tools: [{type: 'function', function: {name: 'python', description: '验算',
      parameters: {type: 'object', properties: {code: {type: 'string'}}, required: ['code']}}}]});
}

it('rejects a malformed native tool call without executing it as an empty object', async () => {
  const response = Response.json({type: 'message', model: 'test', stop_reason: 'tool_use',
    content: [{type: 'tool_use', id: 'one', name: 'lookup', input: null}]});
  await expect(readAnthropicCompletion(response, {allowTools: true})).rejects.toThrow('Invalid tool input');
});

it('translates tool history and completes multiple native Messages rounds', async () => {
  const toolStream = anthropicStream([...anthropicBlock(0, {type: 'thinking', thinking: ''},
    {type: 'thinking_delta', thinking: '私有推理'}),
    ...anthropicBlock(1, {type: 'tool_use', id: 'toolu_1', name: 'python', input: {}},
      {type: 'input_json_delta', partial_json: '{"code":"print'}, {type: 'input_json_delta', partial_json: '(45)"}'}),
  ], 'tool_use');
  const textStream = anthropicStream(anthropicBlock(0, {type: 'text', text: ''},
    {type: 'text_delta', text: '验算完成。'}), 'end_turn');
  const fetch = watchFetch().mockResolvedValueOnce(sseResponse(toolStream)).mockResolvedValueOnce(sseResponse(textStream));
  const endpoint = `${anthropicProvider.baseUrl}/messages`;
  const complete = (id: string, ...history: Record<string, unknown>[]) =>
    requestCompletion(endpoint, completionBody(...history), 'secret', id, {allowTools: true}, anthropicProvider);
  const first = await complete('request-1');
  const assistantContent = [{type: 'thinking', thinking: '私有推理'},
    {type: 'tool_use', id: 'toolu_1', name: 'python', input: {code: 'print(45)'}}];
  expect(first).toMatchObject({model: 'claude-sonnet-5',
    toolCalls: [{id: 'toolu_1', function: {name: 'python', arguments: '{"code":"print(45)"}'}}],
    providerTurn: {protocol: 'anthropic', content: assistantContent}});
  const second = await complete('request-2',
    {role: 'assistant', content: null, tool_calls: [toolCall('toolu_1', 'python', {code: 'print(45)'})],
      providerTurn: 'providerTurn' in first ? first.providerTurn : undefined},
    {role: 'tool', tool_call_id: 'toolu_1', content: '45'});
  expect(second).toMatchObject({content: '验算完成。', model: 'claude-sonnet-5'});
  const [initial, continuation] = fetch.mock.calls;
  const outboundHeaders = new Headers(initial?.[1]?.headers);
  expect(String(initial?.[0])).toBe('https://api.anthropic.test/v1/messages');
  expect(outboundHeaders.get('x-api-key')).toBe('secret');
  expect(outboundHeaders.get('anthropic-version')).toBe('2023-06-01');
  expect(outboundHeaders.get('authorization')).toBeNull();
  const outbound = bodyOf(initial?.[1]);
  expect(outbound).toMatchObject({model: 'claude-sonnet-5', max_tokens: 2048, stream: true, system: '系统',
    tools: [{name: 'python', input_schema: {type: 'object'}}]});
  expect(outbound).not.toHaveProperty('output_config');
  expect(bodyOf(continuation?.[1]).messages).toEqual([
    {role: 'user', content: [{type: 'text', text: '算一下'}]}, {role: 'assistant', content: assistantContent},
    {role: 'user', content: [{type: 'tool_result', tool_use_id: 'toolu_1', content: '45'}]}]);
});
