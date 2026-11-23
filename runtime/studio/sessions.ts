import { openClassrooms } from './classroom.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import { notionReadScope, teachingResultAuthority, type CheckNotionRead, type NotionRecipient } from './notion.ts';
import { projectStaleWorkspaceWrite, revokedReplyWriteReceipts, workspaceWriteNeedsCurrentFact,
  type WorkspaceWriteReceipt, type WorkspaceWriteView } from '../../executors/teaching/workspace-tools.ts';
import { projectTeachingFeedback, unavailableReply, type TeachingFeedback } from '../../executors/teaching/session-feedback.ts';
export type { WorkspaceWriteView } from '../../executors/teaching/workspace-tools.ts';
export { unconfirmedReplyMessage, unavailableReplyMessage } from '../../executors/teaching/session-feedback.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { Json } from '../../kernel/src/declarations/types.ts';
import { createCommandHandler, readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, isFactReadDenied, isFactUnavailable } from './fact-read-helpers.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { factId, commandId } from '../../kernel/src/declarations/ids.ts';
import { requestWork } from '../../kernel/src/work/index.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { first45Histories, introductoryStudyCases as cases } from '../../executors/teaching/examples.ts';
export { introductoryStudyCases as cases } from '../../executors/teaching/examples.ts';
import type {WorkspaceWitness} from './workspace-agent.ts';
import { turnTask } from '../../executors/teaching/model-routes.ts';
import { sameRoute, resolveMcpGrants, workspaceRouteRevision, workspaceGrantChecker, requiresAccountConfirmation, routeMatchesInput, mcpRevision } from './harness.ts';
import {
  isStudyCaseId,
  matchesStudyTurnReplay,
  requestedStudyBackgroundUnderstanding,
  studyAttachmentRequest,
  studyCurrentObjectRequest,
  studyMcpGrants,
  studyTurn,
  turnResearchAccess,
  type StudyTurnReplay,
} from '../../modules/activity/values.ts';
import { attachmentCurrent, attachmentSources, readMaterialText, readOwnStudyTurn, textSlice } from './reading.ts';
export { readOwnStudyTurn, readTeachingTurn } from './reading.ts';
import type { StudyKit } from '../../executors/teaching/study-kit.ts';
import type { RecallHttp } from './recall-http.ts';
import { checkProviderAccount, loadSettings, providerAccount } from './settings.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import type { ForegroundDigest } from './foreground-digest.ts';
import { areMemoryClaimsCurrent, recoverTurnMemoryReceipts, teachingMemoryBasis } from './memory-claims.ts';
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
  confirmedTeachingMethod, learningToolsMethod,
  slotType,
  textbookUndoId,
  notionModelRecipient,
} from './identity.ts';

import {mountPermissionFields, turnArtifacts} from './presentation-store.ts';

import { RequestError } from '../../modules/capture/request.ts';
export { RequestError };
import {
  buildSessionProjectionHead,
  buildSubmitTurnData,
  checkCurrentObjectRequest,
  checkSessionAnswerInput,
  checkSessionReplyGuard,
  checkSessionStartInput,
  checkMcpGrantsAllowed,
  checkBackgroundUnderstandingAllowed,
  checkMcpGrantsResolved,
  checkAccountSettings,
  checkSubmitOrReplayFallback,
  checkAttachmentFreshness,
  checkSessionTurnError,
  checkStudyCaseId,
  isStudioTurnCreateChange,
  resolveStudioTurnDeriver,
  buildSessionTurnRequest,
  buildReplayRouteSettings,
  buildSubmitTurnPayload,
  buildSessionProjectionView,
  projectTurnSubmission,
  recoveryTurnIds,
  resolveLearningToolsVersion,
  resolveRequestedAccount,
  resolveTurnRouteGuard,
  visibleTimelineTurnIds,
  buildHistoryTurnView,
  buildFormattedTurn,
  buildRecentConversation,
  resolveProtectedTurn,
} from '../../modules/companion/facts/session-stream-slice.ts';

const confirmAccount = () => new RequestError(409, '请重新选择材料或开始新对话，并确认当前模型账户。',
  'provider_account_confirmation_required');
const requestedAccount = resolveRequestedAccount;

export type CaseId = (typeof cases)[number]['id'] | 'companion' | 'riding';
type TurnRequest = StudyTurnReplay & {
  selected?: CaseId;
  req: string;
  requestedRoute: unknown;
};
export function caseId(value: unknown): CaseId {
  const error = checkStudyCaseId(value, isStudyCaseId);
  if (error) throw new RequestError(error.status, error.message);
  return value as CaseId;
}
export { clientRequest } from '../../modules/capture/request.ts';
export type DisplayTurn = TeachingFeedback & {
  writes?: WorkspaceWriteReceipt[];
  workspaceBasis?: WorkspaceWitness[];
  learningMemoryDigest?: string;
  memoryManagement?: true;
  foregroundDigest?: ForegroundDigest;
  answer?: string;
};
type Status = 'pending' | 'ready' | 'failed' | 'unknown';
type TurnView = {
  id: string;
  submission: ReturnType<typeof studyTurn>;
  backgroundUnderstanding?: ReturnType<typeof turnResearchAccess>;
  feedback: DisplayTurn | null;
  derivationId: string | null;
  status: Status;
  error?: string;
};
export async function requireSessionTurn(tx: ReadTransaction, id: string) {
  try {
    return await readOwnStudyTurn(tx, id);
  } catch (error) {
    const turnError = checkSessionTurnError(isFactUnavailable(error));
    if (turnError) throw new RequestError(turnError.status, turnError.message);
    throw error;
  }
}

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
    const snapshot = await requireSessionTurn(tx, row.id);
    const stored = studyTurn(snapshot.value);
    if (!stored.parentId && stored.attachment)
      materialAvailable = await attachmentCurrent(tx,stored) && await grantCurrent(stored);
    const submission = projectTurnSubmission(stored, materialAvailable);
    let authority: 'authorized' | 'unconfirmed' | 'withdrawn' = 'withdrawn';
    if (materialAvailable && row.value) {
      if (check) authority = (await teachingResultAuthority(tx, row.id, stored, row.manifest, grantCurrent, check, undefined, 'history')).state;
      else if (await teachingMemoryBasis(tx, parseManifest(row.manifest), row.id)) authority = 'authorized';
    }
    let feedback = authority === 'authorized' ? row.value : null;
    if (!feedback && row.settled) feedback = unavailableReply(submission.model, authority === 'unconfirmed');
    result.push(buildHistoryTurnView({
      id: row.id, submission,
      backgroundUnderstanding: submission.caseId === 'companion' ? turnResearchAccess(snapshot) : undefined,
      feedback, derivationId: row.derivationId,
      status: row.error?.status ?? (feedback ? 'ready' : 'pending'), error: row.error,
    }));
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
         AND r.data->>'caseId' IN ('companion','riding') AND NOT (r.data ? 'classroom')
       GROUP BY r.data->>'sessionId' ORDER BY MAX(f.created_tick) DESC LIMIT 100`, [studioLearner]);
    const result = [];
    for (const row of rows) {
      try {
        const root = studyTurn((await readOwnStudyTurn(tx, row.id)).value);
        if (root.answer) result.push(buildRecentConversation(row.id, root.answer, root.caseId));
      } catch (error) {
        if (!isFactReadDenied(error)) throw error;
      }
    }
    return result;
  });
}
async function projectWrites(tx: ReadTransaction, writes: WorkspaceWriteReceipt[]): Promise<WorkspaceWriteView[]> {
  const ids = writes.filter(workspaceWriteNeedsCurrentFact).map(write => write.id);
  if (!ids.length) return writes;
  const {rows} = await tx.query<{id: string; type: string; current_rev: number; retracted_rev: number | null}>(
    'SELECT id,type,current_rev,retracted_rev FROM facts WHERE learner_id=$1 AND id=ANY($2::text[])', [tx.learner, ids]);
  const facts = new Map(rows.map(row => [row.id, row]));
  return Promise.all(writes.map(async write => {
    const fact = facts.get(write.id);
    const savedPage = write.page?.status === 'saved' ? write.page : undefined;
    const checkMemory = write.memory && !savedPage && write.relation?.status !== 'saved';
    if (fact && fact.retracted_rev === null && fact.current_rev === write.rev &&
        (!checkMemory || await areMemoryClaimsCurrent(tx, [write.id], undefined, undefined, false, fact.type))) return write;
    const undone = savedPage && await readRecordedCommand(tx,textbookUndoId(savedPage.undo_token));
    return projectStaleWorkspaceWrite(write, Boolean(fact?.retracted_rev), undone?.state === 'done');
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
  return new Map(rows.map(({ id, writes }) => [id, revokedReplyWriteReceipts(writes)]));
}

async function readableTurnMounts(tx: ReadTransaction, session: string, timeline: readonly TurnView[], check: CheckNotionRead) {
  const visible = visibleTimelineTurnIds(timeline);
  const byTurn = new Map<string, Awaited<ReturnType<typeof turnArtifacts>>>();
  for (const id of visible) byTurn.set(id, await turnArtifacts(tx, session, id, check));
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

async function sessionProjection(tx: ReadTransaction, session: string, check: CheckNotionRead, knownMounts: ReadonlySet<string>) {
  const timeline = await history(tx, session, check);
  const last = timeline.at(-1);
  if (!last) throw new RequestError(404, '这次学习会话不存在。');
  const mounts = await readableTurnMounts(tx, session, timeline, check);
  const currentObject = last.submission.classroom ? undefined : last.submission.currentObject;
  const recoveryIds = recoveryTurnIds(timeline);
  const recovered = await recoverRevokedReceipts(tx, recoveryIds);
  const memory = await recoverTurnMemoryReceipts(tx, recoveryIds.filter(id => !recovered.get(id)?.some(write => write.memory)));
  return buildSessionProjectionView({
    sessionId: session, lastId: last.id, lastStatus: last.status, lastError: last.error, caseId: last.submission.caseId,
    pendingAnswer: last.submission.answer, backgroundUnderstanding: last.backgroundUnderstanding,
    firstAttachment: timeline[0]?.submission.attachment,
    currentObjectView: currentObject ? { alias: currentObjectAlias(currentObject.kind), id: currentObject.id, rev: currentObject.rev } : undefined,
    pendingArtifacts: mounts.get(last.id)?.snapshots ?? [],
    mountFields: mountPermissionFields([...mounts.values()].flatMap(turn => turn.unconfirmed), knownMounts),
    turns: await Promise.all(timeline.filter(row => row.feedback || memory.has(row.id)).map(async row => {
      const writes = row.feedback?.writes ?? [...(recovered.get(row.id) ?? []), ...(memory.get(row.id) ?? [])];
      return {row, feedback: row.feedback ?? unavailableReply(row.submission.model),
        writes: writes.length ? await projectWrites(tx, writes) : undefined, artifacts: mounts.get(row.id)?.snapshots ?? []};
    })),
  });
}

async function formatSession({turns,...view}: Awaited<ReturnType<typeof sessionProjection>>,
  recall?: (turn: string, derivation: string, kit: StudyKit) => ReturnType<RecallHttp['project']>) {
  const projected = [];
  for (const { row, artifacts, writes, feedback: value } of turns) {
    const { studyKit } = value;
    const projectedRecall = row.derivationId && studyKit
      ? await recall?.(row.id,row.derivationId,studyKit)
      : undefined;
    projected.push(buildFormattedTurn({ turnId: row.id, artifacts, writes,
      backgroundUnderstanding: row.backgroundUnderstanding, answer: row.submission.answer,
      feedbackProjection: projectTeachingFeedback(value, projectedRecall) }));
  }
  return { ...view, turns: projected };
}

export async function readClassroomSession(tx: ReadTransaction, session: string, check: CheckNotionRead) {
  return formatSession(await sessionProjection(tx,session,check,new Set()));
}

export async function getSession(db: Db, session: string, projectRecall?: RecallHttp['project'], knownMounts: ReadonlySet<string> = new Set()) {
  const notion = notionReadScope(db,studioLearner);
  return formatSession(await notion.read((tx,check) => sessionProjection(tx,session,check,knownMounts)),
    projectRecall && ((turn,derivation,kit) => projectRecall(session,turn,derivation,kit,notion)));
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
  const hooks = createStudioCommandHooks({
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
            const accountError = checkAccountSettings(settings, settings ? sameRoute(submission, settings) : false,
              submission.workspaceRevision ? await workspaceRouteRevision(settings!) === submission.workspaceRevision : true);
            if (accountError) throw confirmAccount();
          }
          if (origin.attachment && !await attachmentCurrent(tx, origin))
            { const e = checkAttachmentFreshness(false); throw new RequestError(e!.status, e!.message); }
          await tx.insert('slot_state', {
            learner_id: tx.learner,
            slot_type: slotType,
            slot_key: id,
            scope_keys: '{}',
            changed_tick: tick,
          });
          const guarded = requiresAccountConfirmation(submission) || requiresAccountConfirmation(origin);
          const deriver = resolveStudioTurnDeriver({ learningToolsVersion: submission.learningToolsVersion, guarded });
          await requestWork(tx,tick,{slotType,slotKey:id,deriver: deriver.method},deriver.pending);
        }
      },
  });
  const handle = createCommandHandler(db, {modules:[activity],hooks});
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
  async function submit(request: TurnRequest, selected: CaseId) {
    const {session, parent, answer, req, grants, requestedRoute, currentObject, allowBackgroundUnderstanding} = request;
    if (allowBackgroundUnderstanding === true) {
      const background = checkBackgroundUnderstandingAllowed(selected);
      if (background) throw new RequestError(background.status, background.message);
    }
    const id = parent ? nextTurn(session, parent) : firstTurn(req);
    const origin = parent ? await db.snapshot({learner: studioLearner}, async tx =>
      studyTurn((await readOwnStudyTurn(tx, session)).value)) : undefined;
    const requested = request.attachment;
    const attachment: Extract<NonNullable<typeof requested>, {text: string}> | undefined = requested === undefined ? undefined
      : 'text' in requested ? requested : await db.snapshot({learner: studioLearner}, async tx => {
        const source = await readMaterialText(tx, requested.id);
        if (!source) throw new RequestError(400, '选段须出自所选材料，请重新打开原文。');
        return {id: requested.id, title: source.title,
          text: textSlice(source.text, 0, 16_000).content, mode: requested.mode};
      });
    if (requested && !('text' in requested)) request.attachment = attachment;
    const attachmentBasis = attachment &&
      await db.snapshot({learner:studioLearner}, tx => attachmentSources(tx, attachment));
    if (attachment && !attachmentBasis) throw new RequestError(400, '选段须出自所选材料，请重新打开原文。');
    const task = turnTask(selected, (origin?.attachment ?? attachment)?.mode === 'prepare');
    const settings = await loadSettings(task);
    if (grants?.length) {
      const grantsError = checkMcpGrantsAllowed(selected);
      if (grantsError) throw new RequestError(grantsError.status, grantsError.message);
      try { resolveMcpGrants(grants, settings); }
      catch { const resolved = checkMcpGrantsResolved(false); throw new RequestError(resolved!.status, resolved!.message); }
    }
    const workspaceRevision = selected === 'companion' && !(origin?.attachment && !origin.workspaceRevision)
      ? await workspaceRouteRevision(settings) : undefined;
    const account = providerAccount(settings);
    const jitCounter = enableJit && account && !parent && workspaceRevision && !grants?.length && !attachment ? studioJitCounter(jitCounters, settings) : undefined;
    let boundObject;
    if (currentObject) {
      const opened = await db.snapshot({learner: studioLearner}, tx => readCurrentLearningObject(tx, currentObject, Object.assign(() => true,
        {notionRecipientId:notionModelRecipient(settings.activeProviderId,settings.baseUrl,settings.protocol,settings.model,workspaceRevision!)})));
      if (!opened) throw new RequestError(403, '无法为本轮打开该版本及所需依据。请核对教学用途和版本。');
      boundObject = {...currentObject, basisDigest: opened.basisDigest};
    }
    const payload = buildSubmitTurnPayload({
      selected, session, parent, answer, allowBackgroundUnderstanding, attachment, attachmentBasisDigest: attachmentBasis?.digest,
      origin, requestedRoute, currentObject, settings, workspaceRevision, account, jitCounter, grants,
      mcpRevision: grants?.length ? mcpRevision(grants, settings) : undefined,
      boundObject,
      routeMatchesSettings: routeMatchesInput(requestedRoute, settings), originMatchesSettings: origin ? sameRoute(origin, settings) : true,
    });
    if (payload.error) throw new RequestError(payload.error.status, payload.error.message, payload.error.code);
    const data = payload.data as Json;
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
  async function replay(request: TurnRequest) {
    const {req, session, requestedRoute} = request;
    const {
      rows: [row],
    } = await db.query<{ id: string; data: unknown }>(
      `SELECT r.fact_id AS id, r.data FROM fact_revs r WHERE r.learner_id=$1 AND r.command_id=$2 AND r.rev=1`,
      [studioLearner, requestCommand(req)],
    );
    if (!row) return null;
    const existing = studyTurn(row.data);
    if (existing.accountConfirmation && requestedAccount(requestedRoute) !== existing.accountRevision) throw confirmAccount();
    if (!matchesStudyTurnReplay(existing, request) ||
        !routeMatchesInput(requestedRoute, buildReplayRouteSettings(existing)))
      throw new RequestError(409, '同一个提交标识已经用于不同内容。');
    return getSession(db, session, projectRecall);
  }
  async function submitOrReplay(request: TurnRequest, selected: string) {
    try {
      return await submit(request, request.selected ?? caseId(selected));
    } catch (error) {
      const prior = await replay(request);
      if (prior) return prior;
      if (request.parent && (await loadHistory(db, request.session)).at(-1)?.id !== request.parent)
        { const e = checkSubmitOrReplayFallback({ hasParent: true, lastTurnIdMatchesParent: false }); throw new RequestError(e!.status, e!.message); }
      throw error;
    }
  }
  function requestedGrants(value: unknown) {
    try { return studyMcpGrants(value); }
    catch { throw new RequestError(400, '本轮 MCP 工具选择无效。'); }
  }
  function requestedCurrentObject(value: unknown) {
    const selection = studyCurrentObjectRequest(value);
    if (selection !== null) return selection;
    throw new RequestError(400, '当前学习对象须包含类型、ID 和版本。');
  }
  function requestedBackgroundUnderstanding(value: unknown) {
    if (value !== undefined && typeof value !== 'boolean') throw new RequestError(400, '本轮后台理解授权无效。');
    return requestedStudyBackgroundUnderstanding(value);
  }
  return {
    classrooms: openClassrooms(db,activity,hooks),
    async start(selected: CaseId, requestId: string, question?: unknown, shared?: unknown, requestedMcp?: unknown,
      requestedRoute?: unknown, requestedObject?: unknown, requestedBackground?: unknown) {
      const grants = requestedGrants(requestedMcp);
      const currentObject = requestedCurrentObject(requestedObject);
      const allowBackgroundUnderstanding = requestedBackgroundUnderstanding(requestedBackground);
      const personal = selected === 'companion' || selected === 'riding';
      const startError = checkSessionStartInput({ personal, question, hasShared: shared !== undefined });
      if (startError) throw new RequestError(startError.status, startError.message);
      const firstAnswer = personal && typeof question === 'string' ? question.trim() : null;
      let attachment;
      if (shared !== undefined) {
        try { attachment = studyAttachmentRequest(shared); }
        catch { throw new RequestError(400, '请选择材料或其片段。'); }
      }
      const request = buildSessionTurnRequest({ req: requestId, session: firstTurn(requestId), selected, parent: null, answer: firstAnswer,
        attachment, grants, requestedRoute, currentObject, allowBackgroundUnderstanding }) as TurnRequest;
      return await replay(request) ?? submitOrReplay(request, selected);
    },
    async answer(session: string, parent: unknown, input: unknown, requestId: string, requestedMcp?: unknown,
      requestedRoute?: unknown, requestedObject?: unknown, requestedBackground?: unknown) {
      const grants = requestedGrants(requestedMcp);
      const currentObject = requestedCurrentObject(requestedObject);
      const allowBackgroundUnderstanding = requestedBackgroundUnderstanding(requestedBackground);
      const answerError = checkSessionAnswerInput({ answer: input, parent });
      if (answerError) throw new RequestError(answerError.status, answerError.message);
      const text = input as string;
      const request: TurnRequest = buildSessionTurnRequest({ req: requestId, session, parent: parent as string, answer: text.trim(),
        grants, requestedRoute, currentObject, allowBackgroundUnderstanding }) as TurnRequest;
      const prior = await replay(request);
      if (prior) return prior;
      const last = (await loadHistory(db, session)).at(-1);
      const replyGuard = checkSessionReplyGuard({ lastExists: Boolean(last), lastIsClassroom: Boolean(last?.submission.classroom),
        lastIdMatches: last?.id === parent, lastStatus: last?.status ?? 'pending' });
      if (replyGuard) throw new RequestError(replyGuard.status, replyGuard.message);
      return submitOrReplay(request, last!.submission.caseId);
    },
  };
}
