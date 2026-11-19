import {
  factId,
  type CommandContext,
  type FactId,
  type Revision,
  type Tick,
} from '@mangekyo/kernel';
import {ridingPracticeType} from './practice-values.ts';
import {workbookAttemptType, workbookPaperType} from './workbook-values.ts';
import {goalType, materialType} from './library-values.ts';
import {organizerTaskType} from './organizer-values.ts';
import type {OrganizerTask} from './organizer-values.ts';
import {organizerNoteType} from './organizer-values.ts';

export class WorkspaceInputError extends Error {}

export const workspaceEntryType = 'activity.workspaceEntry';
export const saveWorkspaceEntryCommand = 'activity.saveWorkspaceEntry';
export const setWorkspaceTeachingCommand = 'activity.setWorkspaceTeaching';

export const workspaceEntryKinds = [
  'question',
  'page',
  'concept',
  'relation',
  'observation',
  'annotation',
] as const;

export type WorkspaceEntryKind = (typeof workspaceEntryKinds)[number];

export const workspaceTitleLimit = 240;
export const workspaceBodyLimit = 8000;
export const workspaceTagLimit = 64;
export const workspaceTagCountLimit = 32;
export const workspaceLinkCountLimit = 32;
export const workspaceAnswerLimit = 4000;
export const workspaceRubricLimit = 8000;
export const workspaceBasisCountLimit = 256;

export type WorkspaceEntryBasis = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly epoch: Tick;
};

export type WorkspaceEntryBasisInput = {
  readonly id: string;
  readonly rev: number;
  readonly epoch: string | number;
};

/**
 * The persisted flat shape of activity.workspaceEntry. `body` is always a
 * string; relation entries store an empty body when none was supplied.
 */
export type WorkspaceEntry = {
  readonly kind: WorkspaceEntryKind;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly links: readonly FactId[];
  readonly answer?: string;
  readonly rubric?: string;
  readonly basis: readonly WorkspaceEntryBasis[];
};

export type WorkspaceEntryFields = Omit<WorkspaceEntry, 'basis'>;

export type WorkspaceEntryInput = {
  readonly kind: WorkspaceEntryKind;
  readonly title: string;
  readonly body?: string | null;
  readonly tags?: readonly string[];
  readonly links?: readonly string[];
  readonly answer?: string | null;
  readonly rubric?: string | null;
};

export type SaveWorkspaceEntryInput = {
  readonly id: FactId;
  readonly expectedRev?: Revision;
  readonly entry: WorkspaceEntryFields;
  readonly basis: readonly WorkspaceEntryBasis[];
};

export type SetWorkspaceTeachingInput = {
  readonly id: FactId;
  readonly expectedRev: Revision;
  readonly enabled: boolean;
};

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkspaceInputError('工作区条目格式无效。');
  }
  return input as Record<string, unknown>;
}

function storable(value: string): boolean {
  return value.isWellFormed() && !value.includes('\u0000');
}

function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string') throw new WorkspaceInputError(`${label}必须是文字。`);
  if (!storable(value)) throw new WorkspaceInputError(`${label}包含无效字符。`);
  if (value.length > limit) throw new WorkspaceInputError(`${label}超过 ${limit} 字。`);
  return value;
}

function title(value: unknown): string {
  const parsed = text(value, 'title', workspaceTitleLimit).trim();
  if (!parsed) throw new WorkspaceInputError('请在 title 填写条目标题。');
  return parsed;
}

function body(value: unknown, kind: WorkspaceEntryKind): string {
  if (value === undefined || value === null) {
    if (kind === 'relation') return '';
    throw new WorkspaceInputError('请在 body 填写正文；出题时填写学生将看到的题面。');
  }
  const parsed = text(value, 'body', workspaceBodyLimit);
  if (!parsed.trim()) {
    if (kind === 'relation') return '';
    throw new WorkspaceInputError('请在 body 填写正文；出题时填写学生将看到的题面。');
  }
  return parsed;
}

function optionalText(value: unknown, label: string, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = text(value, label, limit).trim();
  return parsed ? parsed : undefined;
}

function kind(value: unknown): WorkspaceEntryKind {
  if (typeof value !== 'string' || !(workspaceEntryKinds as readonly string[]).includes(value)) {
    if (value === 'note') throw new WorkspaceInputError('kind="note" 只用于搜索已有笔记。保存方法笔记请用 kind="page"，保留原来的 title 和 body。');
    throw new WorkspaceInputError('请在 kind 选择要保存的类型：' + workspaceEntryKinds.join('、') + '。教材和方法笔记用 page。');
  }
  return value as WorkspaceEntryKind;
}

function revision(value: unknown, label: string): Revision {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new WorkspaceInputError(`${label}无效。`);
  }
  return value as Revision;
}

function tick(value: unknown): Tick {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value) as Tick;
  }
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    return value as Tick;
  }
  throw new WorkspaceInputError('依据访问代次无效。');
}

function tags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > workspaceTagCountLimit) {
    throw new WorkspaceInputError(`tags 须为字符串数组，最多 ${workspaceTagCountLimit} 个。`);
  }
  const parsed = value.map((item, index) => {
    const tag = text(item, `第 ${index + 1} 个标签`, workspaceTagLimit).trim();
    if (!tag) throw new WorkspaceInputError('标签不能为空。');
    return tag;
  });
  if (new Set(parsed).size !== parsed.length) throw new WorkspaceInputError('标签不能重复。');
  return parsed;
}

function links(value: unknown): FactId[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > workspaceLinkCountLimit) {
    throw new WorkspaceInputError(`links 须为记录 id 数组，最多 ${workspaceLinkCountLimit} 个。`);
  }
  const parsed = value.map((item, index) => {
    try {
      if (typeof item === 'string') return factId(item);
    } catch { /* Use the workspace field name and a discoverable source for the ID. */ }
    throw new WorkspaceInputError(`links[${index}] 需要记录 id。请复制 search_workspace 结果或保存回执中的 id。`);
  });
  if (new Set(parsed).size !== parsed.length) throw new WorkspaceInputError('链接不能重复。');
  return parsed;
}

export function workspaceEntryFields(input: unknown): WorkspaceEntryFields {
  const value = record(input);
  const entryKind = kind(value.kind);
  const entryTitle = title(value.title);
  const entryBody = body(value.body, entryKind);
  const entryTags = tags(value.tags);
  const entryLinks = links(value.links);
  if (entryKind === 'relation' && entryLinks.length !== 2) {
    throw new WorkspaceInputError('kind=relation 时 links 需要两个不同的 concept id，按起点、终点排列。');
  }
  const answer = optionalText(value.answer, 'answer', workspaceAnswerLimit);
  const rubric = optionalText(value.rubric, 'rubric', workspaceRubricLimit);
  if (entryKind === 'question') {
    if (answer === undefined && rubric === undefined) {
      throw new WorkspaceInputError('kind=question 时请在 answer 填写参考解，或在 rubric 填写评分标准；body 只放题面。');
    }
  } else if (answer !== undefined || rubric !== undefined) {
    throw new WorkspaceInputError('answer 和 rubric 仅用于 question。保存其他类型时请省略这两个字段。');
  }
  return {
    kind: entryKind,
    title: entryTitle,
    body: entryBody,
    tags: entryTags,
    links: entryLinks,
    ...(answer === undefined ? {} : { answer }),
    ...(rubric === undefined ? {} : { rubric }),
  };
}

export function workspaceEntryBasis(input: unknown): WorkspaceEntryBasis[] {
  if (!Array.isArray(input) || input.length > workspaceBasisCountLimit) {
    throw new WorkspaceInputError('依据清单无效。');
  }
  const parsed = input.map((item, index) => {
    const value = record(item);
    if (typeof value.id !== 'string') throw new WorkspaceInputError('依据标识无效。');
    return {
      id: factId(value.id),
      rev: revision(value.rev, `第 ${index + 1} 条依据的版本`),
      epoch: tick(value.epoch),
    };
  });
  const seen = new Set(parsed.map((item) => `${item.id}:${item.rev}`));
  if (seen.size !== parsed.length) throw new WorkspaceInputError('依据不能重复。');
  return parsed;
}

/** Parses a persisted activity.workspaceEntry value. */
export function workspaceEntry(input: unknown): WorkspaceEntry {
  const value = record(input);
  return { ...workspaceEntryFields(value), basis: workspaceEntryBasis(value.basis) };
}

export function saveWorkspaceEntryInput(input: unknown): SaveWorkspaceEntryInput {
  const value = record(input);
  if (typeof value.id !== 'string') throw new WorkspaceInputError('工作区条目标识无效。');
  const id = factId(value.id);
  const expectedRev = value.expectedRev === undefined
    ? undefined
    : revision(value.expectedRev, '条目版本');
  const entry = workspaceEntryFields(value.entry);
  if (entry.links.some((link) => link === id)) {
    throw new WorkspaceInputError('链接不能指向条目自身。');
  }
  const basis = workspaceEntryBasis(value.basis);
  if (basis.some((item) => item.id === id)) {
    throw new WorkspaceInputError('依据不能指向条目自身。');
  }
  return { id, entry, basis, ...(expectedRev === undefined ? {} : { expectedRev }) };
}

export function setWorkspaceTeachingInput(input: unknown): SetWorkspaceTeachingInput {
  const value = record(input);
  if (typeof value.id !== 'string') throw new WorkspaceInputError('工作区条目标识无效。');
  if (typeof value.enabled !== 'boolean') throw new WorkspaceInputError('教学用途开关无效。');
  return {
    id: factId(value.id),
    expectedRev: revision(value.expectedRev, '条目版本'),
    enabled: value.enabled,
  };
}

export const workspaceAttemptTypes = ['activity.studyRecord', ridingPracticeType, workbookAttemptType];
export const workspaceShareableTypes = [
  ...workspaceAttemptTypes,
  workbookPaperType,
  materialType,
  organizerNoteType,
  goalType,
  organizerTaskType,
  workspaceEntryType,
];
export const workspaceOverviewTypes = workspaceShareableTypes;

export type LearningOverviewFact = {
  readonly id: string;
  readonly rev: number;
  readonly type: string;
  readonly value: unknown;
  readonly accessEpoch: string;
};

export type LearningOverviewWitness = {
  readonly id: string;
  readonly rev: number;
  readonly type: string;
  readonly accessEpoch: string;
};

export type LearningOverviewTask = OrganizerTask & Pick<LearningOverviewWitness, 'id' | 'rev'>;

export type LearningOverviewGoal =
  | { readonly state: 'empty' }
  | { readonly state: 'unavailable' }
  | { readonly state: 'set'; readonly text: string | null; readonly witness: LearningOverviewWitness };

export type LearningOverviewTasks =
  | {
    readonly state: 'empty' | 'unavailable';
    readonly witnesses: readonly [];
  }
  | {
    readonly state: 'partial' | 'available';
    readonly items: readonly LearningOverviewTask[];
    readonly witnesses: readonly LearningOverviewWitness[];
  };

export type LearningOverview = {
  readonly goal: LearningOverviewGoal;
  readonly tasks: LearningOverviewTasks;
  readonly witnesses: readonly LearningOverviewWitness[];
};

export type LearningOverviewRecipient = (fact: LearningOverviewFact) => boolean;

export const learningOverviewConsumerContract = {
  purpose: 'teaching',
  behavior: 'Current-revision reads require caller purpose and recipient permission; witnesses identify actual reads.',
  futureConsumers: ['today-learning-state', 'review', 'proposal'],
} as const;

export async function verifyWorkspaceEntry(
  ctx: CommandContext, id: FactId, entry: WorkspaceEntryFields, basis: readonly WorkspaceEntryBasis[],
): Promise<void> {
  const visited = new Set<string>();
  const visiting = new Set<string>([id]);
  async function visit(w: WorkspaceEntryBasis) {
    if (visiting.has(w.id)) throw new WorkspaceInputError('引用会形成循环。');
    const key = w.id + ':' + w.rev + ':' + w.epoch;
    if (visited.has(key)) return;
    if (visited.size + visiting.size > 1024 || visiting.size > 32) throw new WorkspaceInputError('依据清单太长。');
    const fact = await ctx.read.fact(w.id, {mode:'following'});
    if (fact.accessEpoch !== w.epoch || fact.ref.rev !== w.rev) throw new WorkspaceInputError('来源版本或用途已经变化，请重新读取。');
    if (fact.type === workspaceEntryType) {
      visiting.add(w.id);
      const dependency = workspaceEntry(fact.value);
      for (const source of dependency.basis) await visit(source);
      visiting.delete(w.id);
    }
    visited.add(key);
  }
  for (const witness of basis) await visit(witness);
  const sources = new Set(basis.map(w => w.id));
  let hasAttempt = false;
  for (const link of entry.links) {
    if (!sources.has(link)) throw new WorkspaceInputError('links 中的记录尚未读取。请用 read_workspace 打开要关联的 id，或从本轮新建条目的回执复制 id。');
    const fact = await ctx.read.fact(link, {mode:'following'});
    if (!workspaceShareableTypes.includes(fact.type)) throw new WorkspaceInputError('这条记录不能作为关联。');
    if (entry.kind === 'relation' && (fact.type !== workspaceEntryType || workspaceEntry(fact.value).kind !== 'concept'))
      throw new WorkspaceInputError('关系两端必须是两个概念。');
    hasAttempt ||= workspaceAttemptTypes.includes(fact.type);
  }
  if ((entry.kind === 'observation' || entry.kind === 'annotation') && !hasAttempt)
    throw new WorkspaceInputError('请在 links 中关联实际读取的原始作答。');
}
