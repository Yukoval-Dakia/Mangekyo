import {createHash} from 'node:crypto';
import {pythonCodeError, runCalculation, type CalculationInput} from './agent-tools.ts';
import type {TeachingDependencies} from './index.ts';
import {
  formatLearningResult, hostedReads, hostedWrites, onDemandTools, saveBeliefDefinition, settledToolBatch, toolFailure,
  type HostedTool, type LearningError, type LearningTools, type ResultHandle, type ToolArgs,
} from './learning-tools.ts';
import type {FunctionCall} from './provider-stream.ts';
import {pythonReads, runCalculationDefinition} from './python-sdk.ts';
import {findTools} from './study-tool-discovery.ts';
import {openToolResult, type studyToolResults} from './study-tool-results.ts';
import type {StudyImage} from './workspace-tools.ts';

export function learningArguments(raw: string): ToolArgs | undefined {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* The model gets a parameter error. */ }
  return undefined;
}

const schemaLookup = (name: string) => ({tool: 'find_tools', args: {query: name}});
const readNames = new Set<string>([...hostedReads, 'find_tools']);
const writeNames = new Set<string>([...hostedWrites, ...onDemandTools, 'mount_artifact']);

export function createLearningTurn(host: LearningTools, results: ReturnType<typeof studyToolResults>,
  runEffect: TeachingDependencies['runEffect'], model: string) {
  // Core definitions are stable for a turn. Only authorized owner bindings enter discovery.
  const definitions = {...host.definitions, save_belief: saveBeliefDefinition};
  const resident = [...hostedReads.map(name => definitions[name]), findTools,
    ...hostedWrites.map(name => definitions[name]), runCalculationDefinition];
  const onDemand = [...onDemandTools, 'mount_artifact' as const].flatMap(name => definitions[name] ?? []);
  const hostedNames = new Set<string>([...hostedReads, ...hostedWrites, ...onDemand.map(tool => tool.function.name)]);

  function failure(error: LearningError) {
    return {content: formatLearningResult(error)};
  }
  function badArgs(name: string, message: string) {
    return failure(toolFailure('invalid_args', message, schemaLookup(name)));
  }
  async function handlesFor(refs: unknown, name: string, step: number):
    Promise<{ok: true; handles: Record<string, ResultHandle>} | LearningError> {
    if (!Array.isArray(refs) || refs.length > 8 || refs.some(ref => typeof ref !== 'string')) {
      return toolFailure('invalid_args', '请传最多 8 个本轮工具结果句柄。', schemaLookup(name));
    }
    const handles: Record<string, ResultHandle> = {};
    for (const ref of refs) {
      const entry = results.handle(ref);
      if (!entry) return toolFailure('not_found', '请使用本轮已返回的结果句柄。', schemaLookup(name));
      handles[ref] = entry;
    }
    const steps = [...new Set(Object.values(handles).map(entry => entry.step))];
    if (steps.length) {
      const access = await host.authorizeHandles(steps, step);
      if (!access.ok) return access;
    }
    return {ok: true, handles};
  }

  async function calculate(args: ToolArgs, step: number) {
    const name = runCalculationDefinition.function.name;
    if (Object.keys(args).some(key => !['code', 'inputs', 'reads'].includes(key))) {
      return badArgs(name, '计算仅接受 code、inputs 和 reads。');
    }
    const code = args.code;
    const invalidCode = pythonCodeError(code);
    if (invalidCode || typeof code !== 'string') return failure(toolFailure(
      invalidCode?.code === 'budget_or_limit' ? 'limit_exceeded' : 'invalid_args',
      invalidCode?.message ?? '请输入 Python 代码。', schemaLookup(name), 'code'));
    const reads = pythonReads(args.reads);
    if (!reads) return badArgs(name, '请按工具参数定义声明最多 8 个只读查询。');
    const input = await handlesFor(args.inputs === undefined ? [] : args.inputs, name, step);
    if (!input.ok) return failure(input);
    const selection = await host.preparePython(reads, step);
    if (!selection.ok) return failure(selection);
    if (selection.values.length !== reads.length) throw new Error('Python read projection count differs from request');
    const sdk = reads.map((read, i) => ({...read, value: selection.values[i]}));
    const values = Object.fromEntries(Object.entries(input.handles).map(([ref, entry]): [string, CalculationInput] =>
      [ref, entry.mediaType ? {value:entry.value, mediaType:entry.mediaType} : entry.value]));
    const requestDigest = createHash('sha256').update(JSON.stringify({code, values, sdk})).digest('hex');
    const raw = await runEffect({index:step, model, provider:'tool:run_calculation', requestDigest},
      async () => JSON.stringify(await runCalculation(code, values, sdk)));
    const result: Awaited<ReturnType<typeof runCalculation>> = JSON.parse(raw);
    if (!result.ok) {
      const code = result.code === 'budget_or_limit' ? 'limit_exceeded'
        : result.code === 'tool_unavailable' ? 'not_found' : 'invalid_args';
      return failure(toolFailure(code, result.message, schemaLookup(name), result.field));
    }
    return results.publishLearning(name, step,
      formatLearningResult({ok:true, data:{text:result.text}, ...(selection.warnings && {warnings:selection.warnings})}),
      result.artifacts);
  }

  async function execute(name: string, args: ToolArgs, step: number, priorRead: Promise<unknown>) {
    if (name === runCalculationDefinition.function.name) return calculate(args, step);
    if (name === openToolResult.function.name) {
      if (Object.keys(args).some(key => key !== 'handle' && key !== 'start') || typeof args.handle !== 'string')
        return badArgs(name, '请传本轮的结果句柄及可选起始位置。');
      const access = await handlesFor([args.handle], name, step);
      if (!access.ok) return failure(access);
      const entry = access.handles[args.handle]!;
      if (entry.mediaType) return args.start === undefined
        ? {content: formatLearningResult({ok:true,data:{handle:args.handle}}),
          image:{mediaType:entry.mediaType, data:entry.value}}
        : badArgs(name, '图像句柄不接受分页位置。');
      const result = results.open(args);
      const body = JSON.parse(result.content);
      return body.ok === false ? badArgs(name, body.message) : result;
    }
    if (!hostedNames.has(name)) return undefined;
    const refs = name === 'save_page'
      ? [...(Array.isArray(args.insert_artifacts) ? args.insert_artifacts : []),
        ...(Array.isArray(args.patch) ? args.patch.flatMap(item =>
          item && typeof item === 'object' && Object.hasOwn(item, 'artifact') ? [item.artifact] : []) : [])]
      : [];
    const access = await handlesFor(refs, name, step);
    if (!access.ok) return failure(access);
    let image: StudyImage | undefined;
    const value = await host.execute(name as HostedTool, args, {
      step, handles:access.handles, priorRead,
      receiveImage(received) { image = received; },
    });
    const output = formatLearningResult(value);
    if (!value.ok) return {content:output};
    return {...results.publishLearning(name, step, output, []), ...(image && {image})};
  }

  return {resident, discoverable: [...onDemand, openToolResult], execute, badArgs};
}

/** A batch preserves read/write order across groups. Only disjoint canonical writes
 * with known targets can overlap. Their final authorization remains with the host.
 */
export async function runLearningBatch<T>(host: LearningTools, calls: readonly FunctionCall[],
  available: ReadonlySet<string>, execute: (call: FunctionCall, index: number, priorRead?: Promise<unknown>) => Promise<T>,
  append: (call: FunctionCall, result: T) => void) {
  const writeKeys = calls.map(call => {
    const name = call.function.name;
    const args = learningArguments(call.function.arguments);
    return args && available.has(name) && writeNames.has(name)
      ? host.writeKeys(name as Parameters<LearningTools['writeKeys']>[0], args) : [];
  });
  for (let start = 0; start < calls.length;) {
    let end = start + 1;
    const reading = readNames.has(calls[start]!.function.name);
    if (reading) {
      while (end < Math.min(start + 4, calls.length) && readNames.has(calls[end]!.function.name)) end++;
    } else if (writeKeys[start]!.length) {
      while (end < calls.length && writeKeys[end]!.length) end++;
    }
    let priorRead: Promise<unknown> = Promise.resolve();
    const tails = new Map<string, Promise<unknown>>();
    const outcomes = await settledToolBatch(calls.slice(start, end).map((call, offset) => () => {
      const index = start + offset;
      if (reading) {
        const previous = priorRead;
        const run = execute(call, index, previous);
        priorRead = Promise.all([previous, run]);
        // The current provider round reports the original error after every reader settles.
        void priorRead.catch(() => {});
        return run;
      }
      const keys = writeKeys[index]!;
      if (!keys.length) return execute(call, index);
      const run = Promise.all(keys.map(key => tails.get(key))).then(() => execute(call, index));
      for (const key of keys) tails.set(key, run);
      return run;
    }));
    for (const [offset, result] of outcomes.entries()) append(calls[start + offset]!, result);
    start = end;
  }
}

export function learningRecovery() {
  const offered = new Map<string, string>();
  const state = new Map<string, 'offered' | 'recovering' | 'retry' | 'finished'>();
  function key(tool: string, args: unknown): string {
    return JSON.stringify([tool, args], (_, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  }
  return {
    async run<T extends {content: string; summary: string}>(call: FunctionCall, invoke: () => Promise<T>) {
      const name = call.function.name;
      const id = key(name, learningArguments(call.function.arguments) ?? call.function.arguments);
      const chain = offered.get(id);
      const current = state.get(id);
      const recovery = chain && state.get(chain) === 'offered';
      const retry = !recovery && current === 'retry';
      if ((!recovery && chain && state.has(chain)) || (!recovery && !retry && current)) {
        return {content: JSON.stringify({...toolFailure('limit_exceeded', '本次恢复机会已用完，请说明仍缺少的依据。', schemaLookup(name)),
          recovery_exhausted:true}), summary: '工具恢复已用完'};
      }
      if (recovery) state.set(chain, 'recovering');
      if (retry) state.set(id, 'finished');
      const result = await invoke();
      let payload: LearningError | undefined;
      try { payload = JSON.parse(result.content); } catch { /* Plain text is a successful result. */ }
      if (payload?.ok === false && payload.next) {
        const target = key(payload.next.tool, payload.next.args);
        const root = recovery ? chain : id;
        offered.set(target, root);
        state.set(root, recovery || retry ? 'finished' : 'offered');
      } else if (recovery && chain !== id) {
        // A successful prerequisite (for example open_learning) allows retrying the original write.
        offered.delete(id);
        state.set(chain, 'retry');
      } else if (recovery || retry) {
        offered.delete(id);
        state.delete(id);
      }
      return result;
    },
  };
}
