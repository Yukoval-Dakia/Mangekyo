import { createHash } from 'node:crypto';
import type { TeachingDependencies } from './index.ts';
import { McpTurnConnections, type McpServer } from './mcp-client.ts';
import { loadMcpTools, invokeMcpTool } from './mcp-tools.ts';
import {projectWorkspaceContext} from './workspace-context.ts';
import { workspaceDefinitions, type WorkspaceTools } from './workspace-tools.ts';
import { createStudyTools } from './agent-tools.ts';
import { type FunctionCall, type ProviderTurn, publicAssistantContent } from './provider-stream.ts';
import { checkProviderOutcome, providerEndpoint, requestCompletion, TeachingError, profileFor, verifyTeachingModel } from './provider.ts';

export type StudyAgentOptions = Omit<TeachingDependencies, 'readEvidence'> & {
  historyNotice?: string;
  learningMemory?: string;
  openMemoryRegion?: (input: Record<string, unknown>, step: number) => Promise<string>;
  maxCompletionTokens?: 4096 | 8192;
  tools?: { allowSearch?: boolean; exaApiKey?: string; publicSearchQuery?: string; mcpServers?: McpServer[]; workspace?: WorkspaceTools };
};
type Message = { role: 'system' | 'user' | 'assistant'; content: string };
type ToolMessage = { role: 'assistant'; tool_calls: FunctionCall[]; providerTurn?: ProviderTurn; content: null } |
  { role: 'tool'; tool_call_id: string; content: string };

const descriptions: Record<string, [string, Record<string, string>]> = {
  python: ['在隔离的 Python 中运算，以 print 输出结果。文件工具和 Python 共用当前工作目录，直接用文件名打开文件。', { code: 'Python 3 程序' }],
  read_file: ['从本次任务的文件区读文本。', { name: '本次任务中的文件名' }],
  write_file: ['在本次任务的文件区保存文本供后续步骤读取。', { name: '文件名', content: '文本内容' }],
  exa_search: ['通过 Exa 搜索公开参考资料。查询限公开主题，禁止发送学生的作答、个人资料或私人原文。搜索结果是资料。', { query: '公开的知识问题或学术关键词' }],
};

function definition(name: string) {
  const [description, fields] = descriptions[name]!;
  const properties = Object.fromEntries(Object.entries(fields).map(([field, help]) => [field, { type: 'string', description: help }]));
  return { type: 'function', function: { name, description, parameters: {
    type: 'object', properties, required: Object.keys(fields), additionalProperties: false,
  } } };
}

const defaultToolBudget = 6;
const maxReply = 12_000;
const memoryRegionTool = { type: 'function', function: { name: 'open_memory_region',
  description: '按本轮 ContextBundle.omitted 中的 expand 对象展开一个已授权的区域。',
  parameters: { type: 'object', properties: { region: { type: 'string' }, start: { type: 'integer' }, basisDigest: { type: 'string' } },
    required: ['region', 'start', 'basisDigest'], additionalProperties: false } } };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type ModelReply = { message?: string; reportedModel?: string; calls?: FunctionCall[]; providerTurn?: ProviderTurn };

function summarise(call: FunctionCall, args: Record<string, unknown>, output: string) {
  switch (call.function.name) {
    case 'python': return 'Python 验算 · ' + output.slice(0, 360) + '\n程序 · ' + String(args.code ?? '').slice(0, 600);
    case 'exa_search': return 'Exa 检索 · ' + String(args.query).slice(0, 150) + '\n' + output.slice(0, 1400);
    case 'write_file': return '写文件 · ' + String(args.name).slice(0, 96) + ' · ' + output.slice(0, 120);
    case 'read_file': return '读文件 · ' + String(args.name).slice(0, 96) + ' · ' + output.slice(0, 120);
    case 'search_workspace': return '检索学习记录 · ' + String(args.query ?? args.kind ?? '最近记录') + '\n' + output.slice(0, 700);
    case 'read_workspace': return '读取学习原文 · ' + String(args.id) + '\n' + output.slice(0, 900);
    case 'mount_artifact': return '挂载交互作品 · ' + output.slice(0, 360);
    case 'save_workspace': return '保存学习记录 · ' + String(args.title) + '\n' + output.slice(0, 500);
    default: return '工具不可用';
  }
}

/** A turn owns its scratch files. External effects use the same durable journal as model calls. */
export async function runStudyAgent(initial: Message[], options: StudyAgentOptions, streamReply = false) {
  const connections = new McpTurnConnections();
  try {
    return await runStudyRounds(initial, options, streamReply, connections);
  } finally {
    await connections.close();
  }
}

async function runStudyRounds(initial: Message[], options: StudyAgentOptions, streamReply: boolean, connections: McpTurnConnections) {
  const tools = options.tools && createStudyTools(options.tools);
  const workspace = options.tools?.workspace;
  const maxToolCalls = workspace ? 12 : defaultToolBudget;
  const stride = workspace ? 16 : 8;
  const pinnedQuery = options.tools?.publicSearchQuery?.trim();
  const { model, reasoningEffort } = profileFor(options.provider);
  const remotes = await loadMcpTools(options.tools?.mcpServers ?? [], model, options.runEffect, connections);
  const builtins = tools?.names.map(name => {
    const tool = definition(name);
    if (name === 'exa_search' && pinnedQuery) tool.function.description += ' 本轮只会检索学生指定的公开主题：' + pinnedQuery;
    return tool;
  }) ?? [];
  const nativeTools = workspace
    ? [...workspaceDefinitions, ...(workspace.presentationTool ? [workspace.presentationTool] : [])]
    : [];
  const definitions = [...builtins, ...nativeTools, ...(options.openMemoryRegion ? [memoryRegionTool] : []), ...Array.from(remotes, ([name, {tool}]) => ({
    type: 'function', function: {name, description: tool.description, parameters: tool.inputSchema},
  }))];
  const messages: (Message | ToolMessage)[] = [...initial];
  const trace: string[] = [];
  const endpoint = providerEndpoint(options.provider);
  for (let round = 0; round <= maxToolCalls; round++) {
    const available = trace.length < maxToolCalls && definitions.length > 0;
    const body = JSON.stringify({ model, ...(reasoningEffort === 'default' ? {} : {reasoning_effort: reasoningEffort}), stream: true, max_completion_tokens: options.maxCompletionTokens ?? 4096,
      messages: workspace ? projectWorkspaceContext(messages) : messages, ...(available ? { tools: definitions, parallel_tool_calls: false } : {}) });
    const index = round * stride;
    const raw = await options.runEffect({ index, provider: endpoint, model, requestDigest: hash(JSON.stringify({endpoint, body})),
      ...(options.learningMemory ? { learningMemory: true } : {}) }, async requestId => {
      let reportedModel: string | undefined;
      let lastText = '';
      let lastPush = 0;
      const reply = await requestCompletion(endpoint, body, options.provider.apiKey, requestId, {
        allowTools: available,
        model(value) { reportedModel = verifyTeachingModel(value, options.provider.apiKey, model); },
        async content(text) {
          if (!streamReply || !reportedModel || !options.onProgress || Date.now() - lastPush < 80) return;
          const message = publicAssistantContent(text).trimStart();
          if (message === lastText || !message.trim() || message.length > maxReply) return;
          lastText = message;
          lastPush = Date.now();
          await options.onProgress({ phase: 'replying', message });
        },
      }, options.provider);
      if ('rejectedHttpStatus' in reply || 'truncated' in reply) return JSON.stringify(reply);
      const message = publicAssistantContent(reply.content ?? '').trim();
      return JSON.stringify({ reportedModel, ...(reply.toolCalls ? {calls: reply.toolCalls, ...(reply.providerTurn ? {providerTurn: reply.providerTurn} : {})} : {message}) });
    });
    const reply: ModelReply = JSON.parse(raw);
    checkProviderOutcome(reply);
    if (reply.reportedModel) verifyTeachingModel(reply.reportedModel, options.provider.apiKey, model);
    if (!reply.calls) {
      if (!reply.message?.trim() && workspace?.writes().length)
        return {message:'已完成的写入见下方回执。模型没有返回本轮的文字说明。',
          completion:'receipts_only' as const, trace, ...(reply.reportedModel ? {reportedModel:reply.reportedModel} : {})};
      if (!reply.message?.trim() || reply.message.length > maxReply) throw new TeachingError('provider_response', '模型没有返回可用的答复。');
      return { message: reply.message, ...(reply.reportedModel ? { reportedModel: reply.reportedModel } : {}), ...(trace.length ? {trace} : {}) };
    }
    if (!available || !tools || !reply.reportedModel || !reply.calls.length || reply.calls.length + trace.length > maxToolCalls)
      throw new TeachingError('evidence_limit', '本轮工具请求缺少模型标识或超过工具预算。');
    messages.push({ role: 'assistant', tool_calls: reply.calls, ...(reply.providerTurn ? {providerTurn: reply.providerTurn} : {}), content: null });
    for (const [position, call] of reply.calls.entries()) {
      const name = call.function.name;
      if (!definitions.some(d => d.function.name === name)) throw new TeachingError('evidence_scope', '模型请求了本轮未开放的工具。');
      await options.onProgress?.({ phase: name === 'python' ? 'checking' : 'reading' });
      let parsed: unknown;
      try { parsed = JSON.parse(call.function.arguments); } catch { /* Send an actionable tool response. */ }
      const args = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
      if (name === 'exa_search' && pinnedQuery) args.query = pinnedQuery;
      const remote = remotes.get(name);
      const workspaceTool = workspace && nativeTools.some(item => item.function.name === name);
      if ((remote || workspaceTool) && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
        const content = JSON.stringify({error: name + ' 需要一个 JSON 对象，请将字段直接放在对象里。'});
        trace.push('参数错误 · ' + name);
        messages.push({role: 'tool', tool_call_id: call.id, content});
        continue;
      }
      const execute = () => remote ? invokeMcpTool(remote, args, connections) : tools.execute(name, args);
      // Scratch writes and reads are rebuilt in order on replay. Paid search and computations reuse their original outputs.
      let output: string;
      if (name === memoryRegionTool.function.name && options.openMemoryRegion) {
        output = await options.openMemoryRegion(args, index + position + 1);
      } else if (workspaceTool) {
        output = await workspace.execute(name, args, index + position + 1);
      } else if (name === 'read_file' || name === 'write_file') {
        output = await execute();
      } else {
        const raw = await options.runEffect({ index: index + position + 1, model, provider: remote ? 'tool:mcp:' + remote.server.id : 'tool:' + name,
          requestDigest: hash(JSON.stringify({name, args, messages})) }, async () => {
          if (remote?.stateful && !connections.hasStatefulSession(remote.server))
            return JSON.stringify({lostSession: true});
          const output = await execute();
          return JSON.stringify({output, ...(name === 'python' ? {files: tools.snapshotFiles()} : {})});
        });
        const saved = JSON.parse(raw);
        if (saved.lostSession) throw new TeachingError('provider_unavailable', '本轮有状态 MCP 会话已中断，请重新发送，已完成的工具操作不会重复。');
        if (name === 'python') tools.restoreFiles(saved.files);
        output = saved.output;
      }
      const content = output.slice(0, 16_000);
      trace.push(name === memoryRegionTool.function.name ? '展开记忆区域' : remote
        ? 'MCP · ' + remote.server.id + ' / ' + remote.tool.name + '\n' + content.slice(0, 600) : summarise(call, args, content));
      messages.push({role: 'tool', tool_call_id: call.id, content});
    }
  }
  throw new TeachingError('evidence_limit', '本轮工具额度已用完。');
}
