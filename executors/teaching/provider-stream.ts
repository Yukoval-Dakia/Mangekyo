import {readBoundedText} from './bounded-response.ts';
export type FunctionCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
/**
 * A raw assistant turn that must be replayed on the next native-protocol call.
 * Tool-use thinking blocks carry signatures that cannot be reconstructed from
 * function calls alone.
 */
export type ProviderTurn = { protocol: 'anthropic'; content: unknown[] };
export type Completion = { id?: unknown; model?: unknown; providerTurn?: ProviderTurn } &
  ({ truncated: true } | { content?: string; toolCalls?: FunctionCall[] });
export type ProviderHooks = {
  allowTools?: boolean;
  model?: (model: unknown) => void;
  content?: (text: string) => Promise<void>;
};

const maximumFrame = 512_000;
const maximumContent = 64_000;

/**
 * Read the data payload of each server-sent event. Empty comment and non-data
 * fields are ignored; a payload is delivered only when its event is terminated.
 */
export async function readSseData(
  response: Response,
  onData: (payload: string) => boolean | void | Promise<boolean | void>,
  maximum = maximumFrame,
): Promise<void> {
  if (!response.body) throw new Error('Missing completion stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data: string[] = [];
  let dataLength = 0;
  let finished = false;

  async function readLine(line: string) {
    if (line !== '') {
      if (line.startsWith('data:')) {
        const value = line.slice(5).replace(/^ /, '');
        dataLength += value.length;
        if (dataLength > maximum) throw new Error('Completion event too large');
        data.push(value);
      }
      return;
    }
    if (data.length === 0) return;
    const payload = data.join('\n');
    data = [];
    dataLength = 0;
    if ((await onData(payload)) === true) finished = true;
  }

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let start = 0;
      for (let index = 0; index < pending.length && !finished; index++) {
        const character = pending[index];
        if (character !== '\r' && character !== '\n') continue;
        if (character === '\r' && index === pending.length - 1 && !done) break;
        await readLine(pending.slice(start, index));
        if (character === '\r' && pending[index + 1] === '\n') index++;
        start = index + 1;
      }
      pending = pending.slice(start);
      if (pending.length > maximum) throw new Error('Completion line too large');
      if (done) {
        if (pending.trim() || data.length) throw new Error('Incomplete completion event');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function collectCalls(calls: FunctionCall[], chunks: unknown, streamed: boolean) {
  if (!Array.isArray(chunks) || chunks.length > 4) throw new Error('Invalid tool calls');
  chunks.forEach((chunk, position) => {
    const index = streamed ? chunk?.index : position;
    if (!Number.isInteger(index) || index < 0 || index > 3 || (chunk.type && chunk.type !== 'function'))
      throw new Error('Invalid tool call');
    const call = calls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
    for (const part of [chunk.id, chunk.function?.name, chunk.function?.arguments])
      if (part !== undefined && typeof part !== 'string') throw new Error('Invalid tool argument');
    call.id += chunk.id ?? '';
    call.function.name += chunk.function?.name ?? '';
    call.function.arguments += chunk.function?.arguments ?? '';
    if (call.id.length > 200 || call.function.name.length > 80 || call.function.arguments.length > 16_000)
      throw new Error('Tool call too large');
  });
}

function completedCalls(calls: FunctionCall[]): FunctionCall[] {
  if (!calls.length || new Set(calls.map(call => call?.id)).size !== calls.length)
    throw new Error('Incomplete tool calls');
  for (const call of calls)
    if (!call || !/^[\w.:/-]+$/.test(call.id) || !/^\w+$/.test(call.function.name)) throw new Error('Incomplete tool call');
  return calls;
}

type ProviderChunk = {
  id?: unknown;
  model?: unknown;
  error?: unknown;
  choices?: {
    index?: number;
    finish_reason?: string | null;
    delta?: { role?: string; content?: unknown; tool_calls?: unknown; function_call?: unknown };
  }[];
};

export async function readProviderCompletion(response: Response, hooks: ProviderHooks): Promise<Completion> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream') {
    const value: unknown = await readBoundedText(response, 2 * 1024 * 1024).then((text) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    });
    const completion = value as {
      id?: unknown;
      model?: unknown;
      choices?: { finish_reason?: string; message?: { role?: string; content?: unknown; tool_calls?: unknown; function_call?: unknown } }[];
    } | null;
    const choice = Array.isArray(completion?.choices) ? completion.choices[0] : undefined;
    const model = completion?.model;
    if (model !== undefined && model !== null) hooks.model?.(model);
    if (choice?.finish_reason === 'length') return { id: completion?.id, model, truncated: true };
    const message = choice?.message;
    if (hooks.allowTools && choice?.finish_reason === 'tool_calls' && message?.role === 'assistant') {
      const calls: FunctionCall[] = [];
      collectCalls(calls, message.tool_calls, false);
      return { id: completion?.id, model, toolCalls: completedCalls(calls) };
    }
    if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error('Unusable completion');
    if (message?.tool_calls || message?.function_call || (message?.role && message.role !== 'assistant')) {
      throw new Error('Unexpected completion channel');
    }
    const text = message?.content;
    return { id: completion?.id, model, ...(typeof text === 'string' ? { content: text } : {}) };
  }

  if (!response.body) throw new Error('Missing completion stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data: string[] = [];
  let dataLength = 0;
  let output = '';
  let model: unknown;
  let id: unknown;
  let finished = false;
  let stopped = false;
  let truncated = false;
  const calls: FunctionCall[] = [];
  let endedWithTools = false;

  async function readLine(line: string) {
    if (line !== '') {
      if (line.startsWith('data:')) {
        dataLength += line.length;
        if (dataLength > maximumFrame) throw new Error('Completion event too large');
        data.push(line.slice(5).replace(/^ /, ''));
      }
      return;
    }
    if (data.length === 0) return;
    const payload = data.join('\n');
    data = [];
    dataLength = 0;
    if (payload === '[DONE]') {
      finished = true;
      return;
    }
    const chunk: ProviderChunk | null = JSON.parse(payload);
    if (!chunk || typeof chunk !== 'object' || chunk.error) throw new Error('Invalid completion event');
    if (chunk.model !== undefined && chunk.model !== null) {
      hooks.model?.(chunk.model);
      model = chunk.model;
    }
    id ??= chunk.id;
    if (!Array.isArray(chunk.choices)) return;
    const choice = chunk.choices.find((item) => item && (item.index === undefined || item.index === 0));
    if (!choice) return;
    if (choice.finish_reason === 'length') {
      truncated = true;
      finished = true;
      return;
    }
    const toolEnd = hooks.allowTools && choice.finish_reason === 'tool_calls';
    if (choice.finish_reason && choice.finish_reason !== 'stop' && !toolEnd) throw new Error('Unusable completion');
    const delta = choice.delta;
    if ((!hooks.allowTools && delta?.tool_calls) || delta?.function_call || (delta?.role && delta.role !== 'assistant')) {
      throw new Error('Unexpected completion channel');
    }
    if (delta?.tool_calls) {
      if (stopped) throw new Error('Tool call after completion');
      collectCalls(calls, delta.tool_calls, true);
    }
    if (typeof delta?.content === 'string' && delta.content.length) {
      if (stopped) throw new Error('Content after completion');
      output += delta.content;
      if (output.length > maximumContent) throw new Error('Completion content too large');
    }
    if (toolEnd) endedWithTools = true;
    if (toolEnd || choice.finish_reason === 'stop') stopped = true;
    // Reasoning fields and provider metadata never enter the visible content.
    if (!calls.length && (typeof delta?.content === 'string' || chunk.model)) await hooks.content?.(output);
  }

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let start = 0;
      for (let index = 0; index < pending.length && !finished; index++) {
        const character = pending[index];
        if (character !== '\r' && character !== '\n') continue;
        if (character === '\r' && index === pending.length - 1 && !done) break;
        await readLine(pending.slice(start, index));
        if (character === '\r' && pending[index + 1] === '\n') index++;
        start = index + 1;
      }
      pending = pending.slice(start);
      if (pending.length > maximumFrame) throw new Error('Completion line too large');
      if (done) {
        if (pending.trim() || data.length) throw new Error('Incomplete completion event');
        break;
      }
    }
    if (truncated) return { id, model, truncated: true };
    if (!stopped) throw new Error('Incomplete completion stream');
    if (endedWithTools) return { id, model, toolCalls: completedCalls(calls) };
    if (calls.length) throw new Error('Incomplete tool call');
    return { id, model, content: output };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// The gateway separates private channels from assistant content. Some compatible
// routes also use these inline markers. A closing tag alone cannot retroactively
// classify earlier content.
const privateTags = new Set(['think', 'analysis', 'reasoning', 'tool_call', 'tool_calls', 'function_call']);
const tagStart = /<(\/?)([a-z_]+)(?=[\s/>]|$)/gi;

export function publicAssistantContent(raw: string): string {
  let visible = '';
  let offset = 0;
  const hidden: string[] = [];
  for (const mark of raw.matchAll(tagStart)) {
    const name = mark[2]!.toLowerCase();
    if (!privateTags.has(name) || mark.index < offset) continue;
    if (!hidden.length) visible += raw.slice(offset, mark.index);
    const end = tagEnd(raw, mark.index + mark[0].length);
    // Buffer an opening or closing tag while its attributes may still be split
    // across provider deltas, including quoted values containing ">".
    if (end === undefined) return visible;
    if (mark[1]) {
      if (hidden.at(-1) === name) hidden.pop();
    } else if (!/^\s*\/$/.test(raw.slice(mark.index + mark[0].length, end))) {
      hidden.push(name);
    }
    offset = end + 1;
  }
  if (hidden.length) return visible;
  const tail = raw.slice(offset);
  const prefix = /<\/?([a-z_]*)$/i.exec(tail);
  if (prefix && [...privateTags].some(name => name.startsWith(prefix[1]!.toLowerCase()))) {
    return visible + tail.slice(0, prefix.index);
  }
  return visible + tail;
}

function tagEnd(text: string, start: number): number | undefined {
  let quote: string | undefined;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return undefined;
}
