import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import {
  createCommandReadContext,
  FactNotFoundError,
  FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Json } from '../../kernel/src/declarations/types.ts';
import type { Db, ReadTransaction, SqlValue } from '../../kernel/src/db/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { goalType, materialType, studyGoal, textMaterial } from '../../modules/activity/library-values.ts';
import { organizerNote, organizerNoteType, organizerTask, organizerTaskType } from '../../modules/activity/organizer-values.ts';
import { practiceSubmission, ridingPracticeType } from '../../modules/activity/practice-values.ts';
import { studyRecord } from '../../modules/activity/values.ts';
import {
  workspaceEntry, workspaceEntryKinds as entryKinds, workspaceEntryType, setWorkspaceTeachingCommand,
} from '../../modules/activity/workspace-values.ts';
import {
  workbookAttempt,
  workbookAttemptType,
  workbookPaper,
  workbookPaperType,
  type WorkbookExpected,
} from '../../modules/activity/workbook-values.ts';
import { sourceId, stableId, studioLearner } from './identity.ts';
import { materialIntakeLink } from './reading.ts';
import { RequestError } from './sessions.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { carryRubricAssessments } from './learning-attempt-read.ts';
import { sourceRefV1 } from '../../modules/activity/source-values.ts';
import { knowledgeEdgeType } from '../../modules/content/knowledge-edge.ts';
import { openKnowledgeEdge } from './knowledge-graph.ts';
import { resolveSource } from './source-read.ts';
import { workspaceQuery } from './workspace-read.ts';
import { lexicalWorkspaceSql, trigramFunction, workspaceOccurredAt } from './workspace-search.ts';
import {
  loadSettings,
  type ProviderProtocol,
  type ProviderSettings,
} from './settings.ts';

const studyRecordType = 'activity.studyRecord';
const providerIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const factIdentifier = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const maximumPage = 50;
const defaultPage = 20;
const maximumTextChunk = 12_000;
const defaultTextChunk = 6_000;

type EntryKind = typeof entryKinds[number];

type AccessCategory = {
  readonly id: string;
  readonly label: string;
  readonly types: readonly string[];
};
const categories: readonly AccessCategory[] = [
  { id: 'practice', label: '练习', types: [ridingPracticeType] },
  { id: 'paper', label: '试卷', types: [workbookPaperType] },
  { id: 'attempt', label: '作答', types: [workbookAttemptType] },
  { id: 'note', label: '笔记', types: [organizerNoteType] },
  { id: 'material', label: '材料', types: [materialType] },
  { id: 'record', label: '学习记录', types: [studyRecordType] },
  { id: 'goal', label: '目标', types: [goalType] },
  { id: 'task', label: '任务', types: [organizerTaskType] },
  { id: 'entry', label: '生成条目', types: [workspaceEntryType] },
];
const allowedTypes = new Set(categories.flatMap((category) => category.types));
export const syntheticStudyRecords = new Set<string>([
  sourceId('independent', 'work-01'),
  sourceId('independent', 'work-02'),
  sourceId('workedExample', 'work-01'),
  sourceId('workedExample', 'work-02'),
]);

type AccessRow = {
  readonly id: string;
  readonly type: string;
  readonly current_rev: number;
  readonly purpose: unknown;
  readonly created_tick: string | number | bigint;
  readonly author: string;
};

type Display = {
  readonly title: string;
  readonly excerpt: string;
  readonly text: string;
  readonly kind?: EntryKind;
  readonly links?: readonly string[];
  readonly tags?: readonly string[];
  readonly question?: {prompt:string; answer?:string; rubric?:string};
};

type AccessItem = {
  readonly id: string;
  readonly rev: number;
  readonly type: string;
  readonly category: string;
  readonly kind?: EntryKind;
  readonly title: string;
  readonly excerpt: string;
  readonly occurredAt: string | null;
  readonly tags: readonly string[];
  readonly author: string;
  readonly teaching: boolean;
  readonly eligible: boolean;
  readonly purposes: readonly string[];
};

type Cursor = { readonly tick: string; readonly id: string };

type StoredRoute = {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly protocol: ProviderProtocol;
  readonly revision: string;
};
type StoredAccess = {
  readonly version: 1;
  readonly routes: Record<string, StoredRoute>;
};

export type WorkspaceProviderView = {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly protocol: ProviderProtocol;
  readonly active: boolean;
  readonly authorized: boolean;
  readonly authorizationStale?: boolean;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: string, limit?: number): string {
  return value.replace(/\u0000/g, '').slice(0, limit);
}

function summary(value: string, limit = 240): string {
  const compact = cleanText(value).replace(/\s+/g, ' ').trim();
  return compact.length > limit ? compact.slice(0, limit) + '…' : compact;
}

function purposesOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    return [];
  }
  return [...new Set(value)];
}

function categoryOfType(type: string) {
  return categories.find((category) => category.types.includes(type));
}

function categoryOf(value: string | null): AccessCategory | undefined {
  if (!value || value === 'all') return undefined;
  const category = categories.find((entry) => entry.id === value);
  if (!category) throw new RequestError(400, '学习记录分类无效。');
  return category;
}

function readLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null || value === '') return fallback;
  if (!/^[1-9][0-9]{0,5}$/.test(value)) throw new RequestError(400, '分页数量无效。');
  return Math.min(Number(value), maximum);
}

function readOffset(value: string | null): number {
  if (value === null || value === '') return 0;
  if (!/^(?:0|[1-9][0-9]{0,7})$/.test(value)) throw new RequestError(400, '内容位置无效。');
  return Number(value);
}

function readSearch(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 120 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new RequestError(400, '搜索词无效。');
  }
  return trimmed;
}

function encodeCursor(row: AccessRow): string {
  return Buffer.from(JSON.stringify([String(row.created_tick), row.id]), 'utf8').toString('base64url');
}

function decodeCursor(value: string | null): Cursor | undefined {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(value)) throw new RequestError(400, '分页位置无效。');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error();
    const [tick, id] = parsed;
    if (typeof tick !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(tick)) throw new Error();
    if (typeof id !== 'string' || !factIdentifier.test(id)) throw new Error();
    return { tick, id };
  } catch {
    throw new RequestError(400, '分页位置无效。');
  }
}

function authorOf(value: string): string {
  if (value === 'learner' || value === 'companion') return value;
  return 'unknown';
}

function expectedText(expected: WorkbookExpected): string {
  if (expected.kind === 'numeric') {
    return String(expected.value) + (expected.unit ? ' ' + expected.unit : '') +
      '（容差 ' + String(expected.tolerance) + '）';
  }
  if (expected.kind === 'exact') return expected.values.join(' / ');
  return '评分标准：' + expected.rubric;
}

function practiceDisplay(value: unknown): Display {
  const practice = practiceSubmission(value);
  const questions = practice.paper.questions.map((question, index) =>
    String(index + 1) + '. ' + question.prompt + (question.unit ? '（' + question.unit + '）' : '')
  ).join('\n');
  const feedback = practice.feedback.map((item, index) =>
    String(index + 1) + '. ' + item.result +
    '\n   我的作答：' + (item.answer === null ? '未作答' : String(item.answer)) +
    '\n   参考答案：' + String(item.expected) +
    '\n   说明：' + item.explanation
  ).join('\n');
  const text = practice.paper.title + '\n\n' + questions + '\n\n本次反馈\n' + feedback;
  return { title: practice.paper.title, excerpt: summary(questions), text: cleanText(text) };
}

function paperDisplay(value: unknown): Display {
  const paper = workbookPaper(value);
  const questions = paper.questions.map((question, index) => {
    const head = String(index + 1) + '. ' + question.prompt;
    if (question.kind === 'numeric') {
      return head + '\n   答案：' + String(question.answer) + (question.unit ? ' ' + question.unit : '') +
        '\n   容差：' + String(question.tolerance);
    }
    if (question.kind === 'exact') return head + '\n   答案：' + question.answers.join(' / ');
    return head + '\n   评分标准：' + question.rubric;
  }).join('\n');
  const source = paper.materialId ? '\n来源材料：' + paper.materialId : '';
  const text = paper.title + '\n保存于：' + paper.savedAt + source + '\n\n' + questions;
  return { title: paper.title, excerpt: summary(questions), text: cleanText(text) };
}

function attemptDisplay(value: unknown): Display {
  const attempt = workbookAttempt(value);
  const questions = attempt.paper.questions.map((question, index) => {
    const feedback = attempt.feedback.find((item) => item.questionId === question.id);
    const answer = attempt.answers[question.id];
    return String(index + 1) + '. ' + question.prompt +
      '\n   我的作答：' + (answer === null || answer === undefined ? '未作答' : String(answer)) +
      (feedback ? '\n   反馈：' + feedback.result +
        '\n   参考答案：' + expectedText(feedback.expected) +
        (feedback.explanation ? '\n   说明：' + feedback.explanation : '') : '');
  }).join('\n');
  const title = attempt.paper.title;
  return {
    title,
    excerpt: summary('提交于 ' + attempt.submittedAt + ' · ' + attempt.feedback.length + ' 题'),
    text: cleanText(title + '\n提交于：' + attempt.submittedAt + '\n\n' + questions),
  };
}

function noteDisplay(value: unknown): Display {
  const note = organizerNote(value);
  const source = note.source ? '\n来源材料：' + note.source.title + '（' + note.source.id + '）' : '';
  return {
    title: note.title,
    excerpt: summary(note.markdown),
    text: cleanText(note.title + source + '\n\n' + note.markdown),
  };
}

function materialDisplay(value: unknown): Display {
  const material = textMaterial(value);
  return {
    title: material.title,
    excerpt: summary(material.text),
    text: cleanText(material.title + '\n\n' + material.text),
  };
}

function studyRecordDisplay(value: unknown): Display {
  const record = studyRecord(value);
  return {
    title: record.title,
    excerpt: summary(record.text),
    text: cleanText(record.title + '\n\n' + record.text),
  };
}

function goalDisplay(value: unknown): Display {
  const goal = studyGoal(value);
  if (goal.text === null) {
    return { title: '未设置目标', excerpt: '当前没有学习目标。', text: '当前没有学习目标。' };
  }
  return { title: '学习目标', excerpt: summary(goal.text), text: cleanText(goal.text) };
}

function taskDisplay(value: unknown): Display {
  const task = organizerTask(value);
  const status = task.done ? '已完成' : '未完成';
  const text = task.title + '\n日期：' + task.date + '\n状态：' + status;
  return { title: task.title, excerpt: status + ' · ' + task.date, text: cleanText(text) };
}

function entryDisplay(value: unknown): Display {
  const {kind,title,body,tags,links,answer,rubric} = workspaceEntry(value);
  const details = [
    body,
    answer ? '参考答案\n' + answer : '',
    rubric ? '评分标准\n' + rubric : '',
    tags.length ? '标签：' + tags.join('、') : '',
    links.length ? '关联：' + links.join('、') : '',
  ].filter(Boolean).join('\n\n');
  return {
    title,
    excerpt: summary(body || details || kind),
    text: cleanText(title + '\n类型：' + kind + '\n\n' + details),
    kind,
    links,
    tags,
    ...(kind === 'question' ? {question:{prompt:body, ...(answer ? {answer} : {}), ...(rubric ? {rubric} : {})}} : {}),
  };
}

function fixedQuestionPreview(fact: FactSnapshot): string | undefined {
  const prompts = (questions: readonly {prompt: string}[]) => questions.map(({prompt}) => prompt).join('\n\n');
  switch (fact.type) {
    case workspaceEntryType: {
      const entry = workspaceEntry(fact.value);
      return entry.kind === 'question' ? entry.body : undefined;
    }
    case workbookPaperType: return prompts(workbookPaper(fact.value).questions);
    case workbookAttemptType: return prompts(workbookAttempt(fact.value).paper.questions);
    case ridingPracticeType: return prompts(practiceSubmission(fact.value).paper.questions);
    default: return undefined;
  }
}

export function displayOf(type: string, value: unknown): Display {
  try {
    if (type === ridingPracticeType) return practiceDisplay(value);
    if (type === workbookPaperType) return paperDisplay(value);
    if (type === workbookAttemptType) return attemptDisplay(value);
    if (type === organizerNoteType) return noteDisplay(value);
    if (type === materialType) return materialDisplay(value);
    if (type === studyRecordType) return studyRecordDisplay(value);
    if (type === goalType) return goalDisplay(value);
    if (type === organizerTaskType) return taskDisplay(value);
    if (type === workspaceEntryType) return entryDisplay(value);
  } catch {
    // A malformed legacy fact must not make the learner's whole access page disappear.
  }
  return {
    title: '无法显示的记录',
    excerpt: '这条记录的格式暂时无法显示，但不会被提供给模型。',
    text: '这条记录的格式暂时无法显示。',
  };
}

function firstPurpose(value: unknown): string | undefined {
  return purposesOf(value)[0];
}

type AccessDisplay = { display: Display; purposes: readonly string[]; fact: FactSnapshot };

async function readDisplay(
  tx: ReadTransaction,
  row: AccessRow,
): Promise<AccessDisplay | null> {
  const purposes = purposesOf(row.purpose);
  const purpose = firstPurpose(row.purpose);
  if (!purpose) return null;
  try {
    const snapshot = await createCommandReadContext(tx, purpose).fact(factId(row.id), { mode: 'following' });
    return { display: displayOf(row.type, snapshot.value), purposes, fact: snapshot };
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return null;
    throw error;
  }
}

function itemOf(row: AccessRow, {display, purposes, fact}: AccessDisplay): AccessItem {
  const category = categoryOfType(row.type);
  return {
    id: row.id,
    rev: row.current_rev,
    type: row.type,
    category: category?.id ?? 'other',
    ...(display.kind ? { kind: display.kind } : {}),
    title: display.title,
    excerpt: display.excerpt,
    occurredAt: workspaceOccurredAt(fact),
    tags: display.tags ?? [],
    author: authorOf(row.author),
    teaching: purposes.includes('teaching') || purposes.includes('all'),
    eligible: !purposes.includes('all'),
    purposes,
  };
}

async function currentRow(tx: ReadTransaction, id: FactId): Promise<AccessRow | null> {
  const { rows } = await tx.query<AccessRow>(
    `SELECT f.id, f.type, f.current_rev, f.purpose, f.created_tick, born.author
     FROM facts f
     JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev
     JOIN fact_revs born ON born.learner_id=f.learner_id AND born.fact_id=f.id AND born.rev=1
     WHERE f.learner_id=$1 AND f.id=$2 AND f.retracted_rev IS NULL`,
    [tx.learner, id],
  );
  return rows[0] ?? null;
}

function requireFactId(value: string): FactId {
  if (!factIdentifier.test(value)) throw new RequestError(404, '找不到这条学习记录。');
  return factId(value);
}

function translate(error: unknown): Error {
  if (error instanceof RequestError) return error;
  if (error instanceof FactNotFoundError) return new RequestError(404, '找不到这条学习记录。');
  if (error instanceof FactReadDeniedError) return new RequestError(403, '这条学习记录当前不可读取。');
  if (error instanceof Error) {
    if (error.message.startsWith('Unknown command:')) {
      return new RequestError(503, '当前服务还不支持开放学习记录。');
    }
    if (error.message === 'Command ID already used with a different command identity') {
      return new RequestError(409, '同一个请求已经用于不同内容。');
    }
    if (error.message.startsWith('Fact revision conflict:')) {
      return new RequestError(409, '这条记录已在别处更新。请刷新后再试。');
    }
    if (error.message.startsWith('Fact does not exist:')) {
      return new RequestError(404, '找不到这条学习记录。');
    }
    if (error.message.startsWith('Fact is retracted:')) {
      return new RequestError(409, '这条记录已经撤回。');
    }
  }
  return new RequestError(400, '学习记录设置未能完成。');
}

function accessFile() {
  return process.env.MANGEKYO_WORKSPACE_ACCESS_FILE ||
    join(homedir(), '.config', 'mangekyo', 'workspace-access.json');
}

function defaultStored(): StoredAccess {
  return { version: 1, routes: {} };
}

function normalizeStored(value: unknown): StoredAccess {
  const input = object(value);
  if (!input) throw new Error('学习记录访问设置无效。');
  const rawRoutes = object(input.routes);
  const routes: Record<string, StoredRoute> = {};
  if (rawRoutes) {
    for (const [id, raw] of Object.entries(rawRoutes)) {
      if (!providerIdentifier.test(id)) continue;
      const route = object(raw);
      if (!route || typeof route.enabled !== 'boolean') continue;
      if (typeof route.baseUrl !== 'string' || route.baseUrl.length > 2000 || /[\u0000-\u001f\u007f]/.test(route.baseUrl)) continue;
      if (route.protocol !== 'openai' && route.protocol !== 'anthropic') continue;
      if (typeof route.revision !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(route.revision)) continue;
      routes[id] = {
        enabled: route.enabled,
        baseUrl: route.baseUrl,
        protocol: route.protocol,
        revision: route.revision,
      };
    }
  }
  return { version: 1, routes };
}

async function readStored(): Promise<StoredAccess> {
  try {
    return normalizeStored(JSON.parse(await readFile(accessFile(), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultStored();
    throw error;
  }
}

async function writeStored(access: StoredAccess) {
  const file = accessFile();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID();
  try {
    await writeFile(temp, JSON.stringify(access), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function loadWorkspaceAccessRoutes(): Promise<Readonly<Record<string, StoredRoute>>> {
  return (await readStored()).routes;
}

function providerViews(settings: ProviderSettings, stored: StoredAccess): WorkspaceProviderView[] {
  return settings.providers.map((provider) => {
    const route = stored.routes[provider.id];
    const matches = Boolean(
      route?.enabled &&
      route.baseUrl === provider.baseUrl &&
      route.protocol === provider.protocol,
    );
    return {
      id: provider.id,
      label: provider.label,
      model: provider.model,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      active: provider.id === settings.activeProviderId,
      authorized: matches,
      ...(route?.enabled && !matches ? { authorizationStale: true } : {}),
    };
  });
}

let updating: Promise<unknown> = Promise.resolve();
export function saveWorkspaceAccessRoute(input: unknown) {
  const update = updating.then(async () => {
    const value = object(input);
    if (!value || typeof value.enabled !== 'boolean') throw new RequestError(400, '授权设置无效。');
    if (typeof value.id !== 'string' || !providerIdentifier.test(value.id)) {
      throw new RequestError(400, '模型配置无效。');
    }
    if (typeof value.baseUrl !== 'string' || typeof value.protocol !== 'string') {
      throw new RequestError(400, '模型端点或协议无效。');
    }
    const settings = await loadSettings();
    const provider = settings.providers.find((entry) => entry.id === value.id);
    if (!provider) throw new RequestError(404, '找不到这个模型配置。');
    if (value.enabled && (value.baseUrl !== provider.baseUrl || value.protocol !== provider.protocol)) {
      throw new RequestError(409, '模型端点或协议已变化，请重新确认授权。');
    }
    const stored = await readStored();
    const previous = stored.routes[provider.id];
    const unchanged = previous?.enabled === value.enabled &&
      previous.baseUrl === provider.baseUrl &&
      previous.protocol === provider.protocol;
    stored.routes[provider.id] = {
      enabled: value.enabled,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      revision: unchanged ? previous.revision : randomUUID(),
    };
    await writeStored(stored);
    return { providers: providerViews(settings, stored) };
  });
  updating = update.catch(() => {});
  return update;
}

export function openWorkspaceAccess(db: Db, activity: LoadedModule) {
  const handle = createCommandHandler(db, {
    modules: [activity],
    hooks: createStudioCommandHooks({ afterFactsChanged: carryRubricAssessments }),
  });

  async function providerList() {
    const [settings, stored] = await Promise.all([loadSettings(), readStored()]);
    return {
      activeProviderId: settings.activeProviderId,
      providers: providerViews(settings, stored),
    };
  }

  return {
    categories: categories.map(({ id, label }) => ({ id, label })),

    async list(params: URLSearchParams) {
      if (params.has('conceptId') || params.has('since') || params.has('exposureFilter') || params.has('tags') || params.has('kinds')) {
        const args: Record<string, unknown> = Object.fromEntries(params);
        for (const name of ['tags', 'kinds', 'edgeKinds']) {
          if (params.has(name)) args[name] = params.getAll(name);
        }
        if (params.has('hops')) args.hops = Number(params.get('hops'));
        const result = await db.snapshot({ learner: studioLearner }, tx => workspaceQuery(tx, args, { recipient: 'learner' }));
        if (!result) throw new RequestError(404, '找不到可读取的记录。');
        if ('error' in result) throw new RequestError(400, result.error);
        return { ...result, items: result.results };
      }
      const limit = readLimit(params.get('limit'), defaultPage, maximumPage);
      const cursor = decodeCursor(params.get('cursor'));
      const category = categoryOf(params.get('category'));
      const kind = params.get('kind');
      if (kind && !entryKinds.some(item => item === kind)) throw new RequestError(400,'工作区条目类型无效。');
      const query = readSearch(params.get('query'));
      const types = category ? [...category.types] : [...allowedTypes];
      const [result, providers] = await Promise.all([
        db.snapshot({ learner: studioLearner }, async (tx) => {
          const where = [
            'f.learner_id=$1',
            'f.retracted_rev IS NULL',
            'f.type = ANY($2::text[])',
            'NOT (f.type=$3 AND f.id = ANY($4::text[]))',
          ];
          const values: SqlValue[] = [tx.learner, types, studyRecordType, [...syntheticStudyRecords]];
          if (kind) {
            values.push(workspaceEntryType,kind);
            where.push('f.type=$5 AND r.data->>\'kind\'=$6');
          }
          const trigram = query ? await trigramFunction(tx) : undefined;
          if (query) {
            values.push(query);
            const { fts, score } = lexicalWorkspaceSql(values.length, trigram);
            where.push(`(${fts} OR ${score}>=0.45)`);
          }
          if (cursor) {
            values.push(cursor.tick, cursor.id);
            where.push(
              '(f.created_tick, f.id) < ($' + String(values.length - 1) + '::bigint, $' +
              String(values.length) + '::text)',
            );
          }
          values.push(limit + 1);
          const { rows } = await tx.query<AccessRow>(
            `SELECT f.id, f.type, f.current_rev, f.purpose, f.created_tick, born.author
             FROM facts f
             JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev
             JOIN fact_revs born ON born.learner_id=f.learner_id AND born.fact_id=f.id AND born.rev=1
             WHERE ${where.join(' AND ')}
             ORDER BY f.created_tick DESC, f.id DESC
             LIMIT $${String(values.length)}`,
            values,
          );
          const visible: { row: AccessRow; read: AccessDisplay }[] = [];
          for (const row of rows.slice(0, limit)) {
            const read = await readDisplay(tx, row);
            if (read) visible.push({ row, read });
          }
          return { rows: visible, last:rows.slice(0,limit).at(-1), hasMore: rows.length > limit,
            trigramUnavailable: Boolean(query && !trigram) };
        }),
        providerList(),
      ]);
      const items = result.rows.map(({ row, read }) => itemOf(row, read));
      const last = result.last;
      return {
        items,
        unappliedFilters: [],
        ...(result.trigramUnavailable ? {retrievalWarnings:['pg_trgm_unavailable']} : {}),
        nextCursor: result.hasMore && last ? encodeCursor(last) : null,
        categories: categories.map(({ id, label }) => ({ id, label })),
        ...providers,
      };
    },

    async record(id: string, params: URLSearchParams) {
      const itemId = requireFactId(id);
      const rawRef = params.get('ref');
      if (rawRef !== null) {
        let input: unknown;
        try { input = JSON.parse(rawRef); }
        catch { throw new RequestError(400, '工作区版本引用无效。'); }
        const ref = sourceRefV1(input);
        if (ref?.fact.id !== itemId) throw new RequestError(400, '工作区版本引用无效。');
        const record = await db.snapshot({ learner: studioLearner }, async tx => {
          if (ref.fact.type === knowledgeEdgeType) return (await openKnowledgeEdge(tx, ref, { recipient: 'learner' }))?.value;
          if (params.get('view') !== 'preview') return resolveSource(tx, ref, { recipient: 'learner' });
          let root: FactSnapshot | undefined;
          const source = await resolveSource(tx, ref, { recipient: 'learner', track(fact) {
            if (fact.ref.id === ref.fact.id && fact.ref.rev === ref.fact.rev) root = fact;
          } });
          if (!source) return;
          if (ref.anchor.kind === 'answer-slot') return { ...source, content: null };
          const prompt = root && ref.anchor.kind === 'whole' ? fixedQuestionPreview(root) : undefined;
          return prompt === undefined ? source : { ...source, content: prompt };
        });
        if (!record) throw new RequestError(404, '找不到可读取的版本。');
        return record;
      }
      const offset = readOffset(params.get('offset'));
      const limit = readLimit(params.get('limit'), defaultTextChunk, maximumTextChunk);
      return db.snapshot({ learner: studioLearner }, async (tx) => {
        const row = await currentRow(tx, itemId);
        if (!row || !allowedTypes.has(row.type) ||
          (row.type === studyRecordType && syntheticStudyRecords.has(row.id))) {
          throw new RequestError(404, '找不到这条学习记录。');
        }
        const read = await readDisplay(tx, row);
        if (!read) throw new RequestError(403, '这条学习记录当前不可读取。');
        const item = itemOf(row, read);
        const start = Math.min(offset, read.display.text.length);
        const end = Math.min(start + limit, read.display.text.length);
        const related: {id:string;title:string}[] = [];
        for (const linkedId of read.display.links ?? []) {
          const linked = await currentRow(tx,factId(linkedId));
          if (!linked || !allowedTypes.has(linked.type) || syntheticStudyRecords.has(linkedId)) continue;
          const target = await readDisplay(tx,linked);
          if (target) related.push({id:linkedId,title:target.display.title});
        }
        return {
          ...item,
          related,
          ...(read.display.question ? {question:read.display.question} : {}),
          text: read.display.text.slice(start, end),
          offset: start,
          nextOffset: end < read.display.text.length ? end : null,
        };
      });
    },

    async setTeaching(id: string, input: unknown) {
      const itemId = requireFactId(id);
      const value = object(input);
      if (!value || typeof value.enabled !== 'boolean') throw new RequestError(400, '开放设置无效。');
      if (typeof value.expectedRev !== 'number' || !Number.isSafeInteger(value.expectedRev) ||
          value.expectedRev < 1) {
        throw new RequestError(400, '记录版本无效。');
      }
      const expectedRev = value.expectedRev;
      const enabled = value.enabled;
      const {row, link} = await db.snapshot({ learner: studioLearner }, async tx => {
        const row = await currentRow(tx, itemId);
        return {row, link: row?.type === materialType ? await materialIntakeLink(tx, itemId) : undefined};
      });
      if (!row || !allowedTypes.has(row.type) ||
        (row.type === studyRecordType && syntheticStudyRecords.has(row.id))) {
        throw new RequestError(404, '找不到这条学习记录。');
      }
      if (row.current_rev !== expectedRev) {
        throw new RequestError(409, '这条记录已在别处更新。请刷新后再试。');
      }
      if (link && !link.matches) throw new RequestError(409, '材料与交入记录不匹配。');
      const purposes = purposesOf(row.purpose);
      if (purposes.includes('all')) throw new RequestError(409, '这条记录已设置为全部用途。');
      if (purposes.includes('teaching') === enabled && (!link || link.purpose.includes('teaching') === enabled)) {
        return { id: row.id, rev: row.current_rev, teaching: enabled, changed: false };
      }
      const purpose = purposes[0];
      if (!purpose) throw new RequestError(409, '这条记录当前没有可用的读取用途。');
      try {
        const receipt = await handle({
          learner: studioLearner,
          actor: 'learner',
          purpose,
          type: setWorkspaceTeachingCommand,
          id: commandId(stableId('workspace-teaching', itemId, String(expectedRev), String(enabled))),
          input: { id: itemId, expectedRev, enabled, ...(link ? { intakeId: link.id } : {}) } as Json,
        });
        const ref = receipt.wrote.find((written) => written.id === row.id);
        const paired = link && receipt.wrote.some(written => written.id === link.id);
        if (!ref && !paired) throw new RequestError(500, '这次设置没有返回记录。');
        return { id: row.id, rev: ref?.rev ?? row.current_rev, teaching: enabled, changed: true };
      } catch (error) {
        throw translate(error);
      }
    },

    providers: providerList,

    async setProvider(id: string, input: unknown) {
      if (!providerIdentifier.test(id)) throw new RequestError(400, '模型配置无效。');
      const value = object(input);
      return saveWorkspaceAccessRoute({ ...(value ?? {}), id });
    },
  };
}
