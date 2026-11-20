import type { WorkspaceWriteReceipt } from '../../executors/teaching/workspace-tools.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { createCommandHandler, readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { factId, commandId } from '../../kernel/src/declarations/ids.ts';
import { requestWork } from '../../kernel/src/work/index.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { first45Answer, first45Histories, first45Question } from '../../executors/teaching/examples.ts';
import type {WorkspaceWitness} from './workspace-agent.ts';
import { turnTask } from './model-routes.ts';
import { sameRoute, resolveMcpGrants, workspaceRouteRevision, workspaceGrantChecker, routeMatchesInput, mcpRevision } from './harness.ts';
import { studyAttachment, studyCurrentObjectSelection, studyMcpGrants, studyTurn, turnResearchPurpose, type StudyCurrentObjectSelection } from '../../modules/activity/values.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { readMaterialText } from './reading.ts';
import type { StudyKit } from '../../executors/teaching/study-kit.ts';
import type { RecallHttp } from './recall-http.ts';
import { loadSettings } from './settings.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import type { ForegroundDigest } from './foreground-digest.ts';
import { areMemoryClaimsCurrent, recoverTurnMemoryReceipts, teachingMemoryBasis } from './memory-claims.ts';
import { currentObjectAlias, readCurrentLearningObject } from './current-learning-object.ts';
import {
  stableId,
  sourceId,
  studioLearner,
  firstTurn,
  nextTurn,
  requestCommand,
  purpose,
  methodName,
  slotType,
  textbookUndoId,
} from './identity.ts';

import {turnArtifacts} from './presentation-store.ts';

export class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const cases = [
  {
    id: 'independent',
    title: '学习史一',
    description: '第一次见到分段行程题时，留下过自己的完整草稿。',
    question: first45Question,
    initialAnswer: first45Answer,
  },
  {
    id: 'workedExample',
    title: '学习史二',
    description: '过去做过同一道分段行程题，当时看过完整例题。',
    question: first45Question,
    initialAnswer: first45Answer,
  },
] as const;
export type CaseId = (typeof cases)[number]['id'] | 'companion' | 'riding';
export function caseId(value: unknown): CaseId {
  if (value !== 'independent' && value !== 'workedExample' && value !== 'companion' && value !== 'riding')
    throw new RequestError(400, '对话类型无效。');
  return value;
}
export function clientRequest(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value))
    throw new RequestError(400, '请求标识无效。');
  return value;
}
export type DisplayTurn = {
  studyKit?: StudyKit;
  trace?: string[];
  completion?: 'receipts_only';
  writes?: WorkspaceWriteReceipt[];
  workspaceBasis?: WorkspaceWitness[];
  learningMemoryDigest?: string;
  memoryManagement?: true;
  foregroundDigest?: ForegroundDigest;
  action: string;
  rationale: string;
  message: string;
  model: string;
  reasoningEffort?: string;
  evidenceIds: readonly string[];
  reportedModel?: string;
  reads: readonly { id: string; title: string; text: string }[];
  answer?: string;
};
type Status = 'pending' | 'ready' | 'failed' | 'unknown';
export const turnResearchAccess = (fact: FactSnapshot) => ({
  allowed: fact.purpose.includes(turnResearchPurpose), rev: fact.ref.rev, accessEpoch: fact.accessEpoch,
});
export const unavailableReplyMessage = '本轮已完成，依据已变更，旧回复已隐藏。';
const unavailableReply = (model: string): DisplayTurn => ({action: 'reply_unavailable', model,
  rationale: '', message: unavailableReplyMessage, reads: [], evidenceIds: []});
type TurnView = {
  id: string;
  submission: ReturnType<typeof studyTurn>;
  backgroundUnderstanding?: ReturnType<typeof turnResearchAccess>;
  feedback: DisplayTurn | null;
  derivationId: string | null;
  status: Status;
  error?: string;
};
export async function readOwnStudyTurn(tx: ReadTransaction, id: string) {
  const open = (use: string) => createCommandReadContext(tx, use).fact(factId(id), {mode: 'following'});
  const fact = await open(storagePurpose).catch((error: unknown) => {
    if (error instanceof FactReadDeniedError && error.reason === 'purpose') return open(purpose);
    throw error;
  });
  if (fact.type !== 'activity.studyTurn') throw new FactNotFoundError('学习回合不存在。');
  return fact;
}

async function history(tx: ReadTransaction, session: string): Promise<TurnView[]> {
  const { rows } = await tx.query<{
    id: string;
    value: DisplayTurn | null;
    derivationId: string | null;
    manifest: unknown;
    settled: boolean;
    error: { status: Status; message: string } | null;
  }>(
    `SELECT f.id, d.value, d.id AS "derivationId", d.manifest, s.last_id IS NOT NULL AS settled, s.last_error AS error FROM facts f
     JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev
     LEFT JOIN slot_state s ON s.learner_id=f.learner_id AND s.slot_type=$3 AND s.slot_key=f.id
     LEFT JOIN derivations d ON d.learner_id=f.learner_id AND d.id=s.current_id
     WHERE f.learner_id=$1 AND f.type='activity.studyTurn' AND r.data->>'sessionId'=$2
     ORDER BY f.created_tick`,
    [tx.learner, session, slotType],
  );
  const result: TurnView[] = [];
  const grantCurrent = workspaceGrantChecker();
  for (const row of rows) {
    const snapshot = await readOwnStudyTurn(tx, row.id)
      .catch((error: unknown) => {
        if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) {
          throw new RequestError(409, '本次教学引用的依据已经变更。请重新开始一轮。');
        }
        throw error;
      });
    const submission = studyTurn(snapshot.value);
    let feedback = row.value;
    if (feedback && (!await grantCurrent(submission) ||
      !await teachingMemoryBasis(tx, parseManifest(row.manifest), row.id))) feedback = null;
    if (!feedback && row.settled) feedback = unavailableReply(submission.model);
    result.push({
      id: row.id,
      submission,
      ...(submission.caseId === 'companion' ? {backgroundUnderstanding: turnResearchAccess(snapshot)} : {}),
      feedback,
      derivationId: row.derivationId,
      status: row.error?.status ?? (feedback ? 'ready' : 'pending'),
      ...(row.error ? { error: row.error.message } : {}),
    });
  }
  return result;
}
export const loadHistory = (db: Db, session: string) =>
  db.snapshot({ learner: studioLearner }, (tx) => history(tx, session));

export function recentConversations(db: Db) {
  return db.snapshot({ learner: studioLearner }, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT r.data->>'sessionId' AS id FROM facts f
       JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev
       WHERE f.learner_id=$1 AND f.type='activity.studyTurn' AND f.retracted_rev IS NULL
         AND r.data->>'caseId' IN ('companion','riding')
       GROUP BY r.data->>'sessionId' ORDER BY MAX(f.created_tick) DESC LIMIT 100`, [studioLearner]);
    const result = [];
    for (const row of rows) {
      try {
        const root = studyTurn((await readOwnStudyTurn(tx, row.id)).value);
        if (root.answer) result.push({ id: row.id, title: root.answer.slice(0, 100), caseId: root.caseId });
      } catch (error) {
        if (!(error instanceof FactReadDeniedError)) throw error;
      }
    }
    return result;
  });
}
type WriteState = {status: 'changed'} | {status: 'withdrawn'};
export type WorkspaceWriteView = Omit<WorkspaceWriteReceipt, 'observation' | 'memory' | 'page' | 'relation'> & {
  observation?: NonNullable<WorkspaceWriteReceipt['observation']> | WriteState;
  memory?: NonNullable<WorkspaceWriteReceipt['memory']> | WriteState;
  page?: NonNullable<WorkspaceWriteReceipt['page']> | WriteState | {status:'reverted'};
  relation?: NonNullable<WorkspaceWriteReceipt['relation']> | WriteState;
};

async function projectWrites(tx: ReadTransaction, writes: WorkspaceWriteReceipt[]): Promise<WorkspaceWriteView[]> {
  const ids = writes.filter(write => write.observation || write.memory ||
    write.page?.status === 'saved' || write.relation?.status === 'saved').map(write => write.id);
  if (!ids.length) return writes;
  const {rows} = await tx.query<{id: string; type: string; current_rev: number; retracted_rev: number | null}>(
    'SELECT id,type,current_rev,retracted_rev FROM facts WHERE learner_id=$1 AND id=ANY($2::text[])', [tx.learner, ids]);
  const facts = new Map(rows.map(row => [row.id, row]));
  return Promise.all(writes.map(async write => {
    const fact = facts.get(write.id);
    if (write.page?.status === 'saved') {
      if (fact && fact.retracted_rev === null && fact.current_rev === write.rev) return write;
      const undone = await readRecordedCommand(tx,textbookUndoId(write.page.undo_token));
      return {...write,page:{status:undone?.state === 'done' ? write.rev === 1 ? 'withdrawn' : 'reverted' : 'changed'}};
    }
    if (write.relation?.status === 'saved') {
      if (fact && fact.retracted_rev === null && fact.current_rev === write.rev) return write;
      return {...write,relation:{status:fact?.retracted_rev ? 'withdrawn' : 'changed'}};
    }
    if (!write.observation && !write.memory) return write;
    if (fact && fact.retracted_rev === null && fact.current_rev === write.rev &&
        (!write.memory || await areMemoryClaimsCurrent(tx, [write.id], undefined, undefined, false, fact.type))) return write;
    const state: WriteState = {status: fact?.retracted_rev ? 'withdrawn' : 'changed'};
    return write.memory ? {...write, memory: state} : {...write, observation: state};
  }));
}

async function recoverRevokedReceipts(tx: ReadTransaction, turnIds: string[]) {
  if (!turnIds.length) return new Map<string, WorkspaceWriteReceipt[]>();
  const { rows } = await tx.query<{ id: string; writes: WorkspaceWriteReceipt[] }>(
    `SELECT s.slot_key AS id, d.value->'writes' AS writes FROM slot_state s
     JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.last_id
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=ANY($3::text[])
       AND jsonb_typeof(d.value->'writes')='array'`,
    [tx.learner, slotType, turnIds],
  );
  return new Map(rows.map(({ id, writes }) => [id, writes.flatMap<WorkspaceWriteReceipt>(write => {
    if (write.memory) return [{id: write.id, rev: write.rev, title: '记忆回执', memory: write.memory}];
    const relation = write.relation?.status === 'proposed'
      ? { status: 'proposed' as const, proposalId: write.relation.proposalId }
      : write.relation?.status === 'saved'
        ? { status: 'saved' as const, undo_token: write.relation.undo_token }
        : undefined;
    if (!relation) return [];
    // A revoked reply may still have a learner decision or undo to manage.
    return [{ id: write.id, rev: write.rev, title: '知识关系回执', relation }];
  })]));
}

export async function getSession(db: Db, session: string, projectRecall?: RecallHttp['project']) {
  const { turns, ...view } = await db.snapshot({ learner: studioLearner }, async tx => {
    const timeline = await history(tx, session);
    const last = timeline.at(-1);
    if (!last) throw new RequestError(404, '这次学习会话不存在。');
    const currentObject = last.submission.currentObject;
    const recoveryIds = timeline.filter(row => !row.feedback || row.feedback.action === 'reply_unavailable').map(row => row.id);
    const recovered = await recoverRevokedReceipts(tx, recoveryIds);
    const memory = await recoverTurnMemoryReceipts(tx, recoveryIds.filter(id => !recovered.get(id)?.some(write => write.memory)));
    return {
      id: session,
      caseId: last.submission.caseId,
      currentTurnId: last.id,
      ...(last.backgroundUnderstanding ? {backgroundUnderstanding: last.backgroundUnderstanding} : {}),
      ...(timeline[0]?.submission.attachment ? { attachment: timeline[0].submission.attachment } : {}),
      ...(currentObject ? {currentObject: {alias: currentObjectAlias(currentObject.kind), id: currentObject.id, rev: currentObject.rev}} : {}),
      status: last.status,
      ...(last.status !== 'ready' && last.submission.answer ? { pendingAnswer: last.submission.answer } : {}),
      ...(last.error ? { error: last.error } : {}),
      ...(last.status === 'pending' ? { artifacts: await turnArtifacts(tx, session, last.id) } : {}),
      turns: await Promise.all(timeline.filter(row => row.feedback || memory.has(row.id)).map(async row => {
        const writes = row.feedback?.writes ?? [...(recovered.get(row.id) ?? []), ...(memory.get(row.id) ?? [])];
        return {row, feedback: row.feedback ?? unavailableReply(row.submission.model),
          writes: writes.length ? await projectWrites(tx, writes) : undefined, artifacts: await turnArtifacts(tx, session, row.id)};
      })),
    };
  });
  const projected = [];
  for (const {row, feedback: value, artifacts, writes} of turns) {
    const {studyKit, ...feedback} = value;
    const recall = row.derivationId && studyKit
      ? await projectRecall?.(session, row.id, row.derivationId, studyKit)
      : undefined;
    projected.push({
      ...feedback, ...(writes && {writes}), turnId: row.id, artifacts,
      ...(row.backgroundUnderstanding ? {backgroundUnderstanding: row.backgroundUnderstanding} : {}),
      ...(studyKit === undefined ? {} : { message: recall?.lesson ?? '' }),
      ...(recall ? { recall } : {}),
      ...(row.submission.answer ? { answer: row.submission.answer } : {}),
    });
  }
  return { ...view, turns: projected };
}
export async function openStudio(db: Db, activity: LoadedModule, { projectRecall }: { projectRecall?: RecallHttp['project'] } = {}) {
  const handle = createCommandHandler(db, {
    modules: [activity],
    hooks: createStudioCommandHooks({
      async afterFactsChanged(tx, tick, changes) {
        for (const change of changes) {
          if (change.factType !== 'activity.studyTurn' || change.kind !== 'create') continue;
          const { id } = change.ref;
          await tx.insert('slot_state', {
            learner_id: tx.learner,
            slot_type: slotType,
            slot_key: id,
            scope_keys: '{}',
            changed_tick: tick,
          });
          await requestWork(tx, tick, { slotType, slotKey: id, deriver: methodName });
        }
      },
    }),
  });
  await db.query('INSERT INTO learners(id) VALUES($1) ON CONFLICT DO NOTHING', [studioLearner]);
  for (const studyCase of cases)
    for (const evidence of first45Histories[studyCase.id]) {
      const id = sourceId(studyCase.id, evidence.id);
      await handle({
        learner: studioLearner,
        actor: 'learner',
        purpose,
        type: 'activity.recordEvidence',
        id: commandId(stableId('seed-record', id)),
        input: { id, data: { title: evidence.title, text: evidence.body } },
      });
    }
  async function submit(
    selected: CaseId,
    session: string,
    parent: string | null,
    answer: string | null,
    req: string,
    attachment?: ReturnType<typeof studyAttachment>,
    grants?: ReturnType<typeof studyMcpGrants>,
    requestedRoute?: unknown,
    currentObject?: StudyCurrentObjectSelection,
    allowBackgroundUnderstanding = false,
  ) {
    if (allowBackgroundUnderstanding === true && selected !== 'companion')
      throw new RequestError(400, '本轮后台理解授权仅用于普通同伴对话。');
    const id = parent ? nextTurn(session, parent) : firstTurn(req);
    const origin = parent ? await db.snapshot({learner: studioLearner}, async tx =>
      studyTurn((await readOwnStudyTurn(tx, session)).value)) : undefined;
    const settings = await loadSettings(turnTask(selected, (origin?.attachment ?? attachment)?.mode === 'prepare'));
    if (!routeMatchesInput(requestedRoute, settings)) throw new RequestError(409, '模型配置已更改，请重新确认。');
    if (grants?.length) {
      if (selected !== 'companion' && selected !== 'riding') throw new RequestError(400, '此活动未开放 MCP 工具。');
      try { resolveMcpGrants(grants, settings); }
      catch { throw new RequestError(409, 'MCP 设置已变化，请重新选择本轮工具。'); }
    }
    if (origin && !sameRoute(origin, settings))
      throw new RequestError(422, '这次对话已绑定原模型配置，请切回该配置或新建对话。');
    const workspaceRevision = selected === 'companion' && !origin?.attachment && !attachment
      ? await workspaceRouteRevision(settings) : undefined;
    let boundObject;
    if (currentObject) {
      if (selected !== 'companion' || origin?.attachment || attachment)
        throw new RequestError(400, '当前学习对象只用于未附选段的自由对话。');
      if (!workspaceRevision) throw new RequestError(403, '此模型未获准访问学习工作区。');
      const opened = await db.snapshot({learner: studioLearner}, tx => readCurrentLearningObject(tx, currentObject, () => true));
      if (!opened) throw new RequestError(403, '无法为本轮打开该版本及所需依据。请核对教学用途和版本。');
      boundObject = {...currentObject, basisDigest: opened.basisDigest};
    }
    const data = {
      caseId: selected,
      sessionId: session,
      parentId: parent,
      answer,
      ...(allowBackgroundUnderstanding ? {allowBackgroundUnderstanding: true} : {}),
      ...(attachment ? { attachment } : {}),
      ...(boundObject ? {currentObject: boundObject} : {}),
      ...((selected === 'companion' || selected === 'riding') ? { agentVersion: 1, allowSearch: settings.allowSearch } : {}),
      ...(workspaceRevision ? {workspaceRevision, ...(!grants?.length && {memoryVersion: 1})} : {}),
      model: settings.model, reasoningEffort: settings.reasoningEffort,
      providerId: settings.activeProviderId, protocol: settings.protocol,
      ...(grants?.length ? {mcpGrants: grants, mcpRevision: mcpRevision(grants, settings)} : {}),
      baseUrl: settings.baseUrl,
    };
    await handle({
      learner: studioLearner,
      purpose,
      actor: 'learner',
      id: requestCommand(req),
      type: 'activity.submitTurn',
      input: { id, data },
    });
    return getSession(db, session, projectRecall);
  }
  async function replay(
    req: string,
    session: string,
    selected: CaseId | undefined,
    parent: string | null,
    answer: string | null,
    attachment?: ReturnType<typeof studyAttachment>,
    grants?: ReturnType<typeof studyMcpGrants>,
    requestedRoute?: unknown,
    currentObject?: StudyCurrentObjectSelection,
    allowBackgroundUnderstanding = false,
  ) {
    const {
      rows: [row],
    } = await db.query<{ id: string; data: unknown }>(
      `SELECT r.fact_id AS id, r.data FROM fact_revs r WHERE r.learner_id=$1 AND r.command_id=$2 AND r.rev=1`,
      [studioLearner, requestCommand(req)],
    );
    if (!row) return null;
    const existing = studyTurn(row.data);
    if (
      existing.sessionId !== session ||
      existing.answer !== answer ||
      !routeMatchesInput(requestedRoute, {activeProviderId: existing.providerId ?? 'default',
        protocol: existing.protocol === 'anthropic' ? 'anthropic' : 'openai', baseUrl: existing.baseUrl,
        model: existing.model, reasoningEffort: existing.reasoningEffort ?? 'high'}) ||
      JSON.stringify(existing.mcpGrants ?? []) !== JSON.stringify(grants ?? []) ||
      existing.parentId !== parent ||
      (selected && existing.caseId !== selected) ||
      existing.currentObject?.kind !== currentObject?.kind || existing.currentObject?.id !== currentObject?.id ||
      existing.currentObject?.rev !== currentObject?.rev ||
      JSON.stringify(existing.attachment) !== JSON.stringify(attachment) ||
      (existing.allowBackgroundUnderstanding ?? false) !== allowBackgroundUnderstanding
    ) {
      throw new RequestError(409, '同一个提交标识已经用于不同内容。');
    }
    return getSession(db, session, projectRecall);
  }
  function requestedGrants(value: unknown) {
    try { return studyMcpGrants(value); }
    catch { throw new RequestError(400, '本轮 MCP 工具选择无效。'); }
  }
  function requestedCurrentObject(value: unknown) {
    if (value === undefined) return;
    try {
      const selection = studyCurrentObjectSelection(value);
      if (Object.keys(value as object).length === 3) return selection;
    } catch {
      // Only the stable selection fields are accepted from the browser.
    }
    throw new RequestError(400, '当前学习对象须包含类型、ID 和版本。');
  }
  function requestedBackgroundUnderstanding(value: unknown) {
    if (value !== undefined && typeof value !== 'boolean') throw new RequestError(400, '本轮后台理解授权无效。');
    return value === true;
  }
  return {
    async start(selected: CaseId, requestId: string, question?: unknown, shared?: unknown, requestedMcp?: unknown,
      requestedRoute?: unknown, requestedObject?: unknown, requestedBackground?: unknown) {
      const grants = requestedGrants(requestedMcp);
      const currentObject = requestedCurrentObject(requestedObject);
      const allowBackgroundUnderstanding = requestedBackgroundUnderstanding(requestedBackground);
      const personal = selected === 'companion' || selected === 'riding';
      if (personal && (typeof question !== 'string' || !question.trim() || question.length > 4000))
        throw new RequestError(400, '请输入 1 至 4000 字的问题。');
      const firstAnswer = personal && typeof question === 'string' ? question.trim() : null;
      let attachment;
      if (shared !== undefined) {
        if (selected !== 'companion') throw new RequestError(400, '请在自由对话中使用个人材料。');
        try { attachment = studyAttachment(shared); }
        catch { throw new RequestError(400, '请选择一段 1 至 3000 字的材料。'); }
      }
      const session = firstTurn(requestId);
      const prior = await replay(requestId, session, selected, null, firstAnswer, attachment, grants, requestedRoute, currentObject, allowBackgroundUnderstanding);
      if (prior) return prior;
      if (attachment) {
        const chosen = attachment;
        const found = await db.snapshot({ learner: studioLearner }, async tx => {
          const original = await readMaterialText(tx, chosen.id);
          return original && chosen.title === original.title && original.text.includes(chosen.text);
        });
        if (!found) throw new RequestError(400, '选段须出自所选材料，请重新打开原文。');
      }
      try {
        return await submit(selected, session, null, firstAnswer, requestId, attachment, grants, requestedRoute, currentObject, allowBackgroundUnderstanding);
      } catch (error) {
        const again = await replay(requestId, session, selected, null, firstAnswer, attachment, grants, requestedRoute, currentObject, allowBackgroundUnderstanding);
        if (again) return again;
        throw error;
      }
    },
    async answer(session: string, parent: unknown, input: unknown, requestId: string, requestedMcp?: unknown,
      requestedRoute?: unknown, requestedObject?: unknown, requestedBackground?: unknown) {
      const grants = requestedGrants(requestedMcp);
      const currentObject = requestedCurrentObject(requestedObject);
      const allowBackgroundUnderstanding = requestedBackgroundUnderstanding(requestedBackground);
      if (typeof input !== 'string' || !input.trim() || input.length > 4000)
        throw new RequestError(400, '请输入 1 至 4000 字的回答。');
      if (typeof parent !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(parent))
        throw new RequestError(400, '提交时须指明当前问题。');
      const answer = input.trim();
      const prior = await replay(requestId, session, undefined, parent, answer, undefined, grants, requestedRoute, currentObject, allowBackgroundUnderstanding);
      if (prior) return prior;
      const last = (await loadHistory(db, session)).at(-1);
      if (!last) throw new RequestError(404, '学习会话不存在。');
      if (last.id !== parent) throw new RequestError(409, '此题已有回答，请刷新后查看下一步。');
      if (last.status !== 'ready') throw new RequestError(409, '请先等同伴完成这一轮。');
      try {
        return await submit(caseId(last.submission.caseId), session, last.id, answer, requestId, undefined, grants, requestedRoute, currentObject, allowBackgroundUnderstanding);
      } catch (error) {
        const again = await replay(requestId, session, undefined, parent, answer, undefined, grants, requestedRoute, currentObject, allowBackgroundUnderstanding);
        if (again) return again;
        if ((await loadHistory(db, session)).at(-1)?.id !== last.id)
          throw new RequestError(409, '另一份回答已提交，请刷新会话。');
        throw error;
      }
    },
  };
}
