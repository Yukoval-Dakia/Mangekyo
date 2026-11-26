import { openClassrooms } from './classroom.ts';
import { notionReadScope, notionRecipient, teachingResultAuthority, type CheckNotionRead } from './notion.ts';
import {
  projectStaleWorkspaceWrite, revokedReplyWriteReceipts, workspaceWriteNeedsCurrentFact,
  type WorkspaceWriteReceipt, type WorkspaceWriteView,
} from '../../executors/teaching/workspace-tools.ts';
import { projectTeachingFeedback, unavailableReply, type TeachingFeedback } from '../../executors/teaching/session-feedback.ts';
export type { WorkspaceWriteView } from '../../executors/teaching/workspace-tools.ts';
export { unconfirmedReplyMessage, unavailableReplyMessage } from '../../executors/teaching/session-feedback.ts';
import { readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { requestWork } from '../../kernel/src/work/index.ts';
import {
  commandId, factId, isFactUnavailable, listCurrentSlotFacts, listFactsStatus,
  parseManifest, readAvailable, type Db, type FactSnapshot, type ReadTransaction,
} from '../../kernel/src/index.ts';
import { first45Histories, introductoryStudyCases as cases } from '../../executors/teaching/examples.ts';
export { introductoryStudyCases as cases } from '../../executors/teaching/examples.ts';
import type {WorkspaceWitness} from './workspace-agent.ts';
import { turnTask } from '../../executors/teaching/model-routes.ts';
import { sameRoute, resolveMcpGrants, workspaceRouteRevision, workspaceGrantChecker, requiresAccountConfirmation, routeMatchesInput, mcpRevision } from './harness.ts';
import {
  isStudyCaseId, matchesStudyTurnReplay, requestedStudyBackgroundUnderstanding, studyAttachmentRequest,
  studyCurrentObjectRequest, studyMcpGrants, studyTurn, turnResearchAccess, type StudyTurnReplay,
} from '../../modules/activity/values.ts';
import { evaluateCrisisSupport } from '../../executors/teaching/crisis-support.ts';
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
  stableId, sourceId, studioHost, studioLearner, firstTurn, nextTurn, requestCommand, purpose,
  methodName, confirmedTeachingMethod, learningToolsMethod, slotType, textbookUndoId, modelRecipientId, ulidExact,
} from './identity.ts';

import {mountPermissionFields, turnArtifacts} from './presentation-store.ts';

import { describeBasisFact } from '../../modules/learner/record-flow.ts';
import { RequestError } from '../../modules/capture/request.ts';
export { RequestError };
const confirmAccount = () => new RequestError(409, '请重新选择材料或开始新对话，并确认当前模型账户。',
  'provider_account_confirmation_required');
const requestedAccount = (route:unknown) => route && typeof route === 'object' && 'accountRevision' in route
  ? route.accountRevision : undefined;

export type CaseId = (typeof cases)[number]['id'] | 'companion' | 'riding';
type TurnRequest = StudyTurnReplay & { selected?: CaseId; req: string; requestedRoute: unknown };
export function caseId(value: unknown): CaseId {
  if (!isStudyCaseId(value)) throw new RequestError(400, '对话类型无效。');
  return value;
}
export { clientRequest } from '../../modules/capture/request.ts';
export type DisplayTurn = TeachingFeedback & {
  writes?: WorkspaceWriteReceipt[];
  workspaceBasis?: (WorkspaceWitness & { readonly title?: string; readonly kind?: string })[];
  learningMemoryDigest?: string; memoryManagement?: true; foregroundDigest?: ForegroundDigest; answer?: string;
};
type Status = 'pending' | 'ready' | 'failed' | 'unknown';
type TurnView = {
  id: string; submission: ReturnType<typeof studyTurn>; backgroundUnderstanding?: ReturnType<typeof turnResearchAccess>;
  feedback: DisplayTurn | null; derivationId: string | null; status: Status; error?: string;
};
export async function requireSessionTurn(tx: ReadTransaction, id: string) {
  try { return await readOwnStudyTurn(tx, id); }
  catch (error) {
    if (isFactUnavailable(error)) throw new RequestError(409, '本次教学引用的依据已经变更。请重新开始一轮。');
    throw error;
  }
}

export async function resolveTurnAuthority(
  tx: ReadTransaction, turnId: string, submission: ReturnType<typeof studyTurn>, manifest: unknown,
  allowed: boolean, grantCurrent: ReturnType<typeof workspaceGrantChecker>, check?: CheckNotionRead, use: 'publish' | 'history' = 'history',
): Promise<'authorized' | 'unconfirmed' | 'withdrawn'> {
  if (!allowed) return 'withdrawn';
  if (!manifest) return 'authorized';
  if (check) return (await teachingResultAuthority(tx, turnId, submission, manifest, grantCurrent, check, undefined, use)).state;
  return await teachingMemoryBasis(tx, parseManifest(manifest), turnId) ? 'authorized' : 'withdrawn';
}

async function history(tx: ReadTransaction, session: string, check?: CheckNotionRead): Promise<TurnView[]> {
  const rows = await listCurrentSlotFacts(tx, {
    factType: 'activity.studyTurn', slotType, keyField: 'sessionId', keyValue: session, limit: 1000,
  });
  const result: TurnView[] = [], grantCurrent = workspaceGrantChecker(tx);
  let materialAvailable = true;
  for (const row of rows) {
    const snapshot = await requireSessionTurn(tx, row.id), stored = studyTurn(snapshot.value);
    if (!stored.parentId && stored.attachment) materialAvailable = await attachmentCurrent(tx, stored) && await grantCurrent(stored);
    const { attachment: _attachment, ...withoutAttachment } = stored;
    const submission = stored.classroom ? { ...withoutAttachment, answer: null } : materialAvailable ? stored : withoutAttachment;
    const authority = row.value
      ? await resolveTurnAuthority(tx, row.id, stored, row.manifest, materialAvailable, grantCurrent, check) : 'withdrawn';
    let feedback = authority === 'authorized' ? row.value as DisplayTurn | null : null;
    if (!feedback && row.settled) feedback = unavailableReply(submission.model, authority === 'unconfirmed');
    const isCrisis = Boolean(((row.value ?? feedback) as { carePause?: unknown } | null)?.carePause);
    result.push({
      id: row.id, submission,
      ...(submission.caseId === 'companion' && !isCrisis ? { backgroundUnderstanding: turnResearchAccess(snapshot) } : {}),
      feedback, derivationId: row.derivationId, status: row.error?.status ?? (feedback ? 'ready' : 'pending'),
      ...(row.error ? { error: row.error.message } : {}),
    });
  }
  return result;
}
export const loadHistory = (db: Db, session: string) => studioHost(db).snapshot(tx => history(tx, session));

export const recentConversations = (db: Db) => studioHost(db).snapshot(async tx => {
  const { rows } = await tx.query<{ id: string; isCrisis: boolean }>(
    `SELECT r.data->>'sessionId' AS id, COALESCE(d.value ? 'carePause', FALSE) AS "isCrisis" FROM facts f
     JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev
     LEFT JOIN slot_state s ON s.learner_id=f.learner_id AND s.slot_type=$2 AND s.slot_key=r.data->>'sessionId'
     LEFT JOIN derivations d ON d.learner_id=s.learner_id AND d.id=COALESCE(s.current_id, s.last_id)
     WHERE f.learner_id=$1 AND f.type='activity.studyTurn' AND f.retracted_rev IS NULL
       AND r.data->>'caseId' IN ('companion','riding') AND NOT (r.data ? 'classroom')
     GROUP BY r.data->>'sessionId', COALESCE(d.value ? 'carePause', FALSE) ORDER BY MAX(f.created_tick) DESC LIMIT 100`,
    [studioLearner, slotType]);
  const result = [];
  for (const row of rows) {
    const fact = await readAvailable(() => readOwnStudyTurn(tx, row.id));
    if (!fact) continue;
    const root = studyTurn(fact.value);
    if (row.isCrisis || evaluateCrisisSupport(root.answer ?? '') !== undefined)
      result.push({ id: row.id, title: '安全支持对话', caseId: root.caseId });
    else if (root.answer) result.push({ id: row.id, title: root.answer.slice(0, 100), caseId: root.caseId });
  }
  return result;
});
async function projectWrites(tx: ReadTransaction, writes: WorkspaceWriteReceipt[]): Promise<WorkspaceWriteView[]> {
  const ids = writes.filter(workspaceWriteNeedsCurrentFact).map(write => write.id);
  if (!ids.length) return writes;
  const facts = new Map((await listFactsStatus(tx, ids)).map(row => [row.id, row]));
  return Promise.all(writes.map(async write => {
    const fact = facts.get(factId(write.id)), savedPage = write.page?.status === 'saved' ? write.page : undefined;
    const checkMemory = write.memory && !savedPage && write.relation?.status !== 'saved';
    if (fact && fact.retractedRev === null && fact.currentRev === write.rev &&
        (!checkMemory || await areMemoryClaimsCurrent(tx, [write.id], undefined, undefined, false, fact.type))) return write;
    const undone = savedPage && await readRecordedCommand(tx, textbookUndoId(savedPage.undo_token));
    return projectStaleWorkspaceWrite(write, Boolean(fact?.retractedRev), undone?.state === 'done');
  }));
}

async function recoverRevokedReceipts(tx: ReadTransaction, turnIds: string[]) {
  if (!turnIds.length) return new Map<string, WorkspaceWriteReceipt[]>();
  const { rows } = await tx.query<{ id: string; writes: WorkspaceWriteReceipt[] }>(
    `SELECT s.slot_key AS id, d.value->'writes' AS writes FROM slot_state s
     JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.last_id
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=ANY($3::text[]) AND jsonb_typeof(d.value->'writes')='array'`,
    [tx.learner, slotType, turnIds]);
  return new Map(rows.map(({ id, writes }) => [id, revokedReplyWriteReceipts(writes)]));
}

async function readableTurnMounts(tx: ReadTransaction, session: string, timeline: readonly TurnView[], check: CheckNotionRead) {
  const last = timeline.at(-1), visible = timeline.filter(row => row.feedback || (row === last && row.status === 'pending'));
  return new Map(await Promise.all(visible.map(async row => [row.id, await turnArtifacts(tx, session, row.id, check)] as const)));
}

export const sessionMountPermissions = (db: Db, session: string) =>
  notionReadScope(db, studioLearner).read(async (tx, check) => {
    const mounts = await readableTurnMounts(tx, session, await history(tx, session, check), check), turns = [...mounts.values()];
    return { authorizedMountIds: turns.flatMap(t => t.snapshots.map(a => a.mountId)), unconfirmed: turns.flatMap(t => t.unconfirmed) };
  });

async function enrichWorkspaceBasis(tx: ReadTransaction, timeline: readonly TurnView[], check: CheckNotionRead) {
  const wanted = new Map(timeline.flatMap(t => (t.feedback?.workspaceBasis ?? []).filter(w => !w.title).map(w => [`${w.id}:${w.rev}:${w.epoch}`, w])));
  if (!wanted.size) return;
  const { rows } = await tx.query<{ id: string; type: string; purpose: readonly string[]; epoch: string; rev: number; data: FactSnapshot['value'] }>(
    `SELECT f.id, f.type, f.purpose, f.access_epoch::text AS epoch, r.rev, r.data
     FROM unnest($2::text[], $3::int[]) AS req(id, rev) JOIN facts f ON f.learner_id=$1 AND f.id=req.id
     JOIN fact_revs r ON (r.learner_id, r.fact_id, r.rev)=(f.learner_id, f.id, req.rev)
     WHERE f.retracted_rev IS NULL AND r.kind='value' AND ('teaching'=ANY(f.purpose) OR 'all'=ANY(f.purpose))`,
    [tx.learner, [...wanted.values()].map(w => w.id), [...wanted.values()].map(w => w.rev)]);
  const meta = new Map<string, { title?: string; kind?: string }>();
  for (const row of rows) if (wanted.has(`${row.id}:${row.rev}:${row.epoch}`)) {
    const fact = { type: row.type, ref: { learner: tx.learner, id: row.id, rev: row.rev }, accessEpoch: row.epoch,
      value: row.data, purpose: row.purpose } as FactSnapshot;
    try { if (row.type === 'capture.source') await check(fact); } catch { continue; }
    meta.set(`${row.id}:${row.rev}:${row.epoch}`, describeBasisFact(row.type, row.data));
  }
  for (const t of timeline) if (t.feedback?.workspaceBasis?.length) t.feedback = { ...t.feedback,
    workspaceBasis: t.feedback.workspaceBasis.map(w => w.title ? w : { ...w, ...meta.get(`${w.id}:${w.rev}:${w.epoch}`) }) };
}

async function readSessionView(
  tx: ReadTransaction, session: string, check: CheckNotionRead, knownMounts: ReadonlySet<string>,
  recall?: (turn: string, derivation: string, kit: StudyKit) => ReturnType<RecallHttp['project']>,
) {
  const timeline = await history(tx, session, check), last = timeline.at(-1);
  if (!last) throw new RequestError(404, '这次学习会话不存在。');
  await enrichWorkspaceBasis(tx, timeline, check);
  const mounts = await readableTurnMounts(tx, session, timeline, check);
  const currentObject = last.submission.classroom ? undefined : last.submission.currentObject;
  const recoveryIds = timeline.filter(row => !row.feedback || row.feedback.action === 'reply_unavailable').map(row => row.id);
  const recovered = await recoverRevokedReceipts(tx, recoveryIds);
  const memory = await recoverTurnMemoryReceipts(tx, recoveryIds.filter(id => !recovered.get(id)?.some(w => w.memory)));
  const turns = await Promise.all(timeline.filter(row => row.feedback || memory.has(row.id)).map(async row => {
    const value = row.feedback ?? unavailableReply(row.submission.model) as DisplayTurn;
    const rawWrites = row.feedback?.writes ?? [...(recovered.get(row.id) ?? []), ...(memory.get(row.id) ?? [])];
    const [writes, projectedRecall] = await Promise.all([
      rawWrites.length ? projectWrites(tx, rawWrites) : undefined,
      row.derivationId && value.studyKit ? recall?.(row.id, row.derivationId, value.studyKit) : undefined,
    ]);
    return {
      ...projectTeachingFeedback(value, projectedRecall), ...(writes && { writes }),
      turnId: row.id, artifacts: mounts.get(row.id)?.snapshots ?? [],
      ...(row.backgroundUnderstanding && { backgroundUnderstanding: row.backgroundUnderstanding }),
      ...(row.submission.answer && { answer: row.submission.answer }),
    };
  }));
  return {
    id: last.submission.sessionId, caseId: last.submission.caseId, currentTurnId: last.id,
    ...(last.backgroundUnderstanding && { backgroundUnderstanding: last.backgroundUnderstanding }),
    ...(timeline[0]?.submission.attachment && { attachment: timeline[0].submission.attachment }),
    ...(currentObject && { currentObject: { alias: currentObjectAlias(currentObject.kind), id: currentObject.id, rev: currentObject.rev } }),
    status: last.status, ...(last.status !== 'ready' && last.submission.answer && { pendingAnswer: last.submission.answer }),
    ...(last.error && { error: last.error }), ...(last.status === 'pending' && { artifacts: mounts.get(last.id)?.snapshots ?? [] }),
    ...mountPermissionFields([...mounts.values()].flatMap(turn => turn.unconfirmed), knownMounts), turns,
  };
}

export const readClassroomSession = (tx: ReadTransaction, session: string, check: CheckNotionRead) =>
  readSessionView(tx, session, check, new Set());

export async function getSession(db: Db, session: string, projectRecall?: RecallHttp['project'], knownMounts: ReadonlySet<string> = new Set()) {
  const notion = notionReadScope(db, studioLearner);
  return notion.read((tx, check) => readSessionView(tx, session, check, knownMounts,
    projectRecall && ((turn, derivation, kit) => projectRecall(session, turn, derivation, kit, notion))));
}
async function fenceTeachingCutover(db: Db) {
  await studioHost(db).lockedTx(async tx => {
    const gate = await tx.query(`SELECT 1 FROM pg_trigger WHERE tgrelid='fact_revs'::regclass AND tgname='studio_confirmed_teaching'`);
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
      await tx.query(`CREATE TRIGGER studio_confirmed_teaching BEFORE INSERT ON fact_revs FOR EACH ROW EXECUTE FUNCTION studio_confirmed_teaching()`);
    }
    const { rows } = await tx.query<{ id: string }>(`
      SELECT w.slot_key AS id FROM work w
      JOIN facts f ON (f.learner_id,f.id)=(w.learner_id,w.slot_key) AND f.type='activity.studyTurn'
      JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      JOIN facts origin ON (origin.learner_id,origin.id)=(f.learner_id,r.data->>'sessionId')
      JOIN fact_revs root ON (root.learner_id,root.fact_id,root.rev)=(origin.learner_id,origin.id,origin.current_rev)
      WHERE w.learner_id=$1 AND w.slot_type=$2 AND w.state='ready' AND r.data->>'accountConfirmation' IS DISTINCT FROM '1'
        AND (r.data ?| ARRAY['attachment','jitContextVersion','accountRevision']
          OR root.data ?| ARRAY['attachment','jitContextVersion','accountRevision'])`,
      [tx.learner, slotType]);
    const ids = rows.map(row => row.id);
    if (!ids.length) return;
    await tx.withLearnerWrite(async tick => {
      await tx.query(`UPDATE work SET state='blocked',execution_ref=NULL WHERE learner_id=$1 AND slot_type=$2
        AND slot_key=ANY($3::text[]) AND state='ready'`, [tx.learner, slotType, ids]);
      await tx.query(`UPDATE slot_state SET pending='none',changed_tick=$4,last_error=$5
        WHERE learner_id=$1 AND slot_type=$2 AND slot_key=ANY($3::text[])`,
        [tx.learner, slotType, ids, tick, JSON.stringify({ status: 'failed', message: confirmAccount().message })]);
    });
  });
}

export async function openStudio(db: Db, activity: LoadedModule, { projectRecall, jitCounters = [], enableJit = false }: {
  projectRecall?: RecallHttp['project']; jitCounters?: readonly StudioJitCounter[]; enableJit?: boolean;
} = {}) {
  const host = studioHost(db);
  const hooks = createStudioCommandHooks({
    async afterFactsChanged(tx, tick, changes) {
      for (const change of changes) {
        if (change.factType !== 'activity.studyTurn' || change.kind !== 'create') continue;
        const { id } = change.ref, submission = studyTurn((await host.read(tx, purpose).fact(id, { mode: 'following' })).value);
        const origin = submission.parentId && submission.accountRevision
          ? studyTurn((await host.read(tx, purpose).fact(submission.sessionId, { mode: 'following' })).value) : submission;
        if (submission.accountRevision) {
          const settings = await checkProviderAccount(tx,
            { providerId: submission.providerId ?? 'default', accountRevision: submission.accountRevision },
            turnTask(submission.caseId, origin.attachment?.mode === 'prepare'));
          if (!settings || !sameRoute(submission, settings) ||
              (submission.workspaceRevision && await workspaceRouteRevision(settings) !== submission.workspaceRevision)) throw confirmAccount();
        }
        if (origin.attachment && !await attachmentCurrent(tx, origin)) throw new RequestError(409, '选段的原件或版本已经变化，请重新打开原文。');
        await tx.insert('slot_state', { learner_id: tx.learner, slot_type: slotType, slot_key: id, scope_keys: '{}', changed_tick: tick });
        const guarded = requiresAccountConfirmation(submission) || requiresAccountConfirmation(origin);
        const deriver = submission.learningToolsVersion ? learningToolsMethod : guarded ? confirmedTeachingMethod : methodName;
        await requestWork(tx, tick, { slotType, slotKey: id, deriver }, guarded ? 'routed_pending' : 'pending');
      }
    },
  });
  const handle = host.boundHandler([activity], hooks);
  await db.query('INSERT INTO learners(id) VALUES($1) ON CONFLICT DO NOTHING', [studioLearner]);
  await fenceTeachingCutover(db);
  for (const studyCase of cases)
    for (const evidence of first45Histories[studyCase.id]) {
      const id = sourceId(studyCase.id, evidence.id);
      await handle({ purpose, type: 'activity.recordEvidence', id: commandId(stableId('seed-record', id)),
        input: { id, data: { title: evidence.title, text: evidence.body } } });
    }
  async function submit(request: TurnRequest, selected: CaseId) {
    const {session, parent, answer, req, grants, requestedRoute, currentObject, allowBackgroundUnderstanding} = request;
    if (allowBackgroundUnderstanding === true && selected !== 'companion') throw new RequestError(400, '本轮后台理解授权仅用于普通同伴对话。');
    const id = parent ? nextTurn(session, parent) : firstTurn(req);
    const origin = parent ? await host.snapshot(async tx => studyTurn((await readOwnStudyTurn(tx, session)).value)) : undefined;
    const requested = request.attachment;
    const attachmentInfo = requested && await host.snapshot(async tx => {
      const bad = (): never => { throw new RequestError(400, '选段须出自所选材料，请重新打开原文。'); };
      const resolved = 'text' in requested ? requested : await readMaterialText(tx, requested.id)
        .then(s => s ? { id: requested.id, title: s.title, text: textSlice(s.text, 0, 16_000).content, mode: requested.mode } : bad());
      const basis = await attachmentSources(tx, resolved);
      return basis ? { attachment: resolved, basis } : bad();
    });
    const attachment = attachmentInfo?.attachment;
    if (requested && attachment) request.attachment = attachment;
    const settings = await loadSettings(turnTask(selected, (origin?.attachment ?? attachment)?.mode === 'prepare'));
    if (grants?.length) {
      if (selected !== 'companion' && selected !== 'riding') throw new RequestError(400, '此活动未开放 MCP 工具。');
      try { resolveMcpGrants(grants, settings); } catch { throw new RequestError(409, 'MCP 设置已变化，请重新选择本轮工具。'); }
    }
    const workspaceRevision = selected === 'companion' && !(origin?.attachment && !origin.workspaceRevision)
      ? await workspaceRouteRevision(settings) : undefined;
    const account = providerAccount(settings), supplied = requestedAccount(requestedRoute);
    const jitCounter = enableJit && account && !parent && workspaceRevision && !grants?.length && !attachment ? studioJitCounter(jitCounters, settings) : undefined;
    const learningToolsVersion = workspaceRevision && account && supplied === account.accountRevision && !jitCounter &&
      !grants?.length && (!origin || origin.learningToolsVersion === 1) ? 1 : undefined;
    const accountRevision = attachment || jitCounter || learningToolsVersion ? account?.accountRevision : origin?.accountRevision;
    const protectedTurn = origin?.attachment || origin?.jitContextVersion || attachment || jitCounter || accountRevision;
    if (protectedTurn || supplied !== undefined) {
      if (!account || supplied !== account.accountRevision || (protectedTurn && origin && !origin.accountConfirmation) ||
          !routeMatchesInput(requestedRoute,settings) || (origin && !sameRoute(origin,settings))) throw confirmAccount();
    } else if (!routeMatchesInput(requestedRoute,settings)) throw new RequestError(409, '模型配置已更改，请重新确认。');
    else if (origin && !sameRoute(origin,settings)) throw new RequestError(422, '这次对话已绑定原模型配置，请切回该配置或新建对话。');
    let boundObject;
    if (currentObject) {
      if (selected !== 'companion' || origin?.attachment || attachment) throw new RequestError(400, '当前学习对象只用于未附选段的自由对话。');
      if (!workspaceRevision) throw new RequestError(403, '此模型未获准访问学习工作区。');
      const opened = await host.snapshot(tx =>
        readCurrentLearningObject(tx, currentObject, notionRecipient(modelRecipientId(settings, workspaceRevision))));
      if (!opened) throw new RequestError(403, '无法为本轮打开该版本及所需依据。请核对教学用途和版本。');
      boundObject = { ...currentObject, basisDigest: opened.basisDigest };
    }
    const data = {
      caseId: selected, sessionId: session, parentId: parent, answer,
      ...(allowBackgroundUnderstanding ? { allowBackgroundUnderstanding: true } : {}),
      ...(attachmentInfo ? { attachment: attachmentInfo.attachment, attachmentBasis: attachmentInfo.basis.digest } : {}),
      ...(boundObject ? { currentObject: boundObject } : {}),
      ...(learningToolsVersion ? { learningToolsVersion } : {}),
      ...(jitCounter ? { jitContextVersion: 1, jitCounterId: jitCounter.id } : {}),
      ...(accountRevision ? { accountRevision, accountConfirmation: 1 } : {}),
      ...((selected === 'companion' || selected === 'riding') ? { agentVersion: workspaceRevision ? 2 : 1, allowSearch: settings.allowSearch } : {}),
      ...(workspaceRevision ? { workspaceRevision, ...(!grants?.length && { memoryVersion: 1 }) } : {}),
      model: settings.model, reasoningEffort: settings.reasoningEffort, providerId: settings.activeProviderId,
      protocol: settings.protocol, baseUrl: settings.baseUrl,
      ...(grants?.length ? { mcpGrants: grants, mcpRevision: mcpRevision(grants, settings) } : {}),
    };
    await handle({ purpose, id: requestCommand(req), type: 'activity.submitTurn', input: { id, data } });
    return getSession(db, session, projectRecall);
  }
  async function replay(request: TurnRequest) {
    const { req, session, requestedRoute } = request;
    const { rows: [row] } = await db.query<{ id: string; data: unknown }>(
      `SELECT r.fact_id AS id, r.data FROM fact_revs r WHERE r.learner_id=$1 AND r.command_id=$2 AND r.rev=1`,
      [studioLearner, requestCommand(req)]);
    if (!row) return null;
    const existing = studyTurn(row.data);
    if (existing.accountConfirmation && requestedAccount(requestedRoute) !== existing.accountRevision) throw confirmAccount();
    if (!matchesStudyTurnReplay(existing, request) || !routeMatchesInput(requestedRoute, {
      activeProviderId: existing.providerId ?? 'default', protocol: existing.protocol === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: existing.baseUrl, model: existing.model, reasoningEffort: existing.reasoningEffort ?? 'high',
    })) throw new RequestError(409, '同一个提交标识已经用于不同内容。');
    return getSession(db, session, projectRecall);
  }
  async function submitOrReplay(request: TurnRequest, selected: string) {
    try { return await submit(request, request.selected ?? caseId(selected)); }
    catch (error) {
      const prior = await replay(request);
      if (prior) return prior;
      if (request.parent && (await loadHistory(db, request.session)).at(-1)?.id !== request.parent)
        throw new RequestError(409, '另一份回答已提交，请刷新会话。');
      throw error;
    }
  }
  const buildRequest = (req: string, session: string, parent: string | null, answer: string | null, requestedMcp?: unknown,
    requestedRoute?: unknown, requestedObject?: unknown, requestedBackground?: unknown, attachment?: TurnRequest['attachment']): TurnRequest => {
    let grants;
    try { grants = studyMcpGrants(requestedMcp); } catch { throw new RequestError(400, '本轮 MCP 工具选择无效。'); }
    const currentObject = studyCurrentObjectRequest(requestedObject);
    if (currentObject === null) throw new RequestError(400, '当前学习对象须包含类型、ID 和版本。');
    if (requestedBackground !== undefined && typeof requestedBackground !== 'boolean') throw new RequestError(400, '本轮后台理解授权无效。');
    return { req, session, parent, answer, ...(attachment ? { attachment } : {}), requestedRoute, grants, currentObject,
      allowBackgroundUnderstanding: requestedStudyBackgroundUnderstanding(requestedBackground) };
  };
  const requireText = (value: unknown, message: string) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new RequestError(400, message);
    return value.trim();
  };
  return {
    classrooms: openClassrooms(db, activity, hooks),
    async start(selected: CaseId, reqId: string, question?: unknown, shared?: unknown, ...rest: unknown[]) {
      const answer = selected === 'companion' || selected === 'riding' ? requireText(question, '请输入 1 至 4000 字的问题。') : null;
      let attachment;
      if (shared !== undefined) {
        if (selected !== 'companion') throw new RequestError(400, '请在自由对话中使用个人材料。');
        try { attachment = studyAttachmentRequest(shared); } catch { throw new RequestError(400, '请选择材料或其片段。'); }
      }
      const req = buildRequest(reqId, firstTurn(reqId), null, answer, rest[0], rest[1], rest[2], rest[3], attachment);
      return await replay(req) ?? submitOrReplay(req, selected);
    },
    async answer(session: string, parent: unknown, input: unknown, reqId: string, ...rest: unknown[]) {
      const text = requireText(input, '请输入 1 至 4000 字的回答。');
      if (typeof parent !== 'string' || !ulidExact.test(parent)) throw new RequestError(400, '提交时须指明当前问题。');
      const req = buildRequest(reqId, session, parent, text, rest[0], rest[1], rest[2], rest[3]);
      const prior = await replay(req);
      if (prior) return prior;
      const last = (await loadHistory(db, session)).at(-1);
      if (!last) throw new RequestError(404, '学习会话不存在。');
      if (last.submission.classroom) throw new RequestError(409, '请在课堂步骤内完成学习活动。');
      if (last.id !== parent) throw new RequestError(409, '此题已有回答，请刷新后查看下一步。');
      if (last.status !== 'ready') throw new RequestError(409, '请先等同伴完成这一轮。');
      return submitOrReplay(req, last.submission.caseId);
    },
  };
}
