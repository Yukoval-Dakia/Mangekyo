import { classroomCommand, classroomMutation, classroomPlan, classroomPrompt, classroomStart, classroomRoute, classroomFact,
  activeClassroomStep, classroomType, recoverClassroomAdjustment, seedClassroom, transitionClassroom, ClassroomConflict,
  type Classroom, type ClassroomOperation } from '../../modules/activity/classroom.ts';
import { bindClassroomPreparation } from '../../modules/activity/classroom-command-read.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { commandId, derivationId, factId, type DerivationId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { notionReadScope, notionSendBasis, NotionReadUnconfirmed, teachingResultAuthority, type CheckNotionRead } from './notion.ts';
import { routeMatchesInput, sameRoute, workspaceGrantChecker, workspaceRouteRevision } from './harness.ts';
import { freezeProviderAccount, loadSettings, providerAccount } from './settings.ts';
import { readCurrentLearningObject } from './current-learning-object.ts';
import { RequestError, clientRequest, readClassroomSession, type DisplayTurn } from './sessions.ts';
import { classroomMountEvidence } from './presentation-store.ts';
import { notionModelRecipient, stableId, studioLearner, purpose, slotType } from './identity.ts';

const scope = {learner:studioLearner};
const unavailable = () => new RequestError(404,'这次课堂不可读。');
const conflict = (error: string) => new RequestError(409,error);
const readTurn = async (tx: ReadTransaction, id: FactId) =>
  studyTurn((await createCommandReadContext(tx,purpose).fact(id,{mode:'following'})).value);
const classroomId = (session: string) => factId(stableId('classroom',session));

async function authorizedReply(tx: ReadTransaction, id: FactId, check: CheckNotionRead, pinned?: DerivationId) {
  const {rows:[row]} = await tx.query<{id: string | null; value:DisplayTurn | null; manifest:unknown; failed:boolean}>(`
    SELECT d.id,d.value,d.manifest,(s.last_error IS NOT NULL OR s.last_id IS NOT NULL) AS failed FROM slot_state s LEFT JOIN derivations d
      ON (d.learner_id,d.slot_type,d.slot_key)=(s.learner_id,s.slot_type,s.slot_key)
      AND d.id=coalesce($4,s.current_id) AND NOT d.is_shadow AND d.lifecycle='effective' AND d.invalidated_tick IS NULL
    WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3`,[tx.learner,slotType,id,pinned ?? null]);
  if (!row?.id || !row.value) return {status:row?.failed ? 'failed' as const : 'pending' as const};
  const authority = await teachingResultAuthority(tx,await readTurn(tx,id),row.manifest,workspaceGrantChecker(tx),check);
  if (authority === 'unconfirmed') throw new RequestError(503,'暂时无法核对课堂依据。');
  if (authority !== 'authorized') throw unavailable();
  return {status:'ready' as const, steps:row.value.classroomPlan,derivationId:derivationId(row.id)};
}

async function rawClassroom(tx: ReadTransaction, id: FactId) {
  const fact = await createCommandReadContext(tx,purpose).fact<Classroom>(id,{mode:'following'});
  if (fact.type !== classroomType) throw unavailable();
  return {...fact,value:classroomFact(fact.value)};
}

export async function assertClassroomAction(tx: ReadTransaction, session: string, turn: string) {
  if (!(await readTurn(tx,factId(session))).classroom) return;
  const {value:state} = await rawClassroom(tx,classroomId(session));
  const active = activeClassroomStep(state)?.turnId ?? (state.pending?.kind === 'start' ? state.pending.turnId : undefined);
  if (state.status !== 'active' || active !== turn) throw conflict('此课堂步骤已停止接收新操作。');
}

async function readClassroom(tx: ReadTransaction, id: FactId, check: CheckNotionRead) {
  const fact = await rawClassroom(tx,id);
  let state = fact.value;
  const origin = await readTurn(tx,state.sessionId);
  if (!origin.classroom || !await workspaceGrantChecker(tx)(origin)) throw unavailable();
  for (const plan of state.plans)
    if ((await authorizedReply(tx,plan.turnId,check,plan.derivationId)).status !== 'ready') throw unavailable();
  if (!state.plans.length && origin.currentObject && origin.workspaceRevision && origin.providerId && origin.protocol) {
    const recipient = Object.assign(() => true,{notionRecipientId:notionModelRecipient(origin.providerId,origin.baseUrl,
      origin.protocol,origin.model,origin.workspaceRevision)});
    const opened = await readCurrentLearningObject(tx,origin.currentObject,recipient);
    if (!opened || opened.basisDigest !== origin.currentObject.basisDigest) throw unavailable();
    try { await notionSendBasis(tx,opened.basis,recipient,check); }
    catch (error) {
      if (error instanceof NotionReadUnconfirmed) throw new RequestError(503,'暂时无法核对课堂依据。');
      if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) throw unavailable();
      throw error;
    }
  }
  const request = state.pending;
  const pending = request && await authorizedReply(tx,request.turnId,check);
  const adjustmentFailed = request?.kind === 'adjust' && pending?.status === 'failed';
  if (adjustmentFailed) {
    const rejected = await readTurn(tx,request.turnId);
    if (rejected.sessionId !== state.sessionId || rejected.classroom?.mode !== 'adjust' || !rejected.parentId) throw unavailable();
    state = recoverClassroomAdjustment(state,rejected.parentId);
  }
  if (pending?.status === 'ready') {
    if (!pending.steps) throw unavailable();
    state = classroomPlan(state,pending.steps,pending.derivationId);
  }
  const active = activeClassroomStep(state);
  const step = active && await authorizedReply(tx,active.turnId!,check);
  const generation = adjustmentFailed || pending?.status === 'ready' ? step?.status : pending?.status ?? step?.status;
  return {fact,state,origin,generation,adjustmentFailed};
}

async function handleErrors<T>(run: () => Promise<T>) {
  try { return await run(); }
  catch (error) {
    if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) throw unavailable();
    if (error instanceof ClassroomConflict) throw conflict(error.message);
    if (error instanceof Error && /different command identity/.test(error.message)) throw conflict('课堂请求标识已用于不同操作。');
    throw error;
  }
}
function input<T>(parse: () => T) {
  try { return parse(); }
  catch (error) { throw new RequestError(400,error instanceof Error ? error.message : '课堂输入无效。'); }
}

export function openClassrooms(db: Db, activity: LoadedModule, hooks: CommandHooks) {
  const view = async (tx: ReadTransaction, id: FactId, check: CheckNotionRead) => {
    const {fact,state,generation,adjustmentFailed} = await readClassroom(tx,id,check);
    const {topic,minutes,sessionId,status,steps} = state;
    return {id,rev:fact.ref.rev,topic,minutes,sessionId,status,steps,activeStepId:activeClassroomStep(state)?.id ?? null,
      ...(generation ? {generation} : {}),...(adjustmentFailed ? {adjustmentFailed:true as const} : {})};
  };
  const get = (id: FactId) => handleErrors(() => notionReadScope(db,studioLearner).read((tx,check) => view(tx,id,check)));
  const print = (id: FactId) => handleErrors(() => notionReadScope(db,studioLearner,{readOnly:true}).read(async (tx,check) => {
    const classroom = await view(tx,id,check);
    const session = await readClassroomSession(tx,classroom.sessionId,check);
    return {classroom,session};
  }));

  async function start(raw: Record<string, unknown>) {
    const requestId = clientRequest(raw.requestId);
    const start = input(() => classroomStart(raw));
    const sessionId = factId(stableId('classroom-session',requestId));
    const id = classroomId(sessionId);
    const state = seedClassroom(start,sessionId);
    const route = input(() => classroomRoute(raw.route));
    const handle = createCommandHandler(db,{modules:[activity],hooks,bindCommandRead:(tx,_request,base) =>
      bindClassroomPreparation(base,async () => {
        const settings = start.currentObject ? await loadSettings('companion') : (await freezeProviderAccount(tx,'companion')).settings;
        const account = providerAccount(settings);
        if (!routeMatchesInput(route,settings) || (route?.accountRevision !== undefined && route.accountRevision !== account?.accountRevision))
          throw conflict('模型配置已变更，请重新确认。');
        const workspaceRevision = start.currentObject && await workspaceRouteRevision(settings);
        const recipient = workspaceRevision && notionModelRecipient(settings.activeProviderId,settings.baseUrl,settings.protocol,settings.model,workspaceRevision);
        if (start.currentObject && (!recipient || !account || route?.accountRevision !== account.accountRevision))
          throw new RequestError(403,'请确认模型账户与工作区教学授权。');
        const source = start.currentObject && recipient && await readCurrentLearningObject(tx,start.currentObject,
          Object.assign(() => true,{notionRecipientId:recipient}));
        if (start.currentObject && !source) throw unavailable();
        return {state,turn:{id:sessionId,data:studyTurn({
          caseId:'companion', sessionId, parentId:null, answer:classroomPrompt('start',state),
          classroom:{mode:'start',evidence:[]}, agentVersion:1,
          ...(workspaceRevision ? {workspaceRevision} : {}),
          ...(source ? {currentObject:{...start.currentObject,basisDigest:source.basisDigest}} : {}),
          ...(account && account.accountRevision ? {accountRevision:account.accountRevision,accountConfirmation:1} : {}),
          providerId:settings.activeProviderId, protocol:settings.protocol, model:settings.model,
          baseUrl:settings.baseUrl, reasoningEffort:settings.reasoningEffort,
        })}};
      })});
    await handleErrors(() => handle({...scope,actor:'learner',purpose,id:commandId(stableId('classroom-command',requestId)),
      type:classroomCommand,input:{id,start,route:route ?? null}}));
    return get(id);
  }

  async function mutate(id: FactId, op: ClassroomOperation, raw: Record<string, unknown>) {
    const requestId = clientRequest(raw.requestId);
    const mutation = input(() => classroomMutation(raw,op));
    const notion = notionReadScope(db,studioLearner);
    const turnId = factId(stableId('classroom-turn',id,requestId));
    const prepare = async (tx: ReadTransaction, check: CheckNotionRead) => {
      const {fact,state,origin,generation} = await readClassroom(tx,id,check);
      if (fact.ref.rev !== mutation.expectedRev) throw conflict('课堂已更新，请刷新。');
      if (generation === 'pending') throw conflict('请先等当前课堂回合完成。');
      const next = transitionClassroom(state,op,turnId);
      const active = activeClassroomStep(state);
      const mode = op === 'adjust' ? 'adjust' : activeClassroomStep(next)?.turnId === turnId ? 'advance' : undefined;
      if (!mode) return {state:next,expectedRev:mutation.expectedRev};
      const evidence = mode === 'adjust' && active?.turnId
        ? await classroomMountEvidence(tx,state.sessionId,active.turnId,check) : [];
      const noteOnly = mode === 'adjust' && evidence.length === 0;
      if (noteOnly && !mutation.note) throw conflict('请说明希望调整的内容，或先完成课堂作品。');
      if (!sameRoute(origin,await loadSettings('companion'))) throw conflict('课堂绑定的模型已变更。');
      const parentId = state.lastTurnId;
      return {state:next,expectedRev:mutation.expectedRev,turn:{id:turnId,data:studyTurn({...origin,parentId,
        answer:classroomPrompt(mode,mode === 'adjust' ? state : next,mutation.note),classroom:{mode,evidence,...(noteOnly ? {noteOnly} : {}),...(mode === 'adjust' ? {evidenceTurn:active?.turnId} : {})}})}};
    };
    // Probe remotely outside the learner lock. The command repeats all local checks under the lock.
    try { await notion.read(prepare); }
    catch (error) {
      if (!(error instanceof RequestError || error instanceof ClassroomConflict ||
            error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
      // Replay bypasses a now-stale expectedRev but still goes through authorized get().
    }
    const handle = createCommandHandler(db,{modules:[activity],hooks,bindCommandRead:(tx,_request,base) =>
      bindClassroomPreparation(base,() => prepare(tx,notion.check(tx)))});
    await handleErrors(() => handle({...scope,actor:'learner',purpose,id:commandId(stableId('classroom-command',requestId)),
      type:classroomCommand,input:{id,op,...mutation}}));
    return get(id);
  }
  return {start,get,mutate,print};
}

export const classroomPath = /^\/api\/classrooms(?:\/([0-9A-HJKMNP-TV-Z]{26})(?:\/(adjust|advance|skip|finish|archive|print))?)?$/;
export { factId };
