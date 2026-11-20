import { derivationId, factId, type DerivationId, type FactId, type Revision } from '@mangekyo/kernel';
import { object, studyCurrentObjectSelection } from './values.ts';

export const classroomType = 'activity.classroom';
export const classroomCommand = 'activity.writeClassroom';
export const classroomOperations = ['adjust', 'advance', 'skip', 'finish', 'archive'] as const;
export type ClassroomOperation = typeof classroomOperations[number];
type Step = {id: string; title: string; status: 'pending' | 'active' | 'presented' | 'skipped'; turnId?: FactId};
export type Classroom = {
  topic: string; minutes: number; sessionId: FactId;
  status: 'active' | 'finished' | 'archived';
  steps: Step[];
  plans: {turnId: FactId; derivationId: DerivationId}[];
  lastTurnId: FactId;
  pending?: {turnId: FactId; kind: 'start' | 'adjust'};
};
export type ClassroomEvidence = {mountId: FactId; stateRev: number};
export class ClassroomConflict extends Error {}

function boundedText(value: unknown, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('课堂文字无效。');
  return value.trim();
}

export function classroomStart(raw: Record<string, unknown>) {
  const {topic, minutes = 20, currentObject} = raw;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 5 || minutes > 90)
    throw new Error('课堂时长须为 5 到 90 分钟。');
  if (currentObject !== undefined && Object.keys(object(currentObject)).length !== 3)
    throw new Error('当前学习对象须包含类型、ID 和版本。');
  return {topic: boundedText(topic, 300), minutes,
    ...(currentObject === undefined ? {} : {currentObject: studyCurrentObjectSelection(currentObject)})};
}

function idField(value: unknown) {
  if (typeof value !== 'string') throw new Error('课堂引用无效。');
  return factId(value);
}

export function classroomFact(input: unknown): Classroom {
  const raw = object(input);
  const {status} = raw;
  if (status !== 'active' && status !== 'finished' && status !== 'archived')
    throw new Error('课堂状态无效。');
  if (!Array.isArray(raw.plans) || !Array.isArray(raw.steps)) throw new Error('课堂编排无效。');
  const steps = raw.steps.map((entry): Step => {
    const {id,title,status,turnId} = object(entry);
    if (status !== 'pending' && status !== 'active' && status !== 'presented' && status !== 'skipped')
      throw new Error('课堂步骤状态无效。');
    if ((status === 'active' || status === 'presented') && turnId === undefined)
      throw new Error('缺少课堂步骤回合。');
    return {id:boundedText(id,32),title:boundedText(title,180),status,
      ...(turnId === undefined ? {} : {turnId:idField(turnId)})};
  });
  const plans = raw.plans.map(entry => {
    const plan = object(entry);
    if (typeof plan.derivationId !== 'string') throw new Error('缺少课堂编排见证。');
    return {turnId:idField(plan.turnId),derivationId:derivationId(plan.derivationId)};
  });
  const pending = raw.pending === undefined ? undefined : object(raw.pending);
  const {topic,minutes} = classroomStart(raw);
  const state: Classroom = {topic,minutes,status,steps,plans,sessionId:idField(raw.sessionId),lastTurnId:idField(raw.lastTurnId)};
  if (!pending) return state;
  if (status !== 'active' || (pending.kind !== 'start' && pending.kind !== 'adjust'))
    throw new Error('课堂编排状态无效。');
  return {...state,pending:{turnId:idField(pending.turnId),kind:pending.kind}};
}

export function classroomRoute(raw: unknown) {
  if (raw === undefined) return;
  const route = object(raw);
  const {accountRevision} = route;
  if (accountRevision !== undefined && (typeof accountRevision !== 'string' || !/^[0-9a-f-]{36}$/i.test(accountRevision)))
    throw new Error('模型账户代次无效。');
  return {providerId:boundedText(route.providerId,100), protocol:boundedText(route.protocol,32),
    baseUrl:boundedText(route.baseUrl,2000), model:boundedText(route.model,200), reasoningEffort:boundedText(route.reasoningEffort,40),
    ...(accountRevision === undefined ? {} : {accountRevision})};
}

export function classroomMutation(raw: Record<string, unknown>, op: ClassroomOperation) {
  const {expectedRev, note} = raw;
  if (typeof expectedRev !== 'number' || !Number.isSafeInteger(expectedRev) || expectedRev < 1 || expectedRev > 2147483647)
    throw new Error('请指定当前课堂版本。');
  if (note !== undefined && op !== 'adjust') throw new Error('只有调整课堂可附说明。');
  return {expectedRev: expectedRev as Revision, ...(note === undefined ? {} : {note: boundedText(note, 500)})};
}

export function classroomReply(raw: string) {
  const {message, steps} = object(JSON.parse(raw));
  if (!Array.isArray(steps) || steps.length > 8 || !steps.length)
    throw new Error('生成的课堂编排无效。');
  return {message: boundedText(message, 8000), steps: steps.map(title => boundedText(title, 180))};
}

export function seedClassroom(start: ReturnType<typeof classroomStart>, sessionId: FactId): Classroom {
  return {topic: start.topic, minutes: start.minutes, sessionId, status:'active', steps:[], plans:[], lastTurnId:sessionId,
    pending:{turnId:sessionId,kind:'start'}};
}

export function classroomPlan(state: Classroom, titles: readonly string[], derivationId: DerivationId): Classroom {
  const {pending, ...base} = state;
  if (!pending) return state;
  const frozen = state.steps.filter(step => step.status !== 'pending');
  const steps = titles.map((title, index): Step => {
    const id = pending.turnId + '-' + (index + 1);
    return pending.kind === 'start' && index === 0
      ? {id,title,status:'active',turnId:pending.turnId}
      : {id,title,status:'pending'};
  });
  return {...base, steps:[...frozen,...steps], plans:[...base.plans,{turnId:pending.turnId,derivationId}]};
}

export function activeClassroomStep(state: Classroom) {
  return state.steps.find(step => step.status === 'active');
}

export function transitionClassroom(state: Classroom, op: ClassroomOperation, turnId: FactId): Classroom {
  const active = activeClassroomStep(state);
  if (op === 'archive' && state.status === 'finished') return {...state,status:'archived'};
  if (state.status !== 'active' || op === 'archive') throw new ClassroomConflict('课堂状态不支持此操作。');
  if (state.pending && op !== 'finish') throw new ClassroomConflict('请先等课堂编排完成。');
  if (!active && op !== 'finish') throw new ClassroomConflict('本课堂还没有可操作的步骤。');
  if (op === 'adjust') {
    if (!active || !state.steps.some(step => step.status === 'pending'))
      throw new ClassroomConflict('调整需要当前步骤及尚未呈现的内容。');
    return {...state,lastTurnId:turnId,pending:{turnId,kind:'adjust'}};
  }
  const next = op === 'finish' ? undefined : state.steps.find(step => step.status === 'pending');
  const {pending: _pending, ...base} = state;
  return {...base,...(next ? {lastTurnId:turnId} : {}),status:next ? 'active' : 'finished',steps:state.steps.map(step => {
    if (step.id === next?.id) return {...step,status:'active',turnId};
    if (step === active) return {...step,status:op === 'skip' ? 'skipped' : 'presented'};
    if (!next && step.status === 'pending') return {...step,status:'skipped'};
    return step;
  })};
}

export function classroomPrompt(mode: 'start' | 'adjust' | 'advance', state: Classroom, note?: string) {
  const topic = JSON.stringify(state.topic);
  const active = activeClassroomStep(state);
  if (mode === 'advance') return `继续课堂 ${topic}，只呈现当前步骤 ${JSON.stringify(active?.title)}。按教学需要挂载作品。不要提前呈现后续步骤。`;
  const format = '最终仅返回 JSON {"message":"给学生看的正文","steps":["步骤标题"]}，标题最多八个，不含题目答案和隐藏评分依据。';
  if (mode === 'start') return `正式开课：主题 ${topic}，约 ${state.minutes} 分钟。根据本次主题及获准资料编排至少两个步骤，只讲第一步。调用 mount_artifact 挂载适合主题的可调作品及先作预测再揭示的随堂检查，勿在正文泄露隐藏答案。steps 包含第一步及其后计划。${format}`;
  return `调整课堂 ${topic}。当前步骤 ${JSON.stringify(active?.title)} 保持原样。现有未来步骤：${JSON.stringify(state.steps.filter(step => step.status === 'pending').map(step => step.title))}。根据宿主提供的本次实际交互或评估，调整尚未呈现步骤，勿把有提示的作答当独立掌握。勿渲染新步骤或调用作品工具；steps 仅包含调整后的未来步骤。${note ? ' 学习者说明：' + JSON.stringify(note) : ''}${format}`;
}

export function classroomTurn(value: unknown) {
  const {mode, evidence, evidenceTurn} = object(value);
  if (mode !== 'start' && mode !== 'adjust' && mode !== 'advance') throw new Error('课堂回合无效。');
  if (!Array.isArray(evidence) || evidence.length > 16 || (mode === 'adjust') !== Boolean(evidence.length))
    throw new Error('课堂证据无效。');
  if (mode === 'adjust' && typeof evidenceTurn !== 'string') throw new Error('缺少课堂证据回合。');
  return {mode, ...(typeof evidenceTurn === 'string' ? {evidenceTurn:factId(evidenceTurn)} : {}), evidence: evidence.map((item): ClassroomEvidence => {
    const {mountId, stateRev} = object(item);
    if (typeof mountId !== 'string' || typeof stateRev !== 'number' || !Number.isSafeInteger(stateRev) || stateRev < 1)
      throw new Error('课堂证据版本无效。');
    return {mountId:factId(mountId),stateRev};
  })};
}
