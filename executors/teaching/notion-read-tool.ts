import {
  learningToolFallback,
  toolFailure,
  type LearningError,
  type LearningResult,
  type ToolArgs,
  type ToolDefinition,
} from './learning-tools.ts';

export type NotionReadDiff = Readonly<{
  added: readonly string[];
  removed: readonly string[];
  edited: readonly string[];
  moved: readonly string[];
}>;

export type NotionReadBlock = Readonly<{id: string; parentId: string | null; text: string}>;

export type NotionReadOutput = Readonly<{
  sourceId: string;
  rev: number;
  accessEpoch: string;
  title: string;
  status: 'refreshed' | 'unchanged';
  diff: NotionReadDiff;
  blocks: readonly NotionReadBlock[];
}>;

export type NotionReadInput = Readonly<{
  sourceId: string;
  refresh: boolean;
  blockIds?: readonly string[];
}>;

export type UnchangedNotionReadSnapshot = Readonly<Omit<NotionReadOutput, 'status' | 'diff'>>;

export type NotionReadHostOutcome =
  | {readonly ok: true; readonly data: NotionReadOutput}
  | {readonly ok: false; readonly kind: 'unchanged'; readonly snapshot: UnchangedNotionReadSnapshot}
  | {readonly ok: false; readonly kind: 'withdrawn' | 'denied' | 'stale' | 'stale_watermark' |
      'unconfirmed' | 'not_found'; readonly message?: string};

export type NotionReadHostPort = {
  read(input: NotionReadInput, context: {step: number}): Promise<NotionReadHostOutcome>;
};

export const notionReadDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'notion_read',
    description: '按需读取获准 Notion 来源，可只读局部块或在同一 capture.source 上推进新修订。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['source_id'],
      properties: {
        source_id: {type: 'string', minLength: 1, maxLength: 128},
        refresh: {type: 'boolean', default: false},
        block_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: {type: 'string', minLength: 1},
          description: '最多 32 个非空 block_id，仅返回局部块。',
        },
      },
    },
  },
};

export const notionReadWriteKeys = () => [] as const;

function invalidArgs(message: string, field?: string): LearningError {
  return toolFailure('invalid_args', message, learningToolFallback('notion_read'), field);
}

export function parseNotionReadArgs(args: ToolArgs): {ok: true; input: NotionReadInput} | {ok: false; error: LearningError} {
  const allowed = ['source_id', 'refresh', 'block_ids'];
  const unknownField = Object.keys(args).find(key => !allowed.includes(key));
  if (unknownField) return {ok:false, error:invalidArgs(`工具不支持字段 ${unknownField}。`, unknownField)};
  const sourceId = args.source_id;
  if (typeof sourceId !== 'string' || !sourceId.trim() || sourceId.length > 128)
    return {ok:false, error:invalidArgs('source_id 须为 1–128 个字符的非空字符串。','source_id')};
  if (args.refresh !== undefined && typeof args.refresh !== 'boolean')
    return {ok:false, error:invalidArgs('refresh 须为 boolean。','refresh')};
  const rawBlockIds = args.block_ids;
  if (rawBlockIds !== undefined && (!Array.isArray(rawBlockIds) || rawBlockIds.length > 32 ||
      rawBlockIds.some(id => typeof id !== 'string' || !id.trim())))
    return {ok:false, error:invalidArgs('block_ids 须为最多 32 个非空字符串。','block_ids')};
  const blockIds = rawBlockIds === undefined ? undefined : rawBlockIds as readonly string[];
  return {ok:true, input:{sourceId, refresh:args.refresh === true, ...(blockIds && {blockIds})}};
}

const emptyDiff = {added:[], removed:[], edited:[], moved:[]} as const;

function failureFor(kind: 'withdrawn' | 'denied' | 'stale' | 'stale_watermark' | 'unconfirmed' | 'not_found',
  input: NotionReadInput, message: string | undefined): LearningError {
  const retry = {tool:'notion_read', args:{source_id:input.sourceId, refresh:input.refresh}};
  switch (kind) {
    case 'withdrawn':
    case 'denied':
      return toolFailure('access_revoked', message ?? 'Notion 来源已撤回或拒绝访问。',{tool:'search_learning',args:{}},'source_id');
    case 'stale':
    case 'stale_watermark':
      return toolFailure('basis_stale', message ?? 'Notion 来源或访问代次已变化。',{tool:'notion_read',args:{source_id:input.sourceId,refresh:false}},'source_id');
    case 'unconfirmed':
      return toolFailure('basis_stale', message ?? '暂时无法确认 Notion 来源，请稍后重试。',retry,'source_id');
    case 'not_found':
      return toolFailure('not_found', message ?? '未找到获准的 Notion 来源。',{tool:'search_learning',args:{}},'source_id');
  }
}

function errorFrom(error: unknown, input: NotionReadInput): LearningError | undefined {
  const value = error as {code?: unknown; name?: unknown; message?: unknown; snapshot?: unknown; invalidated?: unknown} | null | undefined;
  const code = typeof value?.code === 'string' ? value.code : undefined;
  const name = typeof value?.name === 'string' ? value.name : undefined;
  const message = typeof value?.message === 'string' ? value.message : undefined;
  if (code === 'notion_source_unchanged' || name === 'UnchangedNotionSourceError') {
    if (value?.snapshot) return;
    return failureFor('unconfirmed', input, 'Notion 原件未变化，请重试。');
  }
  if (name === 'NotionSourceUnavailable') return value?.invalidated ? failureFor('denied', input, message)
    : failureFor('stale', input, message);
  if (name === 'FactReadDeniedError') return failureFor('denied', input, message);
  if (name === 'NotionSourceChanged') return failureFor('stale', input, message);
  if (name === 'NotionSourceUnconfirmed' || name === 'NotionChildUnavailable')
    return failureFor('unconfirmed', input, message);
  if (name === 'LifecycleError') return failureFor('stale_watermark', input, message);
  return failureFor('unconfirmed', input, message);
}

export async function executeNotionRead(args: ToolArgs, host: NotionReadHostPort,
  context: {step: number}): Promise<LearningResult> {
  const parsed = parseNotionReadArgs(args);
  if (!parsed.ok) return parsed.error;
  try {
    const outcome = await host.read(parsed.input, context);
    if (outcome.ok) return {ok:true, data:outcome.data};
    if (outcome.kind === 'unchanged') {
      return {ok:true, data:{...outcome.snapshot, status:'unchanged', diff:emptyDiff}};
    }
    return failureFor(outcome.kind, parsed.input, outcome.message);
  } catch (error) {
    const mapped = errorFrom(error, parsed.input);
    if (mapped) return mapped;
    if (error instanceof Error && typeof (error as {code?: unknown}).code === 'string')
      return failureFor('stale', parsed.input, error.message);
    return failureFor('unconfirmed', parsed.input, error instanceof Error ? error.message : undefined);
  }
}
