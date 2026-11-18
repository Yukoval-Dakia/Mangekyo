type Completion = { id?: unknown; model?: unknown } & ({ truncated: true } | { content?: string });
type ProviderHooks = {
  model?: (model: unknown) => void;
  content?: (text: string) => Promise<void>;
};

const maximumFrame = 512_000;
const maximumContent = 64_000;

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
    const value: unknown = await response.text().then((text) => {
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
    if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error('Unusable completion');
    const message = choice?.message;
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
    if (choice.finish_reason && choice.finish_reason !== 'stop') throw new Error('Unusable completion');
    const delta = choice.delta;
    if (delta?.tool_calls || delta?.function_call || (delta?.role && delta.role !== 'assistant')) {
      throw new Error('Unexpected completion channel');
    }
    if (typeof delta?.content === 'string' && delta.content.length) {
      if (stopped) throw new Error('Content after completion');
      output += delta.content;
      if (output.length > maximumContent) throw new Error('Completion content too large');
    }
    if (choice.finish_reason === 'stop') stopped = true;
    // Reasoning fields and provider metadata never enter the visible content.
    if (typeof delta?.content === 'string' || chunk.model) await hooks.content?.(output);
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
