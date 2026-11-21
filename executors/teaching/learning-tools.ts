import type {JsonObject, ToolError, ToolErrorCode} from '@mangekyo/kernel';
import {workspaceDefinitions, type ReceiveStudyImage, type WorkspaceWriteReceipt} from './workspace-tools.ts';
import type {PythonRead, PythonReadValue} from './python-sdk.ts';

export const hostedReads = ['search_learning', 'open_learning', 'read_context'] as const;
export const hostedWrites = ['save_page', 'save_question', 'save_belief', 'save_edge', 'manage_activity'] as const;
export const onDemandTools = ['schedule_followup', 'evolve_graph', 'refresh_living_slots', 'notion_read'] as const;

export type HostedRead = typeof hostedReads[number];
export type HostedWrite = typeof hostedWrites[number];
export type OnDemandTool = typeof onDemandTools[number];
export type HostedTool = HostedRead | HostedWrite | OnDemandTool | 'mount_artifact';
export type ToolArgs = Record<string, unknown>;
export type ToolDefinition = {
  type: string;
  function: {name: string; description: string; parameters: Record<string, unknown>};
};
type Definitions<T extends string> = {[K in T]: ToolDefinition & {function: {name: K}}};

export type LearningError = ToolError & {field?: string; valid_fields?: readonly string[]};
export type LearningResult = (LearningError & {items?: readonly unknown[]}) |
  {ok: true; data: unknown; warnings?: readonly LearningError[]};
// Off-wire provenance for a complete inline response or a range expanded from its handle.
export type DeliveredToolRange = {step: number; output: string; start: number; end: number};
export type ResultHandle = {step: number; value: string; mediaType?: 'image/png'};

function toolMessage(message: string) {
  return [...message.toWellFormed()].slice(0, 60).join('');
}

export function toolFailure(code: ToolErrorCode, message: string, next: {tool: string; args: JsonObject}, field?: string): LearningError {
  const fields = {ok: false as const, message: toolMessage(message), next, ...(field && {field})};
  return code === 'not_found' ? {...fields, code, candidates: []} : {...fields, code};
}

/** Turn-scoped bindings from Studio. Their reads and writes use the same authoritative data path.
 * Each call journals/revalidates its own witnesses before publishing. Write keys are canonical
 * identities, so aliases and pinned revisions of one ref share a key. Return [] if the
 * write set cannot be established before execution. Across turns the bus owns serialization.
 */
export type LearningTools = {
  definitions: Definitions<HostedRead | Exclude<HostedWrite, 'save_belief'>> & Partial<Definitions<OnDemandTool | 'mount_artifact'>>;
  execute(name: HostedTool, args: ToolArgs, context: {
    step: number;
    handles: Readonly<Record<string, ResultHandle>>;
    receiveImage: ReceiveStudyImage;
    priorRead: Promise<unknown>;
  }): Promise<LearningResult>;
  writeKeys(name: HostedWrite | OnDemandTool | 'mount_artifact', args: ToolArgs): readonly string[];
  preparePython(reads: readonly PythonRead[], step: number): Promise<LearningError | {
    ok: true;
    /** Authorized projections in request order. The host records and revalidates their witnesses. */
    values: readonly PythonReadValue[];
    warnings?: readonly LearningError[];
  }>;
  /** Recheck the producing steps when a handle is used in another call. */
  authorizeHandles(steps: readonly number[], consumerStep: number): Promise<LearningError | {ok: true}>;
  onDelivered?(range: DeliveredToolRange): void;
  writes(): readonly WorkspaceWriteReceipt[];
};

const text = {type: 'string', minLength: 1, maxLength: 600};
const action = {type: 'string', enum: ['remember', 'update', 'forget']};
const supersedes = {type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$'};
const datetime = {type: 'string', format: 'date-time', description: 'UTC 时间，含毫秒。'};
const target = {if: {properties: {action: {const: 'remember'}}},
  then: {not: {required: ['supersedes']}}, else: {required: ['supersedes']}};
export const saveBeliefDefinition = {type: 'function', function: {
  name: 'save_belief',
  description: '对一条记忆执行 remember、update 或 forget。学习者的原话与边界用 directive，实证假设用 hypothesis。update 与 forget 用本轮已确认的旧条目作为 supersedes；补充反证用 update。',
  parameters: {type: 'object', oneOf: [
    {type: 'object', additionalProperties: false, required: ['category', 'action', 'quote_excerpt'], properties: {
      category: {type: 'string', enum: ['directive']}, action, supersedes,
      kind: {type: 'string', enum: ['preference', 'claim', 'state', 'refusal']},
      quote_excerpt: {...text, description: '本轮学习者的连续逐字原话。'},
      text: {...text, description: '可省略。填写时与 quote_excerpt 逐字一致。'},
      scope: {type: 'string', enum: ['general', 'current_object', 'unknown']},
      valid_until: {type: ['string', 'null'], format: 'date-time', description: '短期状态的明确有效期，UTC 含毫秒。'},
      goal: {...text, maxLength:200}, intent_key: {...text, maxLength:160},
      reopen_condition: {oneOf: [
        {type: 'object', required: ['kind'], additionalProperties: false, properties: {kind: {const: 'learner_request'}}},
        {type: 'object', required: ['kind', 'at'], additionalProperties: false,
          properties: {kind: {const: 'at'}, at: datetime}},
      ]},
    }, allOf: [target, {
      if: {properties: {action: {const:'remember'}}},
      then: {required:['kind'], allOf: [
        {if: {properties: {kind: {const:'refusal'}}}, then: {required:['goal', 'intent_key', 'reopen_condition']}},
        {if: {properties: {kind: {const:'state'}}}, then: {required:['valid_until'], properties:{valid_until:datetime}}},
      ]},
    }]},
    {type: 'object', additionalProperties: false, required: ['category', 'action'], properties: {
      category: {type: 'string', enum: ['hypothesis']}, action, supersedes, text,
      scope: {type: 'string', enum: ['general', 'current_object']},
      quote_excerpt: {...text, description: '撤回时逐字引用本轮学习者要求。'},
      evidence_refs: {type: 'array', minItems: 1, maxItems: 6, items: {
        type: 'object', additionalProperties: false, required: ['id', 'rev', 'accessEpoch', 'anchor', 'excerpt', 'direction'],
        properties: {id: supersedes, rev: {type: 'integer', minimum: 1, maximum:2147483647},
          accessEpoch: {type:'string', pattern:'^(0|[1-9][0-9]*)$'}, anchor: {...text,maxLength:160},
          excerpt: {...text,maxLength:360}, direction: {type:'string', enum:['support','contradict']}},
      }},
    }, allOf:[target,
      {if:{properties:{action:{const:'remember'}}}, then:{required:['text','scope','evidence_refs']}},
      {if:{properties:{action:{const:'update'}}}, then:{required:['evidence_refs']}},
      {if:{properties:{action:{const:'forget'}}}, then:{required:['quote_excerpt']}},
    ]},
  ]},
}};

export function formatLearningResult(result: LearningResult): string {
  function error(value: LearningError) {
    return {...value, message:toolMessage(value.message)};
  }
  return JSON.stringify(result.ok
    ? {...result, ...(result.warnings && {warnings: result.warnings.map(error)})}
    : error(result));
}

/** Wait for the original order before appending receipts, even when calls complete out of order. */
export async function settledToolBatch<T>(calls: readonly (() => Promise<T>)[]): Promise<T[]> {
  const completed = await Promise.allSettled(calls.map(call => call()));
  return completed.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

export const workspaceToolAliases = {search_learning:'search_workspace',open_learning:'open_learning',
  save_page:'save_page',save_edge:'save_relation'} as const;
function renamed<K extends keyof typeof workspaceToolAliases>(name: K) {
  const definition = workspaceDefinitions.find(tool => tool.function.name === workspaceToolAliases[name])!;
  return {...definition,function:{...definition.function,name}};
}
function tool<K extends string>(name: K, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {type:'function',function:{name,description,parameters:{type:'object',additionalProperties:false,properties,required}}};
}
export const learningToolFallback = (name: string) => ({tool:'find_tools',args:{query:name}});
type WorkspaceFailure = {
  code?: unknown;
  field?: unknown;
  message?: unknown;
  next?: {tool: string; args: JsonObject};
};

function adaptWorkspaceError(value: WorkspaceFailure, name: HostedTool, catalog?: 'workspace-v2'): LearningError {
  const code = value.code;
  const next = value.next?.tool;
  const redirect = next === 'read_workspace' ? 'open_learning' : next === 'search_workspace' && !catalog ? 'search_learning' :
    next === 'save_relation' ? 'save_edge' : next;
  const id = value.next?.args?.id;
  const args = next === 'read_workspace' ? (typeof id === 'string' ? {refs:id} : undefined) : value.next?.args;
  const emptyWrite = catalog && redirect?.startsWith('save_') && args && !Object.keys(args).length;
  const retry = redirect && args && !emptyWrite &&
    ['open_learning','search_learning','search_workspace','save_page','save_edge','save_belief'].includes(redirect)
    ? {tool:redirect,args} : learningToolFallback(name);
  const normalized = code === 'budget_or_limit' ? 'limit_exceeded' :
    code === 'not_found' || code === 'access_revoked' || code === 'basis_stale' ||
    code === 'version_conflict' || code === 'evidence_not_opened' || code === 'limit_exceeded' ? code : 'invalid_args';
  return toolFailure(normalized,String(value.message ?? '工具无法完成。'),retry,
    typeof value.field === 'string' ? value.field : undefined);
}

export function adaptWorkspaceResult(raw: string, name: HostedTool, catalog?: 'workspace-v2'): LearningResult {
  const value = JSON.parse(raw);
  if (value?.ok !== false) return {ok:true,data:value};
  if (name !== 'open_learning' || !Array.isArray(value.items)) return adaptWorkspaceError(value,name,catalog);
  const warnings: LearningError[] = [];
  const items = value.items.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('ok' in item) || item.ok !== false) return item;
    // A failed item may come from an older receipt without a witness for its hint.
    const warning = adaptWorkspaceError({...item,next:{tool:'search_workspace',args:{}}},name,catalog);
    warnings.push(warning);
    return warning;
  });
  if (value.code === 'partial_success') return {ok:true,data:{code:value.code,items},warnings};
  return {...adaptWorkspaceError(value,name,catalog),items};
}

const saveQuestionDefinition = tool('save_question','保存独立题面草稿。题库核验前不可发放。',{
  title:{type:'string',maxLength:240},prompt:{type:'string',maxLength:8000},
  response_schema:{type:'array',items:{type:'object'},maxItems:32},
  assessment_contract:{type:'array',items:{type:'object'},maxItems:32},
},['title','prompt']);

const workspaceDefinitionByName = new Map(workspaceDefinitions.map(definition => [definition.function.name, definition]));
// The agentVersion 2 catalog names its narrow saves directly. The retired six-in-one
// save_workspace stays only in the versioned agentVersion 1 catalog for replayed turns.
export const narrowWorkspaceDefinitions: ToolDefinition[] = [
  'read_learner_radar','open_learning','search_workspace','read_workspace','record_observation','save_page',
].map(name => workspaceDefinitionByName.get(name)!)
  .concat(renamed('save_edge'), saveQuestionDefinition);

export function learningHostDefinitions(manageBeliefs: boolean, allowedIntents: readonly string[],
  artifact?: ToolDefinition, notionRead?: ToolDefinition): LearningTools['definitions'] {
  return {
    search_learning:renamed('search_learning'),open_learning:renamed('open_learning'),
    read_context:tool('read_context','读取已授权学习上下文，intent 支持 radar、tutoring、conversation、planning、execution、history。从返回的 omitted.expand 可打开更多本轮已授权内容。当前只读当前视点。' +
      (manageBeliefs ? '更正或忘记记忆前，用 management 和可选 query 查找原条目。' : ''),{
      intent:{type:'string',enum:['radar','conversation',...allowedIntents]},
      ...(manageBeliefs ? {query:{type:'string',minLength:1,maxLength:120}} : {}),horizon_hours:{type:'integer',minimum:1,maximum:168},
      expand:{type:'object',additionalProperties:false,required:['region','start','basisDigest'],properties:{
        region:{type:'string'},start:{type:'integer',minimum:0},basisDigest:{type:'string',pattern:'^[0-9a-f]{64}$'},
      }},
    },['intent']),
    save_page:renamed('save_page'),save_edge:renamed('save_edge'),
    save_question:saveQuestionDefinition,
    manage_activity:tool('manage_activity','用正常挂载命令为当前回合发放作品。动作 mount_artifact。',{
      action:{const:'mount_artifact'},...((artifact?.function.parameters.properties ?? {}) as object),
    },['action','view']),
    ...(artifact ? {mount_artifact:{...artifact,function:{...artifact.function,name:'mount_artifact' as const}}} : {}),
    ...(notionRead ? {notion_read:{...notionRead,function:{...notionRead.function,name:'notion_read' as const}}} : {}),
  };
}
