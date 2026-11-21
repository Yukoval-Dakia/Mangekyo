import {learningToolError, type ToolErrorCode} from './tool-error.ts';
import {createHash} from 'node:crypto';
import type {CalculationArtifact} from './agent-tools.ts';
import type {DeliveredToolRange, ResultHandle} from './learning-tools.ts';

export const openToolResult = { type: 'function', function: {
  name: 'open_tool_result', description: '按本轮句柄读取工具原始结果的一段。Python 可将同一句柄放入 inputs 直接验算。',
  parameters: { type: 'object', properties: { handle: {type:'string'}, start: {type:'integer', minimum:0} },
    required: ['handle'], additionalProperties: false },
} };

const error = (code: ToolErrorCode, field: string, message: string) => JSON.stringify(learningToolError(code,field,message));
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
  const values = new Map<string, ResultHandle>();
  function store(kind: 'res' | 'calc', step: number, value: string, mediaType?: 'image/png') {
    const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
    const handle = `@${kind}_${step.toString(36)}_${digest}`;
    values.set(handle, {step, value, ...(mediaType && {mediaType})});
    return handle;
  }
  return {
    publish(tool: string, step: number, output: string, files: [string, string][]): {content: string; preview?: string; delivery?: DeliveredToolRange} {
      const artifacts = files.map(([name, value]) => ({name, handle:store('calc', step, value)}));
      const metadata = artifacts.length ? {artifacts} : {};
      const bytes = Buffer.byteLength(output);
      const delivery = tool === 'retrieve_memory' ? {delivery:{step, output, start:0, end:output.length}} : {};
      if (bytes <= 800) return {content: artifacts.length ? withReferences(output, metadata) : output, ...delivery};
      const handle = store(tool === 'python' ? 'calc' : 'res', step, output);
      const preview = JSON.stringify({archived:true, tool, handle, bytes, ...metadata});
      if (bytes > 16_000) return {content:preview};
      return {content:bytes > 2048 || artifacts.length ? withReferences(output, {handle, ...metadata}) : output, preview, ...delivery};
    },
    publishLearning(tool: string, step: number, output: string, files: readonly CalculationArtifact[], retainHandle = false) {
      const artifacts = files.map(({name, mediaType, value}) => ({
        name, handle: store('calc', step, value, mediaType), ...(mediaType && {mediaType}),
      }));
      const metadata = artifacts.length ? {artifacts} : {};
      if (Buffer.byteLength(output) <= 2048) {
        const references = retainHandle ? {...metadata, handle:store('res', step, output)} : metadata;
        return {content: Object.keys(references).length ? withReferences(output, references) : output,
          ...(tool === 'read_context' && {delivery:{step, output, start:0, end:output.length}})};
      }
      const handle = store(tool === 'run_calculation' ? 'calc' : 'res', step, output);
      const {data, warnings} = JSON.parse(output);
      const {status, ref, rev, undo_token, proposal_id, cursor} = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      const header = {status, ref, rev, undo_token, proposal_id, cursor};
      const head = JSON.stringify(header).length <= 200 ? {head:header} : {};
      const preview = JSON.stringify({ok:true, archived:true, tool, handle, bytes:Buffer.byteLength(output),
        ...head, ...(warnings?.length && {warning_count:warnings.length}), ...metadata});
      return {content:preview, preview};
    },
    handle(handle: string) {
      return values.get(handle);
    },
    open(args: Record<string, unknown>) {
      const handle = typeof args.handle === 'string' ? args.handle : '';
      const entry = values.get(handle);
      if (!entry) return {content:missingHandle()};
      const {value} = entry;
      const start = args.start ?? 0;
      if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 || start > value.length || splitsCharacter(value, start)) {
        return {content:error('invalid_args', 'start', '请使用返回的下一段位置。')};
      }
      let end = Math.min(start + 2800, value.length);
      if (splitsCharacter(value, end)) end--;
      const preview = JSON.stringify({archived:true, handle, start});
      return {content:JSON.stringify({handle, start, text:value.slice(start, end), ...(end < value.length && {
        next: {tool:openToolResult.function.name, args:{handle, start:end}},
      })}), preview, delivery:{step:entry.step, output:value, start, end}};
    },
    pythonInputs(input: unknown) {
      if (!Array.isArray(input) || input.length > 8 || input.some(handle => typeof handle !== 'string'))
        return {error:error('invalid_args', 'inputs', '请传最多 8 个本轮工具结果句柄。')};
      const entries = input.map((handle: string) => [handle, values.get(handle)?.value] as const);
      if (entries.some(([, value]) => value === undefined)) return {error:missingHandle()};
      return {inputs:Object.fromEntries(entries) as Record<string, string>};
    },
  };
}
