import {expect, it, vi} from 'vitest';
import {anthropicRequestBody, readAnthropicCompletion} from './anthropic-provider.ts';
import {requestCompletion} from './provider.ts';
import {readProviderCompletion} from './provider-stream.ts';
import {runStudyAgent} from './study-agent.ts';
import {generateResearchDraft, sampleWorker, totalWorkerCost} from './research-worker.ts';
import {anthropicBlock, bodyOf, deps, providerModel, responseFrame, sseEvent, sseResponse, toolCall, watchFetch} from './test/chat.ts';

const anthropicProvider = {baseUrl: 'https://api.anthropic.test/v1', protocol: 'anthropic' as const,
  model: 'claude-sonnet-5', reasoningEffort: 'default'};
const event = (type: string, value: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
const block = (index: number, content_block: object, ...deltas: object[]) =>
  [event('content_block_start', {index, content_block}), ...deltas.map(delta => event('content_block_delta', {index, delta})), event('content_block_stop', {index})];

function anthropicStream(content: string[], stopReason: string, model = anthropicProvider.model) {
  return [sseEvent('message_start', {message: {id: 'msg_1', type: 'message', model, content: [], usage: {input_tokens: 7}}}), ...content,
    sseEvent('message_delta', {delta: {stop_reason: stopReason}, usage: {output_tokens: 5}}),
    sseEvent('message_stop', {})].join('');
}

it('reads validated usage from OpenAI-compatible stream and non-stream completions', async () => {
  const usage = {prompt_tokens: 7, completion_tokens: 5, total_tokens: 12};
  const stream = sseResponse(responseFrame({content: 'ok'}, undefined, 'stop') +
    'data: ' + JSON.stringify({model: providerModel, choices: [], usage}) + '\r\n\r\ndata: [DONE]\r\n\r\n');
  expect(await readProviderCompletion(stream, {})).toMatchObject({content: 'ok', usage});
  const json = Response.json({model: providerModel, usage, choices: [{
    finish_reason: 'stop', message: {role: 'assistant', content: 'ok'},
  }]});
  expect(await readProviderCompletion(json, {})).toMatchObject({content: 'ok', usage});
  expect(await readProviderCompletion(sseResponse(responseFrame({content: '太长'}, undefined, 'length') +
    'data: ' + JSON.stringify({model: providerModel, choices: [], usage}) + '\r\n\r\ndata: [DONE]\r\n\r\n'), {}))
    .toMatchObject({truncated: true, usage});
  await expect(readProviderCompletion(sseResponse('data: ' + JSON.stringify({
    model: providerModel, choices: [], usage: {prompt_tokens: -1},
  }) + '\n\n'), {})).rejects.toThrow('Invalid completion usage');
});

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
  expect('usage' in second ? second.usage : undefined).toEqual({prompt_tokens: 7, completion_tokens: 5, total_tokens: 12});
  const [initial, continuation] = fetch.mock.calls;
  const outboundHeaders = new Headers(initial?.[1]?.headers);
  expect(String(initial?.[0])).toBe('https://api.anthropic.test/v1/messages');
  expect([outboundHeaders.get('x-api-key'), outboundHeaders.get('anthropic-version'), outboundHeaders.get('authorization')]).toEqual(['secret', '2023-06-01', null]);
  const outbound = bodyOf(initial?.[1]);
  expect(outbound).toMatchObject({model: 'claude-sonnet-5', max_tokens: 2048, stream: true, system: '系统',
    tools: [{name: 'python', input_schema: {type: 'object'}}]});
  expect(outbound).not.toHaveProperty('output_config');
  expect(bodyOf(continuation?.[1]).messages).toEqual([
    {role: 'user', content: [{type: 'text', text: '算一下'}]}, {role: 'assistant', content: assistantContent},
    {role: 'user', content: [{type: 'tool_result', tool_use_id: 'toolu_1', content: '45'}]}]);
});

it('journals real model usage on each study-agent model effect', async () => {
  const usage = {prompt_tokens: 9, completion_tokens: 4, total_tokens: 13};
  const effects: unknown[] = [];
  const fetch = watchFetch().mockResolvedValueOnce(sseResponse(responseFrame({content: '好的。'}, undefined, 'stop') +
    'data: ' + JSON.stringify({model: providerModel, choices: [], usage}) + '\r\n\r\ndata: [DONE]\r\n\r\n'));
  const result = await runStudyAgent([{role: 'user', content: '解释一下。'}], {
    provider: deps.provider,
    runEffect: async (step, invoke) => {
      const raw = await invoke(String(step.index));
      effects.push({step, result: JSON.parse(raw)});
      return raw;
    },
  });
  expect(result).toMatchObject({message: '好的。', reportedModel: providerModel, usage});
  expect(effects).toHaveLength(1);
  expect(effects[0]).toMatchObject({step: {index: 0}, result: {reportedModel: providerModel, usage}});
  expect(bodyOf(fetch.mock.calls[0]?.[1]).stream_options).toEqual({include_usage: true});
});

it('enforces protocol bounds on Anthropic/OpenAI completions and research worker drafts', async () => {
  expect(anthropicRequestBody({ model: 'claude-sonnet-5', max_tokens: 100, stream: false, messages: [{ role: 'user', content: 'hi' }] }).stream).toBe(false);
  const unclosed = sseResponse(anthropicStream([event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'python', input: {} } }), event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"code":"1"}' } })], 'end_turn'));
  await expect(readAnthropicCompletion(unclosed, { allowTools: true })).rejects.toThrow('Incomplete tool call');
  const sparseResult = await readAnthropicCompletion(sseResponse(anthropicStream(block(2, { type: 'text', text: '' }, { type: 'text_delta', text: 'ok' }), 'end_turn')), {});
  expect('providerTurn' in sparseResult && sparseResult.providerTurn?.content).toEqual([{ type: 'text', text: 'ok' }]);
  expect(await readAnthropicCompletion(Response.json({ type: 'message', model: 'claude-sonnet-5', stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 'tu_1', name: 'python', input: null }] }), { allowTools: true })).toMatchObject({ truncated: true });
  await expect(readProviderCompletion(new Response('{bad', { headers: { 'content-type': 'application/json' } }), {})).rejects.toThrow('Invalid completion');
  await expect(readProviderCompletion(Response.json({ error: { message: 'boom' } }), {})).rejects.toThrow('Invalid completion');
  await expect(readProviderCompletion(Response.json({ model: 'm', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'a'.repeat(64_001) } }] }), {})).rejects.toThrow('Completion content too large');
  await expect(readProviderCompletion(sseResponse(`data: ${JSON.stringify({ model: 'm', choices: [{ delta: { reasoning_content: 'r'.repeat(400_000) } }] })}\n\n`.repeat(6)), {})).rejects.toThrow('Completion stream too large');
  const tariff = { route: 'r', endpoint: 'https://api.test/v1/chat/completions', model: 'auto/deepseek-v4.1-flash', reserveUsdMicros: 50, retentionDays: 0, protocol: 'openai' as const };
  const provider = { baseUrl: 'https://api.test/v1', apiKey: 'sk-secret-token-xyz', model: tariff.model, protocol: 'openai' as const };
  const okJson = (content: string, cost?: string) => new Response(JSON.stringify({ model: tariff.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }), { headers: { 'content-type': 'application/json', ...(cost !== undefined && { 'x-actual-usd-micros': cost }) } });
  const truncJson = new Response(JSON.stringify({ model: tariff.model, choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"title":"t"}' } }] }), { headers: { 'content-type': 'application/json', 'x-actual-usd-micros': '12' } });
  const fetchMock = watchFetch().mockResolvedValueOnce(okJson('{"title":"t","steps":["s"]}', '9007199254740993')).mockResolvedValueOnce(okJson('{"title":"t","steps":["s"]}', 'abc')).mockResolvedValueOnce(okJson('   ')).mockResolvedValueOnce(okJson('leak sk-secret-token-xyz', '10')).mockResolvedValueOnce(truncJson);
  for (const [id, expected] of [['id1', { reply: null, actualUsdMicros: null, servedModel: null }], ['id2', { reply: null, actualUsdMicros: null, servedModel: null }], ['id3', { reply: null }], ['id4', { reply: null, actualUsdMicros: 10 }], ['id5', { reply: null, actualUsdMicros: 12 }]] as const)
    expect(await sampleWorker(provider, tariff, id, 'sys', 'in', AbortSignal.timeout(5000))).toMatchObject(expected);
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect([totalWorkerCost([-1]), totalWorkerCost([Number.MAX_SAFE_INTEGER, 1])]).toEqual([null, null]);
  await expect(generateResearchDraft('heavy_tutor_prep', '{}', async () => 'null')).rejects.toThrow();
  const call = vi.fn(async () => JSON.stringify({ title: '', question: '1+1=?', answer: 2 }));
  await expect(generateResearchDraft('question_author', '{}', call)).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(1);
});
