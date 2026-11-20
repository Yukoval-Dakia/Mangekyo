import { confirmNotionRead, type CheckNotionRead } from './notion.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import {
  createCommandReadContext,
  FactNotFoundError,
  FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Json } from '../../kernel/src/declarations/types.ts';
import type { Db, ReadTransaction, SqlValue } from '../../kernel/src/db/types.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { materialType } from '../../modules/activity/library-values.ts';
import {
  activityQuestions, activityWorkspaceDisplay, cleanText, summary, type WorkspaceDisplay as Display,
} from '../../modules/activity/workspace-projection.ts';
import { goalType, studyGoal } from '../../modules/plan/goal-values.ts';
import { organizerNoteType } from '../../modules/activity/organizer-values.ts';
import { organizerTask, organizerTaskType } from '../../modules/plan/organizer-task-values.ts';
import { intakeFactType } from '../../modules/capture/intake-values.ts';
import { ridingPracticeType } from '../../modules/activity/practice-values.ts';
import { studyRecordType } from '../../modules/activity/values.ts';
import {
  WorkspaceInputError, workspaceEntryKinds as entryKinds, workspaceEntryType, setWorkspaceTeachingCommand,
} from '../../modules/activity/workspace-values.ts';
import {
  workbookAttemptType,
  workbookPaperType,
} from '../../modules/activity/workbook-values.ts';
import { notionModelRecipient, sourceId, stableId, studioLearner } from './identity.ts';
import { materialIntakeLink } from './reading.ts';
import { RequestError } from './sessions.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { carryRubricAssessments } from './learning-attempt-read.ts';
import { sourceRefV1 } from '../../modules/activity/source-values.ts';
import { knowledgeEdgeEvidenceType, knowledgeEdgeType } from '../../modules/content/knowledge-edge.ts';
import { parseTextbookPage, textbookPageType } from '../../modules/content/textbook-page.ts';
import { openKnowledgeEdge, openKnowledgeEdgeEvidence } from './knowledge-graph.ts';
import { resolveSource } from './source-read.ts';
import { workspaceQuery } from './workspace-read.ts';
import { lexicalWorkspaceSql, trigramFunction, workspaceOccurredAt } from './workspace-search.ts';
import {
  loadSettings,
  saveSettings,
  type ProviderProfile,
  type ProviderProtocol,
  type ProviderSettings,
} from './settings.ts';

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
  { id: 'textbook', label: '个人教材', types: [textbookPageType] },
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
  readonly credentialRevision?: string;
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

function textbookDisplay(value: unknown): Display {
  const { title, blocks } = parseTextbookPage(value);
  const text = blocks.flatMap(({ body }) => {
    switch (body.kind) {
      case 'text': return [body.text];
      case 'formula': return [body.latex];
      case 'table': return body.rows.map(row => row.join(' ｜ '));
      default: return [];
    }
  }).join('\n\n');
  return { title, text: cleanText(text), excerpt: summary(text), kind: 'page' };
}

export function displayOf(type: string, value: unknown): Display {
  try {
    if (type === textbookPageType) return textbookDisplay(value);
    if (type === goalType) return goalDisplay(value);
    if (type === organizerTaskType) return taskDisplay(value);
    const display = activityWorkspaceDisplay(type, value);
    if (display) return display;
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
  check: CheckNotionRead,
): Promise<AccessDisplay | null> {
  const purposes = purposesOf(row.purpose);
  const purpose = firstPurpose(row.purpose);
  if (!purpose) return null;
  try {
    const snapshot = await createCommandReadContext(tx, purpose).fact(factId(row.id), { mode: 'following' });
    if ([workspaceEntryType,textbookPageType].includes(row.type)) {
      const sources: FactSnapshot[] = [];
      if (!await resolveSource(tx,snapshot.ref.id,{recipient:'learner',track: fact => sources.push(fact)})) return null;
      for (const fact of sources) await check(fact);
    }
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
        ...(typeof route.credentialRevision === 'string' && providerIdentifier.test(route.credentialRevision)
          ? {credentialRevision: route.credentialRevision} : {}),
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

export function workspaceGrantRevision(routes: Readonly<Record<string, StoredRoute>>, provider: ProviderProfile) {
  const route = routes[provider.id];
  return route?.enabled && route.baseUrl === provider.baseUrl && route.protocol === provider.protocol &&
    provider.credentialRevision && route.credentialRevision === provider.credentialRevision ? route.revision : undefined;
}

function providerViews(settings: ProviderSettings, stored: StoredAccess): WorkspaceProviderView[] {
  return settings.providers.map(provider => {
    const {id, label, model, baseUrl, protocol} = provider;
    const route = stored.routes[id];
    const matches = Boolean(workspaceGrantRevision(stored.routes, provider));
    return {
      id, label, model, baseUrl, protocol,
      active: id === settings.activeProviderId,
      authorized: matches,
      ...(route?.enabled && !matches ? { authorizationStale: true } : {}),
    };
  });
}

export async function notionTeachingRecipients() {
  const [settings, stored] = await Promise.all([loadSettings(), readStored()]);
  return providerViews(settings,stored).filter(view => view.authorized).map(p => ({
    id:notionModelRecipient(p.id,p.baseUrl,p.protocol,p.model,stored.routes[p.id]!.revision),
    purpose:'teaching', label:p.label + ' · ' + p.model + ' · ' + p.baseUrl,
  }));
}

function saveWorkspaceAccessRoute(db: Db, input: unknown) {
  return db.tx({ learner: studioLearner }, async tx => {
    await lockLearner(tx, studioLearner);
    const value = object(input);
    if (!value || typeof value.enabled !== 'boolean') throw new RequestError(400, '授权设置无效。');
    if (typeof value.id !== 'string' || !providerIdentifier.test(value.id)) {
      throw new RequestError(400, '模型配置无效。');
    }
    if (typeof value.baseUrl !== 'string' || typeof value.protocol !== 'string') {
      throw new RequestError(400, '模型端点或协议无效。');
    }
    let settings = await loadSettings();
    let provider = settings.providers.find((entry) => entry.id === value.id);
    if (!provider) throw new RequestError(404, '找不到这个模型配置。');
    if (value.enabled && (value.baseUrl !== provider.baseUrl || value.protocol !== provider.protocol)) {
      throw new RequestError(409, '模型端点或协议已变化，请重新确认授权。');
    }
    if (value.enabled && !provider.credentialRevision) {
      // Stamp a legacy profile only at an explicit grant, under the same learner lock.
      await saveSettings({});
      settings = await loadSettings();
      provider = settings.providers.find(entry => entry.id === value.id)!;
    }
    const stored = await readStored();
    const previous = stored.routes[provider.id];
    const unchanged = previous?.enabled === value.enabled &&
      previous.baseUrl === provider.baseUrl &&
      previous.protocol === provider.protocol &&
      previous.credentialRevision === provider.credentialRevision;
    stored.routes[provider.id] = {
      enabled: value.enabled,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      revision: unchanged ? previous.revision : randomUUID(),
      ...(provider.credentialRevision ? {credentialRevision: provider.credentialRevision} : {}),
    };
    await writeStored(stored);
    return { providers: providerViews(settings, stored) };
  });
}

export function openWorkspaceAccess(db: Db, activity: LoadedModule, content: LoadedModule,
  capture: LoadedModule, plan: LoadedModule, onResearchChanged?: CommandHooks['onFactsChanged']) {
  const handle = createCommandHandler(db, {
    modules: [activity, content, capture, plan],
    hooks: createStudioCommandHooks({ async afterFactsChanged(tx, tick, changes) {
      await carryRubricAssessments(tx, tick, changes);
      await onResearchChanged?.(tx, tick, changes);
    } }),
    crossModuleWrites: {
      [setWorkspaceTeachingCommand]: { set_purpose: [materialType, intakeFactType, goalType, organizerTaskType] },
    },
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

    async undoObservation(id: string, input: Record<string, unknown>) {
      const token = input.undo_token;
      if (typeof token !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(token))
        throw new RequestError(400,'撤回凭据无效。');
      const {rowCount} = await db.query(
        `SELECT 1 FROM fact_revs r JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
         WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1 AND r.author='companion' AND c.id=$3
           AND c.type='activity.saveWorkspaceEntry' AND c.state='done' AND r.data->>'kind'='observation'`,
        [studioLearner,id,token]);
      if (!rowCount) throw new RequestError(404,'找不到可撤回的观察。');
      try {
        const receipt = await handle({learner:studioLearner,actor:'learner',purpose:'storage',
          id:commandId(stableId('withdraw-workspace-observation',token)),type:'activity.withdrawWorkspaceObservation',input:{id}});
        const ref = receipt.wrote[0];
        if (!ref) throw new RequestError(500,'撤回命令没有返回修订。');
        return {status:'withdrawn',ref:{id:ref.id,rev:ref.rev}};
      } catch (error) {
        if (error instanceof WorkspaceInputError || error instanceof FactReadDeniedError)
          throw new RequestError(409,'观察版本已变化。');
        throw error;
      }
    },

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
        confirmNotionRead(db, studioLearner, async (tx, check) => {
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
            const read = await readDisplay(tx, row, check);
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
        const record = await confirmNotionRead(db, studioLearner, async (tx, check) => {
          if (ref.fact.type === knowledgeEdgeType) return (await openKnowledgeEdge(tx, ref, { recipient: 'learner' }))?.value;
          if (ref.fact.type === knowledgeEdgeEvidenceType) return openKnowledgeEdgeEvidence(tx,ref,{recipient:'learner'});
          let root: FactSnapshot | undefined;
          const sources: FactSnapshot[] = [];
          const source = await resolveSource(tx, ref, { recipient: 'learner', track(fact) {
            sources.push(fact);
            if (fact.ref.id === ref.fact.id && fact.ref.rev === ref.fact.rev) root = fact;
          } });
          if (!source) return;
          for (const fact of sources) await check(fact);
          if (params.get('view') !== 'preview') return source;
          const {id, rev, sourceRef, title} = source;
          if (ref.anchor.kind === 'answer-slot') return {id, rev, sourceRef, title, content: null};
          if (ref.anchor.kind === 'question') return {id, rev, sourceRef, title, content: source.content};
          const prompt = root && ref.anchor.kind === 'whole' ? activityQuestions(root)?.map(({prompt}) => prompt).join('\n\n') : undefined;
          return prompt === undefined ? source : {id, rev, sourceRef, title, content: prompt};
        }).catch(error => {
          if (!(error instanceof FactReadDeniedError)) throw error;
        });
        if (!record) throw new RequestError(404, '找不到可读取的版本。');
        return record;
      }
      const offset = readOffset(params.get('offset'));
      const limit = readLimit(params.get('limit'), defaultTextChunk, maximumTextChunk);
      return confirmNotionRead(db, studioLearner, async (tx, check) => {
        const row = await currentRow(tx, itemId);
        if (!row || !allowedTypes.has(row.type) ||
          (row.type === studyRecordType && syntheticStudyRecords.has(row.id))) {
          throw new RequestError(404, '找不到这条学习记录。');
        }
        const read = await readDisplay(tx, row, check);
        if (!read) throw new RequestError(403, '这条学习记录当前不可读取。');
        const item = itemOf(row, read);
        const start = Math.min(offset, read.display.text.length);
        const end = Math.min(start + limit, read.display.text.length);
        const related: {id:string;title:string}[] = [];
        for (const linkedId of read.display.links ?? []) {
          const linked = await currentRow(tx,factId(linkedId));
          if (!linked || !allowedTypes.has(linked.type) || syntheticStudyRecords.has(linkedId)) continue;
          const target = await readDisplay(tx,linked,check);
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
      const use = value.purpose === undefined ? 'teaching' : value.purpose;
      if (use !== 'teaching' && use !== 'background-research') throw new RequestError(400, '记录用途无效。');
      if (typeof value.expectedRev !== 'number' || !Number.isSafeInteger(value.expectedRev) ||
          value.expectedRev < 1) {
        throw new RequestError(400, '记录版本无效。');
      }
      const expectedRev = value.expectedRev;
      const enabled = value.enabled;
      const {row, link} = await db.snapshot({ learner: studioLearner }, async tx => {
        const row = await currentRow(tx, itemId);
        return {row, link: use === 'teaching' && row?.type === materialType ? await materialIntakeLink(tx, itemId) : undefined};
      });
      if (!row || !allowedTypes.has(row.type) ||
        (row.type === studyRecordType && syntheticStudyRecords.has(row.id))) {
        throw new RequestError(404, '找不到这条学习记录。');
      }
      if (use === 'background-research' && ![textbookPageType, workbookPaperType, workspaceEntryType].includes(row.type))
        throw new RequestError(400, '请选择教材、试卷或来源题。');
      if (row.current_rev !== expectedRev) {
        throw new RequestError(409, '这条记录已在别处更新。请刷新后再试。');
      }
      if (link && !link.matches) throw new RequestError(409, '材料与交入记录不匹配。');
      const purposes = purposesOf(row.purpose);
      if (purposes.includes('all')) throw new RequestError(409, '这条记录已设置为全部用途。');
      const flags = use === 'teaching' ? {teaching: enabled} :
        {teaching: purposes.includes('teaching'), research: enabled};
      if (purposes.includes(use) === enabled && (!link || link.purpose.includes(use) === enabled))
        return { id: row.id, rev: row.current_rev, ...flags, changed: false };
      const purpose = purposes[0];
      if (!purpose) throw new RequestError(409, '这条记录当前没有可用的读取用途。');
      try {
        const receipt = await handle({
          learner: studioLearner,
          actor: 'learner',
          purpose,
          type: row.type === textbookPageType
            ? use === 'teaching' ? 'content.setTextbookTeaching' : 'content.setTextbookResearch'
            : setWorkspaceTeachingCommand,
          id: commandId(stableId('workspace-' + use, itemId, String(expectedRev), String(enabled))),
          input: { id: itemId, expectedRev, enabled, ...(use === 'background-research' && row.type !== textbookPageType ? {use} : {}), ...(link ? { intakeId: link.id } : {}) } as Json,
        });
        const ref = receipt.wrote.find((written) => written.id === row.id);
        const paired = link && receipt.wrote.some(written => written.id === link.id);
        if (!ref && !paired) throw new RequestError(500, '这次设置没有返回记录。');
        return { id: row.id, rev: ref?.rev ?? row.current_rev, ...flags, changed: true };
      } catch (error) {
        throw translate(error);
      }
    },

    providers: providerList,

    async setProvider(id: string, input: unknown) {
      if (!providerIdentifier.test(id)) throw new RequestError(400, '模型配置无效。');
      const value = object(input);
      return saveWorkspaceAccessRoute(db, { ...(value ?? {}), id });
    },
  };
}
