import { lockLearner } from '../../kernel/src/db/learner.ts';
import { notionReadScope, teachingResultAuthority, type CheckNotionRead, type NotionRecipient } from './notion.ts';
import type { WorkspaceWriteReceipt } from '../../executors/teaching/workspace-tools.ts';
import { projectArtifactMountTrace } from '../../executors/teaching/artifact-trace.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { createCommandHandler, readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { factId, commandId } from '../../kernel/src/declarations/ids.ts';
import { requestWork } from '../../kernel/src/work/index.ts';
import { first45Answer, first45Histories, first45Question } from '../../executors/teaching/examples.ts';
import type {WorkspaceWitness} from './workspace-agent.ts';
import { turnTask } from './model-routes.ts';
import { sameRoute, resolveMcpGrants, workspaceRouteRevision, workspaceGrantChecker, requiresAccountConfirmation, routeMatchesInput, mcpRevision } from './harness.ts';
import { studyAttachment, studyCurrentObjectSelection, studyMcpGrants, studyTurn, type StudyCurrentObjectSelection } from '../../modules/activity/values.ts';
import { attachmentCurrent, attachmentSources } from './reading.ts';
import type { StudyKit } from '../../executors/teaching/study-kit.ts';
import type { RecallHttp } from './recall-http.ts';
import { checkProviderAccount, loadSettings, providerAccount } from './settings.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import type { ForegroundDigest } from './foreground-digest.ts';
import { areMemoryClaimsCurrent } from './memory-claims.ts';
import { currentObjectAlias, readCurrentLearningObject } from './current-learning-object.ts';
import { studioJitCounter, type StudioJitCounter } from './first-turn-jit.ts';
import {
  stableId,
  sourceId,
  studioLearner,
  firstTurn,
  nextTurn,
  requestCommand,
  purpose,
  methodName,
  confirmedTeachingMethod,
  slotType,
  textbookUndoId,
  notionModelRecipient,
} from './identity.ts';

import {mountPermissionFields, turnArtifacts} from './presentation-store.ts';

export class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string, readonly responseCode?: string) {
    super(message);
    this.status = status;
  }
}
const confirmAccount = () => new RequestError(409, '请重新选择材料或开始新对话，并确认当前模型账户。',
  'provider_account_confirmation_required');
const requestedAccount = (route:unknown) => route && typeof route === 'object' && 'accountRevision' in route
  ? route.accountRevision : undefined;

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
  memoryCommand?: string;
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
export const unconfirmedReplyMessage = '暂时无法核对本轮依据，旧回复已隐藏。';
export const unavailableReplyMessage = '本轮已完成，依据已变更，旧回复已隐藏。';
type TurnView = {
  id: string;
  submission: ReturnType<typeof studyTurn>;
  feedback: DisplayTurn | null;
  derivationId: string | null;
  status: Status;
  error?: string;
};
async function history(tx: ReadTransaction, session: string, check?: CheckNotionRead): Promise<TurnView[]> {
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
  const grantCurrent = workspaceGrantChecker(tx);
  let materialAvailable = true;
  for (const row of rows) {
    const snapshot = await createCommandReadContext(tx, purpose).fact(factId(row.id), { mode: 'following' })
      .catch((error: unknown) => {
        if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) {
          throw new RequestError(409, '本次教学引用的依据已经变更。请重新开始一轮。');
        }
        throw error;
      });
    const stored = studyTurn(snapshot.value);
    if (!stored.parentId && stored.attachment)
      materialAvailable = await attachmentCurrent(tx,stored) && await grantCurrent(stored);
    const {attachment: _attachment, ...withoutAttachment} = stored;
    const submission = materialAvailable ? stored : withoutAttachment;
    const authority = !materialAvailable ? 'withdrawn' : row.value && check &&
      await teachingResultAuthority(tx, stored, row.manifest, grantCurrent, check);
    let feedback = !authority || authority === 'authorized' ? row.value : null;
    if (!feedback && row.settled) feedback = { action: 'reply_unavailable', model: submission.model,
      rationale: '', message: authority === 'unconfirmed' ? unconfirmedReplyMessage : unavailableReplyMessage, reads: [], evidenceIds: [] };
    result.push({
      id: row.id,
      submission,
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
    const reader = createCommandReadContext(tx, purpose);
    for (const row of rows) {
      try {
        const root = studyTurn((await reader.fact(factId(row.id), { mode: 'following' })).value);
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
  const {rows} = await tx.query<{id: string; current_rev: number; retracted_rev: number | null}>(
    'SELECT id,current_rev,retracted_rev FROM facts WHERE learner_id=$1 AND id=ANY($2::text[])', [tx.learner, ids]);
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
        (!write.memory || await areMemoryClaimsCurrent(tx, [write.id]))) return write;
    const state: WriteState = {status: fact?.retracted_rev ? 'withdrawn' : 'changed'};
    return write.memory ? {...write, memory: state} : {...write, observation: state};
  }));
}

async function recoverRelationReceipts(tx: ReadTransaction, turnIds: string[]) {
  if (!turnIds.length) return new Map<string, WorkspaceWriteReceipt[]>();
  const { rows } = await tx.query<{ id: string; writes: WorkspaceWriteReceipt[] }>(
    `SELECT s.slot_key AS id, d.value->'writes' AS writes FROM slot_state s
     JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.last_id
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=ANY($3::text[])
       AND jsonb_typeof(d.value->'writes')='array'`,
    [tx.learner, slotType, turnIds],
  );
  return new Map(rows.map(({ id, writes }) => [id, writes.flatMap<WorkspaceWriteReceipt>(write => {
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

async function readableTurnMounts(tx: ReadTransaction, session: string, timeline: readonly TurnView[], check: CheckNotionRead) {
  const last = timeline.at(-1);
  const visible = timeline.filter(row => row.feedback || (row === last && row.status === 'pending'));
  const byTurn = new Map<string, Awaited<ReturnType<typeof turnArtifacts>>>();
  for (const row of visible) byTurn.set(row.id, await turnArtifacts(tx, session, row.id, check));
  return byTurn;
}

export function sessionMountPermissions(db: Db, session: string) {
  return notionReadScope(db, studioLearner).read(async (tx, check) => {
    const mounts = await readableTurnMounts(tx, session, await history(tx, session, check), check);
    const turns = [...mounts.values()];
    return {
      authorizedMountIds: turns.flatMap(turn => turn.snapshots.map(artifact => artifact.mountId)),
      unconfirmed: turns.flatMap(turn => turn.unconfirmed),
    };
  });
}

export async function getSession(db: Db, session: string, projectRecall?: RecallHttp['project'], knownMounts: ReadonlySet<string> = new Set()) {
  const notion = notionReadScope(db, studioLearner);
  const { turns, ...view } = await notion.read(async (tx, check) => {
    const timeline = await history(tx, session, check);
    const last = timeline.at(-1);
    if (!last) throw new RequestError(404, '这次学习会话不存在。');
    const mounts = await readableTurnMounts(tx, session, timeline, check);
    const currentObject = last.submission.currentObject;
    const recovered = await recoverRelationReceipts(tx,
      timeline.filter(row => row.feedback?.action === 'reply_unavailable').map(row => row.id));
    return {
      id: session,
      caseId: last.submission.caseId,
      currentTurnId: last.id,
      ...(timeline[0]?.submission.attachment ? { attachment: timeline[0].submission.attachment } : {}),
      ...(currentObject ? {currentObject: {alias: currentObjectAlias(currentObject.kind), id: currentObject.id, rev: currentObject.rev}} : {}),
      status: last.status,
      ...(last.status !== 'ready' && last.submission.answer ? { pendingAnswer: last.submission.answer } : {}),
      ...(last.error ? { error: last.error } : {}),
      ...(last.status === 'pending' ? { artifacts: mounts.get(last.id)?.snapshots ?? [] } : {}),
      ...mountPermissionFields([...mounts.values()].flatMap(turn => turn.unconfirmed), knownMounts),
      turns: await Promise.all(timeline.filter(row => row.feedback).map(async row => {
        const writes = row.feedback?.writes ?? recovered.get(row.id);
        return { row, writes: writes?.length ? await projectWrites(tx, writes) : undefined,
          artifacts: mounts.get(row.id)?.snapshots ?? [] };
      })),
    };
  });
  const projected = [];
  for (const { row, artifacts, writes } of turns) {
    if (!row.feedback) continue;
    const { studyKit, trace, ...feedback } = row.feedback;
    const recall = row.derivationId && studyKit
      ? await projectRecall?.(session, row.id, row.derivationId, studyKit, notion)
      : undefined;
    projected.push({
      ...feedback, ...(writes && {writes}), turnId: row.id, artifacts,
      ...(trace && { trace: trace.map(projectArtifactMountTrace) }),
      ...(studyKit === undefined ? {} : { message: recall?.lesson ?? '' }),
      ...(recall ? { recall } : {}),
      ...(row.submission.answer ? { answer: row.submission.answer } : {}),
    });
  }
  return { ...view, turns: projected };
}
async function fenceTeachingCutover(db: Db) {
  await db.tx({learner:studioLearner}, async tx => {
    await lockLearner(tx,tx.learner);
    const gate = await tx.query(`SELECT 1 FROM pg_trigger
      WHERE tgrelid='fact_revs'::regclass AND tgname='studio_confirmed_teaching'`);
    if (!gate.rowCount) {
      await tx.query(`
      CREATE FUNCTION studio_confirmed_teaching() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.rev=1 AND (NEW.data->>'accountConfirmation' IS DISTINCT FROM '1' OR NEW.data->>'accountRevision' IS NULL)
          AND EXISTS (SELECT 1 FROM facts f WHERE (f.learner_id,f.id)=(NEW.learner_id,NEW.fact_id) AND f.type='activity.studyTurn')
          AND (NEW.data ?| ARRAY['attachment','jitContextVersion','accountRevision'] OR EXISTS (
            SELECT 1 FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
            WHERE (f.learner_id,f.id)=(NEW.learner_id,NEW.data->>'sessionId')
              AND r.data ?| ARRAY['attachment','jitContextVersion','accountRevision'])) THEN
          RAISE EXCEPTION 'Protected teaching turn requires learner-confirmed account' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$`);
      await tx.query(`CREATE TRIGGER studio_confirmed_teaching BEFORE INSERT ON fact_revs
        FOR EACH ROW EXECUTE FUNCTION studio_confirmed_teaching()`);
    }
    const {rows} = await tx.query<{id:string}>(`
      SELECT w.slot_key AS id FROM work w
      JOIN facts f ON (f.learner_id,f.id)=(w.learner_id,w.slot_key) AND f.type='activity.studyTurn'
      JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      JOIN facts origin ON (origin.learner_id,origin.id)=(f.learner_id,r.data->>'sessionId')
      JOIN fact_revs root ON (root.learner_id,root.fact_id,root.rev)=(origin.learner_id,origin.id,origin.current_rev)
      WHERE w.learner_id=$1 AND w.slot_type=$2 AND w.state='ready' AND r.data->>'accountConfirmation' IS DISTINCT FROM '1'
        AND (r.data ?| ARRAY['attachment','jitContextVersion','accountRevision']
          OR root.data ?| ARRAY['attachment','jitContextVersion','accountRevision'])`, [tx.learner,slotType]);
    const ids=rows.map(row=>row.id);
    if (!ids.length) return;
    await tx.withLearnerWrite(async tick => {
      await tx.query(`UPDATE work SET state='blocked',execution_ref=NULL WHERE learner_id=$1 AND slot_type=$2
        AND slot_key=ANY($3::text[]) AND state='ready'`, [tx.learner,slotType,ids]);
      await tx.query(`UPDATE slot_state SET pending='none',changed_tick=$4,last_error=$5
        WHERE learner_id=$1 AND slot_type=$2 AND slot_key=ANY($3::text[])`,
      [tx.learner,slotType,ids,tick,JSON.stringify({status:'failed',message:confirmAccount().message})]);
    });
  });
}

export async function openStudio(db: Db, activity: LoadedModule, {projectRecall, jitCounters = [], enableJit = false}: {
  projectRecall?: RecallHttp['project']; jitCounters?: readonly StudioJitCounter[]; enableJit?: boolean;
} = {}) {
  const handle = createCommandHandler(db, {
    modules: [activity],
    hooks: createStudioCommandHooks({
      async afterFactsChanged(tx, tick, changes) {
        for (const change of changes) {
          if (change.factType !== 'activity.studyTurn' || change.kind !== 'create') continue;
          const { id } = change.ref;
          const submission = studyTurn((await createCommandReadContext(tx,purpose).fact(id,{mode:'following'})).value);
          const origin = submission.parentId && submission.accountRevision ? studyTurn((await createCommandReadContext(tx,purpose)
              .fact(submission.sessionId,{mode:'following'})).value) : submission;
          if (submission.accountRevision) {
            const settings = await checkProviderAccount(tx,{providerId:submission.providerId ?? 'default',accountRevision:submission.accountRevision},
              turnTask(submission.caseId,origin.attachment?.mode === 'prepare'));
            if (!settings || !sameRoute(submission,settings) ||
                (submission.workspaceRevision && await workspaceRouteRevision(settings) !== submission.workspaceRevision))
              throw confirmAccount();
          }
          if (origin.attachment && !await attachmentCurrent(tx, origin))
            throw new RequestError(409, '选段的原件或版本已经变化，请重新打开原文。');
          await tx.insert('slot_state', {
            learner_id: tx.learner,
            slot_type: slotType,
            slot_key: id,
            scope_keys: '{}',
            changed_tick: tick,
          });
          const guarded = requiresAccountConfirmation(submission) || requiresAccountConfirmation(origin);
          await requestWork(tx,tick,{slotType,slotKey:id,deriver:guarded ? confirmedTeachingMethod : methodName},guarded ? 'routed_pending' : 'pending');
        }
      },
    }),
  });
  await db.query('INSERT INTO learners(id) VALUES($1) ON CONFLICT DO NOTHING', [studioLearner]);
  await fenceTeachingCutover(db);
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
  ) {
    const id = parent ? nextTurn(session, parent) : firstTurn(req);
    const origin = parent ? await db.snapshot({learner: studioLearner}, async tx =>
      studyTurn((await createCommandReadContext(tx, purpose).fact(factId(session), {mode: 'following'})).value)) : undefined;
    const attachmentBasis = attachment && await db.snapshot({learner:studioLearner}, tx => attachmentSources(tx, attachment));
    if (attachment && !attachmentBasis) throw new RequestError(400, '选段须出自所选材料，请重新打开原文。');
    const task = turnTask(selected, (origin?.attachment ?? attachment)?.mode === 'prepare');
    const settings = await loadSettings(task);
    if (grants?.length) {
      if (selected !== 'companion' && selected !== 'riding') throw new RequestError(400, '此活动未开放 MCP 工具。');
      try { resolveMcpGrants(grants, settings); }
      catch { throw new RequestError(409, 'MCP 设置已变化，请重新选择本轮工具。'); }
    }
    const workspaceRevision = selected === 'companion' && !origin?.attachment && !attachment
      ? await workspaceRouteRevision(settings) : undefined;
    const account = providerAccount(settings);
    const jitCounter = enableJit && account && !parent && workspaceRevision && !grants?.length ? studioJitCounter(jitCounters, settings) : undefined;
    const accountRevision = attachment || jitCounter ? account?.accountRevision : origin?.accountRevision;
    const protectedTurn = origin?.attachment || origin?.jitContextVersion || attachment || jitCounter || accountRevision;
    const supplied = requestedAccount(requestedRoute);
    if (protectedTurn || supplied !== undefined) {
      if (!account || supplied !== account.accountRevision || (protectedTurn && origin && !origin.accountConfirmation) ||
          !routeMatchesInput(requestedRoute,settings) || (origin && !sameRoute(origin,settings))) throw confirmAccount();
    } else if (!routeMatchesInput(requestedRoute,settings)) {
      throw new RequestError(409, '模型配置已更改，请重新确认。');
    } else if (origin && !sameRoute(origin,settings)) {
      throw new RequestError(422, '这次对话已绑定原模型配置，请切回该配置或新建对话。');
    }
    let boundObject;
    if (currentObject) {
      if (selected !== 'companion' || origin?.attachment || attachment)
        throw new RequestError(400, '当前学习对象只用于未附选段的自由对话。');
      if (!workspaceRevision) throw new RequestError(403, '此模型未获准访问学习工作区。');
      const opened = await db.snapshot({learner: studioLearner}, tx => readCurrentLearningObject(tx, currentObject, Object.assign(() => true,
        {notionRecipientId:notionModelRecipient(settings.activeProviderId,settings.baseUrl,settings.protocol,settings.model,workspaceRevision)})));
      if (!opened) throw new RequestError(403, '无法为本轮打开该版本及所需依据。请核对教学用途和版本。');
      boundObject = {...currentObject, basisDigest: opened.basisDigest};
    }
    const data = {
      caseId: selected,
      sessionId: session,
      parentId: parent,
      answer,
      ...(attachmentBasis ? {attachment, attachmentBasis:attachmentBasis.digest} : {}),
      ...(boundObject ? {currentObject: boundObject} : {}),
      ...(jitCounter ? {jitContextVersion: 1, jitCounterId: jitCounter.id} : {}),
      ...(accountRevision ? {accountRevision,accountConfirmation:1} : {}),
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
  ) {
    const {
      rows: [row],
    } = await db.query<{ id: string; data: unknown }>(
      `SELECT r.fact_id AS id, r.data FROM fact_revs r WHERE r.learner_id=$1 AND r.command_id=$2 AND r.rev=1`,
      [studioLearner, requestCommand(req)],
    );
    if (!row) return null;
    const existing = studyTurn(row.data);
    if (existing.accountConfirmation && requestedAccount(requestedRoute) !== existing.accountRevision) throw confirmAccount();
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
      JSON.stringify(existing.attachment) !== JSON.stringify(attachment)
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
  return {
    async start(selected: CaseId, requestId: string, question?: unknown, shared?: unknown, requestedMcp?: unknown,
      requestedRoute?: unknown, requestedObject?: unknown) {
      const grants = requestedGrants(requestedMcp);
      const currentObject = requestedCurrentObject(requestedObject);
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
      const prior = await replay(requestId, session, selected, null, firstAnswer, attachment, grants, requestedRoute, currentObject);
      if (prior) return prior;
      try {
        return await submit(selected, session, null, firstAnswer, requestId, attachment, grants, requestedRoute, currentObject);
      } catch (error) {
        const again = await replay(requestId, session, selected, null, firstAnswer, attachment, grants, requestedRoute, currentObject);
        if (again) return again;
        throw error;
      }
    },
    async answer(session: string, parent: unknown, input: unknown, requestId: string, requestedMcp?: unknown,
      requestedRoute?: unknown, requestedObject?: unknown) {
      const grants = requestedGrants(requestedMcp);
      const currentObject = requestedCurrentObject(requestedObject);
      if (typeof input !== 'string' || !input.trim() || input.length > 4000)
        throw new RequestError(400, '请输入 1 至 4000 字的回答。');
      if (typeof parent !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(parent))
        throw new RequestError(400, '提交时须指明当前问题。');
      const answer = input.trim();
      const prior = await replay(requestId, session, undefined, parent, answer, undefined, grants, requestedRoute, currentObject);
      if (prior) return prior;
      const last = (await loadHistory(db, session)).at(-1);
      if (!last) throw new RequestError(404, '学习会话不存在。');
      if (last.id !== parent) throw new RequestError(409, '此题已有回答，请刷新后查看下一步。');
      if (last.status !== 'ready') throw new RequestError(409, '请先等同伴完成这一轮。');
      try {
        return await submit(caseId(last.submission.caseId), session, last.id, answer, requestId, undefined, grants, requestedRoute, currentObject);
      } catch (error) {
        const again = await replay(requestId, session, undefined, parent, answer, undefined, grants, requestedRoute, currentObject);
        if (again) return again;
        if ((await loadHistory(db, session)).at(-1)?.id !== last.id)
          throw new RequestError(409, '另一份回答已提交，请刷新会话。');
        throw error;
      }
    },
  };
}
