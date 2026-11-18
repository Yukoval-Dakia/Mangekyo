import { expect, it, vi } from 'vitest';
import { anthropicRequestBody, readAnthropicCompletion } from './anthropic-provider.ts';
import { profileFor, requestCompletion, TeachingError, teachingProfile, verifyTeachingModel } from './provider.ts';
import { runTeachingTurn } from './index.ts';

const anthropicProvider = {
  baseUrl: 'https://api.anthropic.test/v1',
  protocol: 'anthropic' as const,
  model: 'claude-sonnet-5',
  reasoningEffort: 'default',
};

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

it('keeps the default DeepSeek profile and selects a custom route truthfully', () => {
  expect(profileFor({baseUrl: 'https://example.test/v1'})).toEqual(teachingProfile);
  expect(profileFor({baseUrl: 'https://example.test/v1', model: 'claude-sonnet-5'})).toEqual({
    model: 'claude-sonnet-5', reasoningEffort: 'default',
  });
  expect(profileFor(anthropicProvider)).toEqual({model: 'claude-sonnet-5', reasoningEffort: 'default'});
  expect(profileFor({...anthropicProvider, reasoningEffort: 'high'}).reasoningEffort).toBe('high');
  expect(verifyTeachingModel('raccoon/sn-deepseek-v4-1-flash-1017', undefined)).toMatch(/deepseek/);
  expect(verifyTeachingModel('claude-sonnet-5-20250929', undefined, 'claude-sonnet-5'))
    .toBe('claude-sonnet-5-20250929');
  expect(() => verifyTeachingModel('vendor-b/m1', undefined, 'vendor-a/m1')).toThrow();
  expect(() => verifyTeachingModel('m1-20251113', undefined, 'm1-20251112')).toThrow();
  expect(() => verifyTeachingModel('gpt-6', undefined, 'claude-sonnet-5'))
    .toThrowError(expect.objectContaining<Partial<TeachingError>>({code: 'provider_response'}));
});

it('rejects a malformed native tool call without executing it as an empty object', async () => {
  const response = Response.json({type: 'message', model: 'test', stop_reason: 'tool_use',
    content: [{type: 'tool_use', id: 'one', name: 'lookup', input: null}]});
  await expect(readAnthropicCompletion(response, {allowTools: true})).rejects.toThrow('Invalid tool input');
});

it('translates tool history and completes multiple native Messages rounds', async () => {
  const requests: {url: string; headers: Headers; body: Record<string, any>}[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({url: String(url), headers: new Headers(init?.headers), body});
    const toolStream = anthropicStream([
      event('content_block_start', {index: 0, content_block: {type: 'thinking', thinking: ''}}),
      event('content_block_delta', {index: 0, delta: {type: 'thinking_delta', thinking: '私有推理'}}),
      event('content_block_stop', {index: 0}),
      event('content_block_start', {
        index: 1, content_block: {type: 'tool_use', id: 'toolu_1', name: 'python', input: {}},
      }),
      event('content_block_delta', {index: 1, delta: {type: 'input_json_delta', partial_json: '{"code":"print'}}),
      event('content_block_delta', {index: 1, delta: {type: 'input_json_delta', partial_json: '(45)"}'}}),
      event('content_block_stop', {index: 1}),
    ], 'tool_use');
    const textStream = anthropicStream([
      event('content_block_start', {index: 0, content_block: {type: 'text', text: ''}}),
      event('content_block_delta', {index: 0, delta: {type: 'text_delta', text: '验算完成。'}}),
      event('content_block_stop', {index: 0}),
    ], 'end_turn');
    return new Response(requests.length === 1 ? toolStream : textStream, {
      headers: {'content-type': 'text/event-stream'},
    });
  });
  try {
    const endpoint = `${anthropicProvider.baseUrl}/messages`;
    const first = await requestCompletion(endpoint, JSON.stringify({
      model: anthropicProvider.model,
      max_completion_tokens: 2048,
      messages: [{role: 'system', content: '系统'}, {role: 'user', content: '算一下'}],
      tools: [{type: 'function', function: {
        name: 'python', description: '验算',
        parameters: {type: 'object', properties: {code: {type: 'string'}}, required: ['code']},
      }}],
    }), 'secret', 'request-1', {allowTools: true}, anthropicProvider);
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

    const second = await requestCompletion(endpoint, JSON.stringify({
      model: anthropicProvider.model,
      max_completion_tokens: 2048,
      messages: [
        {role: 'system', content: '系统'},
        {role: 'user', content: '算一下'},
        {role: 'assistant', content: null, tool_calls: [{
          id: 'toolu_1', type: 'function', function: {name: 'python', arguments: '{"code":"print(45)"}'},
        }], providerTurn: 'providerTurn' in first ? first.providerTurn : undefined},
        {role: 'tool', tool_call_id: 'toolu_1', content: '45'},
      ],
      tools: [{type: 'function', function: {
        name: 'python', description: '验算',
        parameters: {type: 'object', properties: {code: {type: 'string'}}, required: ['code']},
      }}],
    }), 'secret', 'request-2', {allowTools: true}, anthropicProvider);
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
  } finally {
    fetch.mockRestore();
  }
});

it('sends a custom profile through teaching decisions and omits default effort', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'claude-sonnet-5', max_tokens: 2048, stream: true,
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('output_config');
    return Response.json({
      id: 'msg_2', type: 'message', model: 'claude-sonnet-5-20250929', stop_reason: 'end_turn',
      content: [{type: 'text', text: JSON.stringify({
        type: 'teach', action: 'clarifying_question', rationale: '需要确认',
        nextStep: '你指的是移动时间还是总时间？', evidenceIds: [],
      })}],
    });
  });
  try {
    const result = await runTeachingTurn({question: '平均速度？', answer: '45', evidenceCatalog: []}, {
      provider: anthropicProvider,
      readEvidence: async () => undefined,
      runEffect: (step, invoke) => invoke(String(step.index)),
    });
    expect(result.action).toBe('clarifying_question');
    expect(result.reportedModel).toBe('claude-sonnet-5-20250929');
  } finally {
    fetch.mockRestore();
  }
});

it('resumes one confirmed truncated teaching decision with a larger output budget', async () => {
  const budgets: number[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    budgets.push(JSON.parse(String(init?.body)).max_tokens);
    const decision = {type: 'teach', action: 'clarifying_question', rationale: '需要确认', nextStep: '你的第一步是什么？', evidenceIds: []};
    return Response.json({type: 'message', model: anthropicProvider.model,
      stop_reason: budgets.length === 1 ? 'max_tokens' : 'end_turn', content: [{type: 'text', text: JSON.stringify(decision)}]});
  });
  try {
    const result = await runTeachingTurn({question: '平均速度？', answer: '45', evidenceCatalog: []}, {
      provider: anthropicProvider, readEvidence: async () => undefined, runEffect: (step, invoke) => invoke(String(step.index)),
    });
    expect(result.action).toBe('clarifying_question');
    expect(budgets).toEqual([2048, 8192]);
  } finally { fetch.mockRestore(); }
});

it('rejects an OpenAI-shaped body that could silently drop the selected model', () => {
  expect(() => anthropicRequestBody({messages: [], max_completion_tokens: 10}))
    .toThrowError(expect.objectContaining<Partial<TeachingError>>({code: 'provider_configuration'}));
});
