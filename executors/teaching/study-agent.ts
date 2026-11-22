import {artifactMountTrace} from './artifact-trace.ts';
import type {FirstTurnJitContext} from './first-turn-jit.ts';
import {learningToolError} from './tool-error.ts';
import { isPhaticMessage } from './phatic-message.ts';
import { createHash } from 'node:crypto';
import type { TeachingDependencies, TeachingDispatch } from './index.ts';
import { McpTurnConnections, type McpServer } from './mcp-client.ts';
import { loadMcpTools, invokeMcpTool, remoteToolDefinition } from './mcp-tools.ts';
import { findTools, studyToolDiscovery } from './study-tool-discovery.ts';
import type {DeliveredToolRange} from './learning-tools.ts';
import {projectChatImages, projectWorkspaceContext, type ToolResultMessage} from './workspace-context.ts';
import {openToolResult, studyToolResults} from './study-tool-results.ts';
import { memoryToolDefinitions, workspaceDefinitions, type ReceiveStudyImage, type StudyImage, type WorkspaceTools } from './workspace-tools.ts';
import {pythonAttemptSelection} from './python-attempt-selection.ts';
import { createStudyTools, pythonCodeError, type PythonAttemptsRead } from './agent-tools.ts';
import { type CompletionUsage, type FunctionCall, type ProviderTurn, publicAssistantContent } from './provider-stream.ts';
import { checkProviderOutcome, providerEndpoint, providerProtocol, requestCompletion, TeachingError, profileFor, verifyTeachingModel } from './provider.ts';
import {createLearningTurn, learningArguments, learningRecovery, runLearningBatch} from './learning-turn.ts';
import {adaptWorkspaceResult, learningToolFallback, narrowWorkspaceDefinitions, saveBeliefDefinition, toolFailure,
  type LearningTools} from './learning-tools.ts';

type StudyWorkspaceTools = WorkspaceTools & {
  presentationOnly?: true;
  executeRead?: (name: string, args: Record<string, unknown>, step: number, priorRead: Promise<unknown>, receiveImage?: ReceiveStudyImage) => Promise<string>;
  preparePythonAttempts?: (args: Record<string, unknown>, step: number) => Promise<PreparedPythonAttempts>;
};
export type PreparedPythonAttempts = Extract<PythonAttemptsRead, {ok:false}> | (Extract<PythonAttemptsRead, {ok:true}> & {
  witnesses: {id: string; rev: number; epoch: string; type: string}[];
});

export type StudyAgentOptions = Omit<TeachingDependencies, 'readEvidence'> & {
  /** Set only for a persisted turn using the unified learning tool contract. */
  learningTools?: LearningTools;
  /** The Studio turn's persisted choice while only memory has migrated. */
  beliefTools?: boolean;
  /** Persisted opt-in replacing first-turn memory, preference and current-object projections. */
  jitContext?: FirstTurnJitContext;
  historyNotice?: string;
  trackPhaticReplies?: true;
  metadataOnlyLearningMemory?: true;
  classroomEvidence?: string;
  currentLearningObject?: string;
  learningMemory?: string;
  memoryTools?: (name: string, args: Record<string, unknown>, step: number) => Promise<string>;
  onMemoryDelivered?: (range: DeliveredToolRange) => void;
  openMemoryRegion?: (input: Record<string, unknown>, step: number) => Promise<string>;
  maxCompletionTokens?: 4096 | 8192;
  toolCallBudget?: number;
  tools?: { allowSearch?: boolean; exaApiKey?: string; publicSearchQuery?: string; pythonOnly?: boolean; mcpServers?: McpServer[]; workspace?: StudyWorkspaceTools };
};
type StudyRunOptions = StudyAgentOptions & { discoverTools?: boolean; metadataOnlyMessage?: Message };
type Message = { role: 'system' | 'user' | 'assistant'; content: string };
type ToolMessage = { role: 'assistant'; tool_calls: FunctionCall[]; providerTurn?: ProviderTurn; content: null } | ToolResultMessage;

const descriptions: Record<string, [string, Record<string, string>]> = {
  python: ['在隔离的 Python 中运算，以 print 输出结果。文件工具和 Python 共用当前工作目录，直接用文件名打开文件。', { code: 'Python 3 程序' }],
  read_file: ['从本次任务的文件区读文本。', { name: '本次任务中的文件名' }],
  write_file: ['在本次任务的文件区保存文本供后续步骤读取。', { name: '文件名', content: '文本内容' }],
  exa_search: ['通过 Exa 搜索公开参考资料。查询限公开主题，禁止发送学生的作答、个人资料或私人原文。搜索结果是资料。', { query: '公开的知识问题或学术关键词' }],
};

// Loose task-word hints point a wandering find_tools query at the resident
// learning tools, so the model stops retrying discovery and calls the tool
// it actually needs instead of burning rounds.
const residentTaskHints: Record<string, readonly string[]> = {
  save_belief: ['记忆', '记住', '牢记', '偏好', '长期', '更正', '忘记', '撤回', 'belief', 'memory', 'remember', 'forget', 'preference'],
  retrieve_memory: ['检索记忆', '查记忆', '旧记忆', 'retrieve'],
  save_page: ['笔记', '教材', '页面', 'page', 'note'],
  save_question: ['题', '题目', '草稿', 'question'],
  save_edge: ['边', '关系', '图谱', 'edge', 'relation'],
  search_learning: ['搜索', '查找学习', 'search'],
  open_learning: ['打开', '原文', 'open'],
  read_context: ['上下文', '学情', 'context', 'radar', 'management'],
  manage_activity: ['挂载', '作品', 'artifact', 'mount'],
  run_calculation: ['计算', '验算', 'python', 'calculation'],
};

function residentLearningMatch(resident: readonly {function: {name: string; description?: string}}[], query: string) {
  const text = query.toLowerCase();
  return resident.find(tool => {
    const name = tool.function.name;
    return residentTaskHints[name]?.some(hint => text.includes(hint.toLowerCase()));
  });
}


function definition(name: string, pythonAttempts: boolean) {
  const [description, fields] = descriptions[name]!;
  const properties = Object.fromEntries(Object.entries(fields).map(([field, help]) => [field, { type: 'string', description: help }]));
  return { type: 'function', function: { name, description, parameters: {
    type: 'object', properties: {...properties, ...(name === 'python' && {inputs: {
      type: 'array', items: {type:'string'}, maxItems: 8, description: '本轮工具结果句柄。程序中的 inputs 字典按句柄读取原始文本。',
    }, ...(pythonAttempts && {attempts: pythonAttemptSelection})})}, required: Object.keys(fields), additionalProperties: false,
  } } };
}

const defaultToolBudget = 6;
const maxReply = 12_000;
const possibleTagSuffix = /<\/?[a-z/]{0,16}$/i;
const memoryRegionTool = { type: 'function', function: { name: 'open_memory_region',
  description: '按本轮 ContextBundle.omitted 中的 expand 对象展开一个已授权的区域。',
  parameters: { type: 'object', properties: { region: { type: 'string' }, start: { type: 'integer' }, basisDigest: { type: 'string' } },
    required: ['region', 'start', 'basisDigest'], additionalProperties: false } } };
const parallelReadOnlyWorkspaceTools = new Set(['open_learning', 'search_workspace', 'read_workspace', 'read_learner_radar']);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function streamableAssistantText(raw: string): string {
  return publicAssistantContent(raw).trimStart().replace(possibleTagSuffix, '').trimEnd();
}

type ModelReply = {
  message?: string;
  reportedModel?: string;
  usage?: CompletionUsage;
  calls?: FunctionCall[];
  providerTurn?: ProviderTurn;
};

function summarise(call: FunctionCall, args: Record<string, unknown>, output: string) {
  switch (call.function.name) {
    case 'python': return 'Python 验算 · ' + output.slice(0, 360) + '\n程序 · ' + String(args.code ?? '').slice(0, 600);
    case 'exa_search': return 'Exa 检索 · ' + String(args.query).slice(0, 150) + '\n' + output.slice(0, 1400);
    case 'write_file': return '写文件 · ' + String(args.name).slice(0, 96) + ' · ' + output.slice(0, 120);
    case 'read_file': return '读文件 · ' + String(args.name).slice(0, 96) + ' · ' + output.slice(0, 120);
    case 'search_workspace': return '检索学习记录 · ' + String(args.query ?? args.kind ?? '最近记录') + '\n' + output.slice(0, 700);
    case 'read_workspace': return '读取学习原文 · ' + String(args.id) + '\n' + output.slice(0, 900);
    case 'read_learner_radar': return '读取学情雷达';
    case 'open_learning': return '打开学习对象 · ' + String(Array.isArray(args.refs) ? args.refs.length : 1) + ' 项\n' + output.slice(0, 900);
    case 'record_observation': return '记录学情观察 · ' + String(args.title ?? '').slice(0, 160);
    case 'save_page': return '提交教材块变更';
    case 'save_question': return '提交题面草稿';
    case 'save_edge':
    case 'save_relation': return '提交有向知识边\n' + output.slice(0,700);
    case 'retrieve_memory': return '查找已获准的记忆';
    case 'save_memory': return '登记本轮记忆操作';
    case 'mount_artifact': return artifactMountTrace(output);
    // agentVersion 1 legacy replay only; agentVersion 2 turns never offer this name.
    case 'save_workspace': return '保存学习记录 · ' + String(args.title) + '\n' + output.slice(0, 500);
    default: return '工具不可用';
  }
}

/** A turn owns its scratch files. External effects use the same durable journal as model calls. */
export async function runStudyAgent(initial: Message[], options: StudyRunOptions, streamReply = false) {
  const connections = new McpTurnConnections();
  try {
    return await runStudyRounds(initial, options, streamReply, connections);
  } finally {
    await connections.close();
  }
}

async function runStudyRounds(initial: Message[], options: StudyRunOptions, streamReply: boolean, connections: McpTurnConnections) {
  const tools = options.tools && createStudyTools(options.tools);
  const results = studyToolResults();
  const previews = new WeakMap<ToolResultMessage, string>();
  const confirmDelivery = options.learningTools?.onDelivered ?? options.onMemoryDelivered;
  const deliveries = new WeakMap<ToolResultMessage, DeliveredToolRange>();
  const workspace = options.tools?.workspace;
  const { model, reasoningEffort } = profileFor(options.provider);
  const learning = options.learningTools && createLearningTurn(options.learningTools, results, options.runEffect, model);
  const recovery = learning && learningRecovery();
  const maxToolCalls = options.toolCallBudget ?? (workspace || learning ? 12 : defaultToolBudget);
  const stride = workspace || learning ? 16 : 8;
  const anthropic = providerProtocol(options.provider) === 'anthropic';
  const allowParallelCalls = learning || (workspace?.executeRead && !anthropic);
  const pinnedQuery = options.tools?.publicSearchQuery?.trim();
  const remotes = await loadMcpTools(options.tools?.mcpServers ?? [], model, options.runEffect, connections);
  const builtins = tools?.names.map(name => {
    const tool = definition(name, Boolean(workspace?.preparePythonAttempts && !workspace.presentationOnly));
    if (name === 'exa_search' && pinnedQuery) tool.function.description += ' 本轮只会检索学生指定的公开主题：' + pinnedQuery;
    return tool;
  }) ?? [];
  const discovery = learning
    ? studyToolDiscovery(remotes, [...learning.discoverable, ...builtins.filter(tool => tool.function.name === 'exa_search')])
    : tools && options.discoverTools ? studyToolDiscovery(remotes) : undefined;
  const narrowSaves = workspace?.narrowSaves;
  const nativeTools = workspace
    ? [...(workspace.presentationOnly ? [] : narrowSaves ? narrowWorkspaceDefinitions : workspaceDefinitions),
      ...(workspace.presentationTool ? [workspace.presentationTool] : [])]
    : [];
  const memoryDefinitions = options.beliefTools ? [memoryToolDefinitions[0]!, saveBeliefDefinition]
    : narrowSaves ? memoryToolDefinitions.slice(0,1) : memoryToolDefinitions;
  const coreDefinitions = learning?.resident ?? [...builtins, ...nativeTools, ...(tools ? [openToolResult] : []), ...(options.openMemoryRegion ? [memoryRegionTool] : []),
    ...(options.memoryTools ? memoryDefinitions : []),
    ...(discovery ? [findTools] : Array.from(remotes, ([name, remote]) => remoteToolDefinition(name, remote)))];
  const messages: (Message | ToolMessage)[] = [...initial];
  const trace: string[] = [];
  const endpoint = providerEndpoint(options.provider);
  let emptyFindTools = 0;
  for (let round = 0; round <= maxToolCalls; round++) {
    const definitions = discovery ? [...coreDefinitions, ...discovery.takeDefinitions()] : coreDefinitions;
    const available = trace.length < maxToolCalls && definitions.length > 0;
    const context = definitions.length ? projectWorkspaceContext(messages, previews) : messages;
    const body = JSON.stringify({ model, ...(reasoningEffort === 'default' ? {} : {reasoning_effort: reasoningEffort}), stream: true,
      ...(!anthropic ? { stream_options: { include_usage: true } } : {}), max_completion_tokens: options.maxCompletionTokens ?? 4096,
      messages: anthropic ? context : projectChatImages(context),
      ...(available ? { tools: definitions, ...(allowParallelCalls ? {} : { parallel_tool_calls: false }) } : {}) });
    const index = round * stride;
    const raw = await options.runEffect({ index, provider: endpoint, model, requestDigest: hash(JSON.stringify({endpoint, body})),
      ...(options.jitContext ? {jitContext: true} : options.learningMemory ? {learningMemory: true} : {}) }, async (requestId, dispatch) => {
      if (options.jitContext && !dispatch) {
        throw new TeachingError('provider_configuration', '首轮学习资料需要宿主复验后才能发送。');
      }
      let reportedModel: string | undefined;
      let lastText = '';
      let lastPush = 0;
      let emittedDeltaText = '';
      const send = () => requestCompletion(endpoint, body, options.provider.apiKey, requestId, {
        allowTools: available,
        model(value) { reportedModel = verifyTeachingModel(value, options.provider.apiKey, model); },
        async content(text) {
          if (!streamReply || !reportedModel || (!options.onProgress && !options.onTextDelta)) return;
          if (options.onProgress && Date.now() - lastPush >= 80) {
            const message = publicAssistantContent(text).trimStart();
            if (message !== lastText && message.trim() && message.length <= maxReply) {
              lastText = message;
              lastPush = Date.now();
              await options.onProgress({ phase: 'replying', message });
            }
          }
          if (!options.onTextDelta) return;
          const visible = streamableAssistantText(text);
          if (visible.length > maxReply || visible.length <= emittedDeltaText.length ||
              !visible.startsWith(emittedDeltaText)) return;
          const delta = visible.slice(emittedDeltaText.length);
          emittedDeltaText = visible;
          await options.onTextDelta(delta);
        },
      }, options.provider);

      const emitFinalTextDelta = async (message: string, toolCalls?: FunctionCall[]) => {
        if (!streamReply || !options.onTextDelta || toolCalls || message.length <= emittedDeltaText.length ||
            !message.startsWith(emittedDeltaText)) return;
        const delta = message.slice(emittedDeltaText.length);
        emittedDeltaText = message;
        await options.onTextDelta(delta);
      };
      const reply = await (options.jitContext && dispatch ? dispatch(send) : send());
      if ('truncated' in reply) return JSON.stringify({
        ...reply,
        ...(reportedModel ? {reportedModel} : {}),
        ...(reply.usage ? {usage: reply.usage} : {}),
      });
      if ('rejectedHttpStatus' in reply) return JSON.stringify(reply);
      const message = publicAssistantContent(reply.content ?? '').trim();
      // Only exchanges made entirely of recognized greeting and courtesy phrases can
      // exclude answer delivery. Tool, remote and JIT input remains unclassified.
      const phatic = options.trackPhaticReplies && reportedModel && !options.jitContext && !remotes.size && !reply.toolCalls &&
        isPhaticMessage(reply.content ?? '') && context.every(entry => entry.role === 'system' || entry === options.metadataOnlyMessage ||
          ((entry.role === 'user' || entry.role === 'assistant') &&
            typeof entry.content === 'string' && isPhaticMessage(entry.content)));
      await emitFinalTextDelta(message, reply.toolCalls);
      return JSON.stringify({ reportedModel, ...(reply.usage ? {usage: reply.usage} : {}),
        ...(phatic ? {phaticExchangeV1: true} : {}),
        ...(reply.toolCalls ? {calls: reply.toolCalls, ...(reply.providerTurn ? {providerTurn: reply.providerTurn} : {})} : {message}) });
    });
    const reply: ModelReply = JSON.parse(raw);
    checkProviderOutcome(reply);
    if (reply.reportedModel) verifyTeachingModel(reply.reportedModel, options.provider.apiKey, model);
    // Projected previews are new messages. Only acknowledge the original text after the
    // provider accepted this request, before executing any of its returned tool calls.
    if (confirmDelivery) for (const message of context) {
      if (message.role !== 'tool') continue;
      const range = deliveries.get(message);
      if (range) {
        confirmDelivery(range);
        deliveries.delete(message);
      }
    }
    if (!reply.calls) {
      if (!reply.message?.trim() && (options.learningTools?.writes() ?? workspace?.writes())?.length)
        return {message:'已为你完成这次保存。之后可以在「我」页面随时查看、修改或撤回。',
          completion:'receipts_only' as const, trace, ...(reply.reportedModel ? {reportedModel:reply.reportedModel} : {}),
          ...(reply.usage ? {usage: reply.usage} : {})};
      if (!reply.message?.trim() || reply.message.length > maxReply) throw new TeachingError('provider_response', '模型没有返回可用的答复。');
      return { message: reply.message, ...(reply.reportedModel ? { reportedModel: reply.reportedModel } : {}),
        ...(reply.usage ? {usage: reply.usage} : {}), ...(trace.length ? {trace} : {}) };
    }
    if (!available || (!tools && !learning && !options.beliefTools) ||
        !reply.reportedModel || !reply.calls.length || reply.calls.length + trace.length > maxToolCalls)
      throw new TeachingError('evidence_limit', '本轮工具请求缺少模型标识或超过工具预算。');
    const calls = reply.calls;
    const availableNames = new Set(definitions.map(tool => tool.function.name));
    messages.push({ role: 'assistant', tool_calls: calls, ...(reply.providerTurn ? {providerTurn: reply.providerTurn} : {}), content: null });
    async function externalEffect(name: string, args: Record<string, unknown>, step: number,
      execute: (dispatch?: TeachingDispatch) => Promise<unknown>, capture: () => object = () => ({})) {
      const remote = remotes.get(name);
      const raw = await options.runEffect({index:step, model, provider:remote ? 'tool:mcp:' + remote.server.id : 'tool:' + name,
        requestDigest:hash(JSON.stringify({name, args, messages}))}, async (_, dispatch) => {
        if (remote?.stateful && !connections.hasStatefulSession(remote.server))
          return JSON.stringify({lostSession:true});
        const output = await execute(dispatch);
        return JSON.stringify({output, ...capture()});
      });
      const saved = JSON.parse(raw);
      if (saved.lostSession) throw new TeachingError('provider_unavailable', '本轮有状态 MCP 会话已中断，请重新发送，已完成的工具操作不会重复。');
      return saved;
    }
    const executeCall = async (call: FunctionCall, position: number, priorRead?: Promise<unknown>) => {
      const name = call.function.name;
      if (!availableNames.has(name)) {
        if (learning) return {...learning.badArgs(name, '当前请求未开放此工具。'), summary:'工具不可用'};
        if (narrowSaves) return {content:JSON.stringify(toolFailure('not_found','当前请求未开放此工具。',
          learningToolFallback(name),'name')),summary:'工具不可用'};
        if (discovery) return {content: JSON.stringify(learningToolError('tool_unavailable','name','当前请求未开放此工具。',{
          tool:findTools.function.name, args:{query:name}, why:'确认本轮已授权且下一次请求可用的工具。',
        })), summary: '工具不可用'};
        throw new TeachingError('evidence_scope', '模型请求了本轮未开放的工具。');
      }
      await options.onProgress?.({phase: name === 'python' || name === 'run_calculation' ? 'checking' : 'reading'});
      if (learning) {
        const args = learningArguments(call.function.arguments);
        const summary = name === 'run_calculation' ? '完成 Python 计算' : '学习工具 · ' + name;
        if (!args) return {...learning.badArgs(name, '请将工具参数作为 JSON 对象提交。'), summary:'工具参数错误'};
        if (name === findTools.function.name) {
          if (Object.keys(args).length !== 1 || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500)
            return {...learning.badArgs(name, '查询需填写工具名或任务关键词，最多 500 字。'), summary:'查找工具 · 参数错误'};
          const query = args.query.trim();
          const resident = learning.resident.find(tool => tool.function.name === query) ??
            residentLearningMatch(learning.resident, query);
          if (resident) return {content:JSON.stringify({ok:true, data:{tool:resident.function.name, available:true}}), summary:'查找工具'};
          const result = discovery!.find(query);
          try {
            const items = JSON.parse(result.content)?.items;
            if (Array.isArray(items) && items.length === 0) emptyFindTools++;
            else emptyFindTools = 0;
          } catch { emptyFindTools = 0; }
          if (emptyFindTools >= 2) return {content: JSON.stringify(toolFailure('limit_exceeded',
            '本轮工具查找已两次无匹配，请直接使用已开放的常驻工具答复。', learningToolFallback(name))),
            summary:'查找工具 · 已收敛'};
          return result;
        }
        const result = await learning.execute(name, args, index + position + 1, priorRead ?? Promise.resolve());
        if (result) return {...result, summary};
        // Authorized MCP and public search still share the journal and dispatch guard.
        if (name === 'exa_search' && pinnedQuery) args.query = pinnedQuery;
        const remote = remotes.get(name);
        const step = index + position + 1;
        const saved = await externalEffect(name, args, step, dispatch =>
          remote ? invokeMcpTool(remote, args, connections, dispatch) : tools!.execute(name, args));
        let value = saved.output;
        if (typeof value === 'string' && value.startsWith('{')) {
          try { value = JSON.parse(value); } catch { /* Remote content may be plain text. */ }
        }
        if (value?.ok === false) {
          const code = value.code === 'budget_or_limit' ? 'limit_exceeded' : value.code === 'invalid_args' ? 'invalid_args' : 'not_found';
          return {content:JSON.stringify(toolFailure(code, String(value.message ?? '工具未完成。'),
            {tool:'find_tools', args:{query:name}})), summary};
        }
        return {...results.publishLearning(name, step, JSON.stringify({ok:true, data:value}), []), summary};
      }
      let parsed: unknown;
      try { parsed = JSON.parse(call.function.arguments); } catch { /* Send an actionable tool response. */ }
      const args = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
      if (discovery && name === findTools.function.name) {
        const resident = narrowSaves && coreDefinitions.find(tool => tool.function.name === args.query);
        if (resident) return {content:JSON.stringify({ok:true,data:{tool:resident.function.name,available:true,
          parameters:resident.function.parameters}}),summary:'查找工具'};
        return discovery.find(args.query);
      }
      if (name === openToolResult.function.name) return {...results.open(args), summary: '读取工具结果'};
      if (name === 'exa_search' && pinnedQuery) args.query = pinnedQuery;
      const remote = remotes.get(name);
      const workspaceTool = workspace && nativeTools.some(tool => tool.function.name === name);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const message = '请将工具参数作为 JSON 对象提交。';
        const content = JSON.stringify(narrowSaves && name.startsWith('save_')
          ? toolFailure('invalid_args',message,learningToolFallback(name),'args')
          : learningToolError('invalid_args','args',message));
        return {content, summary: name === 'mount_artifact' ? artifactMountTrace(content) : '参数错误 · ' + name};
      }
      const python = name === 'python' && args.inputs !== undefined ? results.pythonInputs(args.inputs) : undefined;
      if (python?.error) return {content: python.error, summary: 'Python 验算 · 输入不可用'};
      const step = index + position + 1;
      let attempts: Extract<PreparedPythonAttempts, {ok:true}> | undefined;
      if (name === 'python' && args.attempts !== undefined) {
        const summary = 'Python 验算 · 作答选择不可用';
        if (!workspace?.preparePythonAttempts || workspace.presentationOnly || !args.attempts || typeof args.attempts !== 'object' || Array.isArray(args.attempts)) {
          return {summary, content:JSON.stringify(learningToolError('invalid_args','attempts','工作区已开放时可选择已提交的作答引用。'))};
        }
        const codeError = pythonCodeError(args.code);
        if (codeError) {
          return {summary, content:JSON.stringify(codeError)};
        }
        const prepared = await workspace.preparePythonAttempts(args.attempts as Record<string, unknown>, step);
        if (!prepared.ok) return {summary, content:JSON.stringify(prepared)};
        attempts = prepared;
      }
      const execute = (dispatch?: TeachingDispatch) => remote ? invokeMcpTool(remote, args, connections, dispatch)
        : tools!.execute(name, args, python?.inputs, attempts?.rows);
      // Scratch writes and reads are rebuilt in order on replay. Paid search and computations reuse their original outputs.
      let output: string;
      let image: StudyImage | undefined;
      const before = name === 'python' ? tools!.snapshotFiles() : {};
      if (name === memoryRegionTool.function.name && options.openMemoryRegion) {
        output = await options.openMemoryRegion(args, step);
      } else if (options.memoryTools && memoryDefinitions.some(tool => tool.function.name === name)) {
        output = await options.memoryTools(name, args, step);
      } else if (workspaceTool) {
        const receiveImage: ReceiveStudyImage | undefined = name === 'open_learning'
          ? value => { image = value; } : undefined;
        output = workspace.executeRead
          ? await workspace.executeRead(name, args, step, priorRead ?? Promise.resolve(), receiveImage)
          : await workspace.execute(name, args, step, receiveImage);
      } else if (name === 'read_file' || name === 'write_file') {
        const value = await execute();
        output = typeof value === 'string' ? value : JSON.stringify(value);
      } else {
        const saved = await externalEffect(name, args, step, execute, () => ({
          ...(name === 'python' ? {files: tools!.snapshotFiles()} : {}),
          ...(attempts ? {attemptBasis: attempts.witnesses} : {}),
        }));
        if (name === 'python') tools!.restoreFiles(saved.files);
        output = typeof saved.output !== 'string' ? JSON.stringify(saved.output) : attempts ? JSON.stringify({text: saved.output,
          sources: attempts.witnesses.map(({id, rev}) => ({id, rev})),
          ...(attempts.issues.length ? {...learningToolError('partial_success','refs','部分作答未打开，详见逐项结果。'), issues:attempts.issues} : {}),
        }) : saved.output;
      }
      if (narrowSaves && (name === 'open_learning' || name === 'save_page' || name === 'save_edge' || name === 'save_belief')) {
        const adapted = adaptWorkspaceResult(output,name,'workspace-v2');
        if (!adapted.ok || adapted.warnings?.length) output = JSON.stringify(adapted);
      }
      const files = name === 'python' ? Object.entries(tools!.snapshotFiles()).filter(([name, value]) => before[name] !== value) : [];
      const result = results.publish(name, step, output, files);
      const summary = name === memoryRegionTool.function.name ? '展开记忆区域' : name === 'save_belief' ? '登记本轮记忆操作' : remote
        ? 'MCP · ' + remote.server.id + ' / ' + remote.tool.name + '\n' + output.slice(0, 600) : summarise(call, args, output);
      return {...result, summary, ...(image && {image})};
    };
    function appendResult(call: FunctionCall, result: {content: string; preview?: string; summary: string; image?: StudyImage; delivery?: DeliveredToolRange}) {
      trace.push(result.summary);
      const message: ToolResultMessage = {role: 'tool', tool_call_id: call.id, content: result.content, ...(result.image && {image:result.image})};
      if (result.delivery) deliveries.set(message, result.delivery);
      if (result.preview) previews.set(message, result.preview);
      messages.push(message);
    }
    if (options.learningTools && recovery) {
      await runLearningBatch(options.learningTools, calls, availableNames,
        (call, position, priorRead) => recovery.run(call, () => executeCall(call, position, priorRead)), appendResult);
      continue;
    }
    for (let position = 0; position < calls.length;) {
      const start = position++;
      const first = calls[start]!;
      if (workspace?.executeRead && parallelReadOnlyWorkspaceTools.has(first.function.name)) {
        while (position < calls.length && parallelReadOnlyWorkspaceTools.has(calls[position]!.function.name)) position++;
      }
      if (position === start + 1) {
        appendResult(first, await executeCall(first, start));
        continue;
      }
      let priorRead: Promise<unknown> = Promise.resolve();
      const results = await Promise.allSettled(calls.slice(start, position).map((call, offset) => {
        const previousRead = priorRead;
        const current = (async () => {
          const result = await executeCall(call, start + offset, previousRead);
          await previousRead;
          return result;
        })();
        priorRead = current;
        return current;
      }));
      for (const [offset, result] of results.entries()) {
        if (result.status === 'rejected') throw result.reason;
        appendResult(calls[start + offset]!, result.value);
      }
    }
  }
  throw new TeachingError('evidence_limit', '本轮工具额度已用完。');
}
