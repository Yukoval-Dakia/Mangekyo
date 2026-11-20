import {createHash} from 'node:crypto';

export const openToolResult = { type: 'function', function: {
  name: 'open_tool_result', description: '按本轮句柄读取工具原始结果的一段。Python 可将同一句柄放入 inputs 直接验算。',
  parameters: { type: 'object', properties: { handle: {type:'string'}, start: {type:'integer', minimum:0} },
    required: ['handle'], additionalProperties: false },
} };

const error = (code: string, field: string, message: string) => JSON.stringify({ok:false, code, field, message});
const missingHandle = () => error('not_found', 'handle', '请使用本轮工具结果中提供的句柄。');

function splitsCharacter(text: string, offset: number) {
  const left = text.charCodeAt(offset - 1);
  const right = text.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

function withReferences(output: string, references: Record<string, unknown>) {
  if (output.startsWith('{')) {
    try {
      return JSON.stringify({...JSON.parse(output), ...references});
    } catch { /* Plain text can also start with a brace. */ }
  }
  return JSON.stringify({text: output, ...references});
}

export function studyToolResults() {
  const values = new Map<string, string>();
  function store(kind: 'res' | 'calc', step: number, value: string) {
    const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
    const handle = `@${kind}_${step.toString(36)}_${digest}`;
    values.set(handle, value);
    return handle;
  }
  return {
    publish(tool: string, step: number, output: string, files: [string, string][]) {
      const artifacts = files.map(([name, value]) => ({name, handle:store('calc', step, value)}));
      const metadata = artifacts.length ? {artifacts} : {};
      const bytes = Buffer.byteLength(output);
      if (bytes <= 800) return {content: artifacts.length ? withReferences(output, metadata) : output};
      const handle = store(tool === 'python' ? 'calc' : 'res', step, output);
      const preview = JSON.stringify({archived:true, tool, handle, bytes, ...metadata});
      if (bytes > 16_000) return {content:preview};
      return {content:bytes > 2048 || artifacts.length ? withReferences(output, {handle, ...metadata}) : output, preview};
    },
    open(args: Record<string, unknown>) {
      const handle = typeof args.handle === 'string' ? args.handle : '';
      const value = values.get(handle);
      if (value === undefined) return {content:missingHandle()};
      const start = args.start ?? 0;
      if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 || start > value.length || splitsCharacter(value, start)) {
        return {content:error('invalid_args', 'start', '请使用返回的下一段位置。')};
      }
      let end = Math.min(start + 2800, value.length);
      if (splitsCharacter(value, end)) end--;
      const preview = JSON.stringify({archived:true, handle, start});
      return {content:JSON.stringify({handle, start, text:value.slice(start, end), ...(end < value.length && {
        next: {tool:openToolResult.function.name, args:{handle, start:end}},
      })}), preview};
    },
    pythonInputs(input: unknown) {
      if (!Array.isArray(input) || input.length > 8 || input.some(handle => typeof handle !== 'string'))
        return {error:error('invalid_args', 'inputs', '请传最多 8 个本轮工具结果句柄。')};
      const entries = input.map((handle: string) => [handle, values.get(handle)] as const);
      if (entries.some(([, value]) => value === undefined)) return {error:missingHandle()};
      return {inputs:Object.fromEntries(entries) as Record<string, string>};
    },
  };
}
