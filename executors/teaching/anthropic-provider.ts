import {readBoundedText} from './bounded-response.ts';
import { TeachingError } from './provider.ts';
import {
  type CompletionUsage,
  readSseData,
  type Completion,
  type FunctionCall,
  type ProviderHooks,
  type ProviderTurn,
} from './provider-stream.ts';

const anthropicVersion = '2023-06-01';
const providerTimeoutMs = 180_000;
const maximumContent = 64_000;
const maximumArguments = 16_000;
const maximumToolCalls = 8;
const maximumBlocks = 24;
const effortLevels = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const replayableBlocks = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);

type AnthropicResult = Completion | { rejectedHttpStatus: number };
type AnthropicBlock = Record<string, unknown>;
type MessageBlock = { role: 'user' | 'assistant'; content: AnthropicBlock[] };
type StreamBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; initial: Record<string, unknown>; json: string; complete: boolean }
  | { type: 'raw'; block: AnthropicBlock }
  | { type: 'ignored' };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('Invalid tool arguments');
  if (!value.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid tool arguments');
  }
  const input = record(parsed);
  if (!input) throw new Error('Invalid tool arguments');
  return input;
}

function messageText(value: unknown): string {
  if (typeof value !== 'string' || !value.length) {
    throw new TeachingError('provider_configuration', '教学模型消息内容无效。');
  }
  return value;
}

/**
 * Translate the executor's OpenAI-shaped request into the native Messages API.
 * Tool calls become tool_use blocks and tool outputs become tool_result blocks,
 * which is the shape Anthropic requires for each later tool round.
 */
export function anthropicRequestBody(value: unknown): Record<string, unknown> {
  const body = record(value);
  if (!body) throw new TeachingError('provider_configuration', '教学模型请求格式无效。');
  const model = body.model;
  if (typeof model !== 'string' || !model) {
    throw new TeachingError('provider_configuration', '教学模型请求缺少模型名称。');
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (!Number.isInteger(maxTokens) || (maxTokens as number) <= 0 || (maxTokens as number) > 1_000_000) {
    throw new TeachingError('provider_configuration', '教学模型请求缺少有效的生成上限。');
  }
  if (!Array.isArray(body.messages)) {
    throw new TeachingError('provider_configuration', '教学模型请求缺少消息。');
  }

  const system: string[] = [];
  const messages: MessageBlock[] = [];
  const push = (role: MessageBlock['role'], blocks: AnthropicBlock[]) => {
    if (!blocks.length) throw new TeachingError('provider_configuration', '教学模型消息内容为空。');
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };

  for (const item of body.messages) {
    const message = record(item);
    if (!message) throw new TeachingError('provider_configuration', '教学模型消息格式无效。');
    if (message.role === 'system') {
      if (typeof message.content !== 'string') {
        throw new TeachingError('provider_configuration', '教学模型系统消息格式无效。');
      }
      system.push(message.content);
      continue;
    }
    if (message.role === 'user') {
      push('user', [{ type: 'text', text: messageText(message.content) }]);
      continue;
    }
    if (message.role === 'assistant') {
      const providerTurn = record(message.providerTurn);
      if (providerTurn) {
        if (providerTurn.protocol !== 'anthropic' || !Array.isArray(providerTurn.content) ||
            providerTurn.content.length === 0 || providerTurn.content.length > maximumBlocks) {
          throw new TeachingError('provider_configuration', '教学模型助手原始内容无效。');
        }
        const raw = providerTurn.content.map(record);
        const rawCalls = raw.filter((block): block is Record<string, unknown> => block?.type === 'tool_use');
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (raw.some(block => !block || typeof block.type !== 'string' || !replayableBlocks.has(block.type)) ||
            rawCalls.length !== calls.length ||
            rawCalls.some((block, position) => block.id !== record(calls[position])?.id)) {
          throw new TeachingError('provider_configuration', '教学模型原始内容与工具调用不一致。');
        }
        push('assistant', raw as AnthropicBlock[]);
        continue;
      }
      const blocks: AnthropicBlock[] = [];
      if (typeof message.content === 'string' && message.content.length) {
        blocks.push({ type: 'text', text: message.content });
      } else if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') {
        throw new TeachingError('provider_configuration', '教学模型助手消息格式无效。');
      }
      if (Array.isArray(message.tool_calls)) {
        for (const item of message.tool_calls) {
          const call = record(item);
          const fn = record(call?.function);
          const id = call?.id;
          const name = fn?.name;
          if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id) ||
              typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) {
            throw new TeachingError('provider_configuration', '教学模型工具调用格式无效。');
          }
          let input: Record<string, unknown>;
          try {
            input = toolArguments(fn?.arguments);
          } catch {
            throw new TeachingError('provider_configuration', '工具调用参数必须是 JSON 对象。');
          }
          blocks.push({ type: 'tool_use', id, name, input });
        }
      }
      push('assistant', blocks);
      continue;
    }
    if (message.role === 'tool') {
      const id = message.tool_call_id;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) {
        throw new TeachingError('provider_configuration', '教学模型工具结果缺少调用标识。');
      }
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      const image = record(message.image);
      const content = image?.mediaType === 'image/png' && typeof image.data === 'string' ? [
        {type:'text', text}, {type:'image', source:{type:'base64', media_type:image.mediaType, data:image.data}},
      ] : text;
      push('user', [{ type: 'tool_result', tool_use_id: id, content }]);
      continue;
    }
    throw new TeachingError('provider_configuration', '教学模型消息角色无效。');
  }

  const request: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: body.stream === false ? false : true,
  };
  if (system.length) request.system = system.join('\n\n');
  if (Array.isArray(body.tools) && body.tools.length) {
    request.tools = body.tools.map((item) => {
      const tool = record(item);
      const fn = record(tool?.function);
      const name = fn?.name;
      if (!fn || typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) {
        throw new TeachingError('provider_configuration', '教学模型工具定义无效。');
      }
      return {
        name,
        ...(typeof fn.description === 'string' && fn.description ? { description: fn.description } : {}),
        input_schema: record(fn.parameters) ?? { type: 'object', properties: {} },
      };
    });
  }
  const effort = body.reasoning_effort;
  if (effort !== undefined && effort !== 'default') {
    if (typeof effort !== 'string' || !effortLevels.has(effort)) {
      throw new TeachingError('provider_configuration', '该教学模型不支持所选思考强度。');
    }
    request.output_config = { effort };
  }
  return request;
}

function readAnthropicMessage(value: unknown, hooks: ProviderHooks): Completion {
  const message = record(value);
  if (!message || (message.type !== undefined && message.type !== 'message')) {
    const failure = record(message?.error);
    throw new Error(typeof failure?.message === 'string' ? failure.message : 'Invalid completion');
  }
  const model = message.model;
  if (model !== undefined && model !== null) hooks.model?.(model);
  if (!Array.isArray(message.content) || message.content.length > maximumBlocks) throw new Error('Invalid completion');
  const rawUsage = record(message.usage);
  const usage = anthropicUsage(rawUsage?.input_tokens, rawUsage?.output_tokens);
  const stop = message.stop_reason;
  if (stop === 'max_tokens') return { id: message.id, model, truncated: true, ...(usage ? { usage } : {}) };

  let content = '';
  const calls: FunctionCall[] = [];
  for (const item of message.content) {
    const block = record(item);
    if (block?.type === 'text' && typeof block.text === 'string') {
      content += block.text;
      if (content.length > maximumContent) throw new Error('Completion content too large');
    } else if (block?.type === 'tool_use') {
      if (!hooks.allowTools) throw new Error('Unexpected completion channel');
      const id = block.id;
      const name = block.name;
      const input = record(block.input);
      if (!input || JSON.stringify(input).length > maximumArguments) throw new Error('Invalid tool input');
      if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id) ||
          typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) {
        throw new Error('Incomplete tool call');
      }
      calls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } });
      if (calls.length > maximumToolCalls) throw new Error('Too many tool calls');
    } else if (block?.type !== 'thinking' && block?.type !== 'redacted_thinking') {
      throw new Error('Unexpected completion channel');
    }
  }

  if (stop === 'tool_use') {
    if (!hooks.allowTools || !calls.length) throw new Error('Incomplete tool call');
    if (new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('Incomplete tool calls');
    return {
      id: message.id,
      model,
      toolCalls: calls,
      providerTurn: { protocol: 'anthropic', content: message.content as unknown[] },
      ...(usage ? { usage } : {}),
    };
  }
  if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'refusal') {
    if (calls.length) throw new Error('Incomplete tool call');
    return {
      id: message.id,
      model,
      content,
      providerTurn: { protocol: 'anthropic', content: message.content as unknown[] },
      ...(usage ? { usage } : {}),
    };
  }
  throw new Error('Unusable completion');
}

function tokenCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value) || value < 0)
    throw new Error('Invalid completion usage');
  return value;
}

function anthropicUsage(input: unknown, output: unknown): CompletionUsage | undefined {
  const prompt_tokens = tokenCount(input);
  const completion_tokens = tokenCount(output);
  if (prompt_tokens === undefined && completion_tokens === undefined) return undefined;
  return {
    ...(prompt_tokens === undefined ? {} : { prompt_tokens }),
    ...(completion_tokens === undefined ? {} : { completion_tokens }),
    ...(prompt_tokens === undefined || completion_tokens === undefined ? {} : { total_tokens: prompt_tokens + completion_tokens }),
  };
}

function blockIndex(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= maximumBlocks) {
    throw new Error('Invalid content block');
  }
  return value as number;
}

export async function readAnthropicCompletion(response: Response, hooks: ProviderHooks): Promise<Completion> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream') {
    const text = await readBoundedText(response, 2 * 1024 * 1024);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('Invalid completion');
    }
    return readAnthropicMessage(value, hooks);
  }

  let content = '';
  let model: unknown;
  let id: unknown;
  let finished = false;
  let stopReason: string | undefined;
  let truncated = false;
  let usage: CompletionUsage | undefined;
  let sawToolBlock = false;
  const calls: FunctionCall[] = [];
  const blocks: (StreamBlock | undefined)[] = [];
  const rawContent: AnthropicBlock[] = [];

  const appendText = async (text: string) => {
    if (!text) return;
    content += text;
    if (content.length > maximumContent) throw new Error('Completion content too large');
    // Thinking and tool blocks are private; never relay text from inside them.
    if (!sawToolBlock) await hooks.content?.(content);
  };

  let received = 0;
  await readSseData(response, async (payload) => {
    received += payload.length;
    if (received > 2 * 1024 * 1024) throw new Error('Completion stream too large');
    if (payload === '[DONE]') {
      finished = true;
      return true;
    }
    const event = record(JSON.parse(payload));
    if (!event || typeof event.type !== 'string') throw new Error('Invalid completion event');
    switch (event.type) {
      case 'message_start': {
        const message = record(event.message);
        if (!message) throw new Error('Invalid completion event');
        if (message.model !== undefined && message.model !== null) {
          hooks.model?.(message.model);
          model = message.model;
        }
        id ??= message.id;
        const rawUsage = record(message.usage);
        usage = anthropicUsage(rawUsage?.input_tokens, undefined) ?? usage;
        return false;
      }
      case 'content_block_start': {
        const index = blockIndex(event.index);
        const block = record(event.content_block);
        if (!block || blocks[index]) throw new Error('Invalid content block');
        if (block.type === 'text') {
          const text = typeof block.text === 'string' ? block.text : '';
          blocks[index] = { type: 'text', text };
          rawContent[index] = { ...block, text };
          await appendText(text);
        } else if (block.type === 'tool_use') {
          if (!hooks.allowTools) throw new Error('Unexpected completion channel');
          const callId = block.id;
          const name = block.name;
          const initial = block.input === undefined ? {} : record(block.input);
          if (!initial || JSON.stringify(initial).length > maximumArguments) throw new Error('Invalid tool input');
          if (typeof callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(callId) ||
              typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(name) || !initial) {
            throw new Error('Incomplete tool call');
          }
          blocks[index] = { type: 'tool_use', id: callId, name, initial, json: '', complete: false };
          rawContent[index] = { ...block, input: initial };
          sawToolBlock = true;
        } else if (block.type === 'thinking') {
          const thinking = typeof block.thinking === 'string' ? block.thinking : '';
          blocks[index] = { type: 'thinking', thinking, signature: '' };
          rawContent[index] = { ...block, thinking };
        } else if (block.type === 'redacted_thinking') {
          blocks[index] = { type: 'raw', block };
          rawContent[index] = block;
        } else {
          throw new Error('Unsupported completion block');
        }
        return false;
      }
      case 'content_block_delta': {
        const block = blocks[blockIndex(event.index)];
        const delta = record(event.delta);
        if (!block || !delta || typeof delta.type !== 'string') throw new Error('Invalid completion event');
        if (delta.type === 'text_delta') {
          if (block.type !== 'text' || typeof delta.text !== 'string') throw new Error('Invalid completion event');
          block.text += delta.text;
          rawContent[event.index as number] = { ...rawContent[event.index as number]!, text: block.text };
          await appendText(delta.text);
        } else if (delta.type === 'input_json_delta') {
          if (block.type !== 'tool_use' || block.complete || typeof delta.partial_json !== 'string') {
            throw new Error('Invalid completion event');
          }
          block.json += delta.partial_json;
          if (block.json.length > maximumArguments) throw new Error('Tool call too large');
        } else if (delta.type === 'thinking_delta') {
          if (block.type !== 'thinking' || typeof delta.thinking !== 'string') throw new Error('Invalid completion event');
          block.thinking += delta.thinking;
          rawContent[event.index as number] = {
            ...rawContent[event.index as number]!, thinking: block.thinking,
          };
        } else if (delta.type === 'signature_delta') {
          if (block.type !== 'thinking' || typeof delta.signature !== 'string') throw new Error('Invalid completion event');
          block.signature = delta.signature;
          rawContent[event.index as number] = {
            ...rawContent[event.index as number]!, signature: block.signature,
          };
        } else if (delta.type === 'citations_delta') {
          if (block.type !== 'text') throw new Error('Invalid completion event');
          const raw = rawContent[event.index as number]!;
          const citations = Array.isArray(raw.citations) ? raw.citations : [];
          rawContent[event.index as number] = { ...raw, citations: [...citations, delta.citation] };
        } else {
          throw new Error('Unsupported completion delta');
        }
        return false;
      }
      case 'content_block_stop': {
        const block = blocks[blockIndex(event.index)];
        if (!block) throw new Error('Invalid completion event');
        if (block.type === 'tool_use') {
          if (block.complete) throw new Error('Invalid completion event');
          block.complete = true;
          const input = block.json.trim() ? toolArguments(block.json) : block.initial;
          rawContent[event.index as number] = { ...rawContent[event.index as number]!, input };
          if (calls.length >= maximumToolCalls) throw new Error('Too many tool calls');
          calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(input) } });
        }
        return false;
      }
      case 'message_delta': {
        const delta = record(event.delta);
        if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason;
        const rawUsage = record(event.usage);
        const previous = usage ?? {};
        const output = tokenCount(rawUsage?.output_tokens);
        usage = anthropicUsage(previous.prompt_tokens, output);
        if (stopReason === 'max_tokens') truncated = true;
        return false;
      }
      case 'message_stop':
        finished = true;
        return true;
      case 'error': {
        const failure = record(event.error);
        throw new Error(typeof failure?.message === 'string' ? failure.message : 'Provider stream failed');
      }
      default:
        // ping and event types newer than this client carry no decision data.
        return false;
    }
  });

  if (!finished) throw new Error('Incomplete completion stream');
  if (truncated) return { id, model, truncated: true, ...(usage ? { usage } : {}) };
  if (!stopReason) throw new Error('Incomplete completion stream');
  if (blocks.some(block => block?.type === 'tool_use' && !block.complete)) throw new Error('Incomplete tool call');
  const providerContent = rawContent.filter((block): block is AnthropicBlock => block !== undefined);
  if (stopReason === 'tool_use') {
    if (!hooks.allowTools || !calls.length) throw new Error('Incomplete tool call');
    if (new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('Incomplete tool calls');
    return {
      id,
      model,
      toolCalls: calls,
      providerTurn: { protocol: 'anthropic', content: providerContent as unknown[] },
      ...(usage ? { usage } : {}),
    };
  }
  if (calls.length) throw new Error('Incomplete tool call');
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence' || stopReason === 'refusal') {
    return {
      id,
      model,
      content,
      providerTurn: { protocol: 'anthropic', content: providerContent as unknown[] },
      ...(usage ? { usage } : {}),
    };
  }
  throw new Error('Unusable completion');
}

export async function requestAnthropicCompletion(
  endpoint: string,
  body: string,
  apiKey: string | undefined,
  clientRequestId: string,
  hooks: ProviderHooks,
): Promise<AnthropicResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TeachingError('provider_configuration', '教学模型请求格式无效。');
  }
  const requestBody = anthropicRequestBody(parsed);
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
    'anthropic-version': anthropicVersion,
    'x-client-request-id': clientRequestId,
  });
  if (apiKey) headers.set('x-api-key', apiKey);
  const signal = AbortSignal.timeout(providerTimeoutMs);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal,
      redirect: 'error',
    });
  } catch {
    if (signal.aborted) throw new TeachingError('provider_timeout', '等待教学模型超时。');
    throw new TeachingError('provider_unavailable', '暂时无法连接教学模型。');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if ([400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status)) {
      return { rejectedHttpStatus: response.status };
    }
    throw new TeachingError('provider_unavailable', `教学模型服务返回 HTTP ${response.status}。`);
  }
  try {
    return await readAnthropicCompletion(response, hooks);
  } catch (error) {
    if (signal.aborted) throw new TeachingError('provider_timeout', '等待教学模型超时。');
    if (error instanceof TeachingError) throw error;
    throw new TeachingError('provider_response', '教学模型的响应未完整收到或格式无效。');
  }
}
