import { factId, type FactSnapshot } from '@mangekyo/kernel';
import { classroomTurn } from './classroom.ts';
import { isSourceFactId } from './source-values.ts';

export const turnResearchPurpose = 'background-research';

export function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('记录格式无效');
  return input as Record<string, unknown>;
}
function field(input: Record<string, unknown>, key: string, limit = 4000): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('记录字段无效');
  return value;
}
export function studyMcpGrants(input: unknown) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 32) throw new Error('MCP 服务选择无效。');
  const ids = new Set<string>();
  return input.map(item => {
    const server = object(item);
    const id = field(server, 'id', 100);
    const url = field(server, 'url', 2000);
    const names = server.allowedTools;
    if (ids.has(id) || !Array.isArray(names) || !names.length || names.length > 128 ||
        !names.every((name): name is string => typeof name === 'string' && name.length > 0 && name.length <= 256) ||
        new Set(names).size !== names.length) throw new Error('MCP 工具选择无效。');
    ids.add(id);
    return {id, url, allowedTools: [...names].sort()};
  }).sort((a,b) => a.id.localeCompare(b.id));
}
export function studyCurrentObjectSelection(input: unknown) {
  const { kind, id, rev } = object(input);
  if ((kind !== 'attempt' && kind !== 'page') || !isSourceFactId(id) ||
      typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1 || rev > 2_147_483_647) {
    throw new Error('当前学习对象须包含类型、ID 和版本。');
  }
  return { kind, id, rev };
}
export type StudyCurrentObjectSelection = ReturnType<typeof studyCurrentObjectSelection>;

function studyCurrentObject(input: unknown) {
  const selection = studyCurrentObjectSelection(input);
  const basisDigest = field(object(input), 'basisDigest', 64);
  if (!/^[0-9a-f]{64}$/.test(basisDigest)) throw new Error('当前学习对象的读取见证无效。');
  return { ...selection, basisDigest };
}
export function studyTurn(input: unknown) {
  const value = object(input);
  const answer = value.answer === null ? null : field(value, 'answer');
  const caseId = field(value, 'caseId', 120);
  const optedIn = value.allowBackgroundUnderstanding;
  if (optedIn !== undefined && (optedIn !== true || caseId !== 'companion' || answer === null))
    throw new Error('本轮后台理解授权无效。');
  const accountRevision = value.accountRevision;
  if (accountRevision !== undefined && (typeof accountRevision !== 'string' || !/^[0-9a-f-]{36}$/.test(accountRevision)))
    throw new Error('模型账户代次无效。');
  if (value.jitContextVersion !== undefined && value.jitContextVersion !== 1)
    throw new Error('首轮教学资料版本无效。');
  return {
    sessionId: factId(field(value, 'sessionId')),
    caseId,
    parentId: value.parentId === null ? null : factId(field(value, 'parentId')),
    answer,
    ...(optedIn === true ? {allowBackgroundUnderstanding: true as const} : {}),
    ...(value.classroom === undefined ? {} : {classroom: classroomTurn(value.classroom)}),
    ...(value.learningToolsVersion === 1 ? {learningToolsVersion:1 as const} : {}),
    ...(value.memoryVersion === 1 ? {memoryVersion: 1 as const} : {}),
    ...(value.jitContextVersion === 1 ? {jitContextVersion: 1 as const, jitCounterId: field(value, 'jitCounterId', 100)} : {}),
    ...(value.agentVersion === 1 || value.agentVersion === 2 ? {agentVersion: value.agentVersion, allowSearch: value.allowSearch === true} : {}),
    ...(value.workspaceRevision === undefined ? {} : {workspaceRevision: field(value, 'workspaceRevision', 80)}),
    ...(value.attachment === undefined ? {} : { attachment: studyAttachment(value.attachment) }),
    ...(value.attachmentBasis === undefined ? {} : {attachmentBasis: field(value, 'attachmentBasis', 64)}),
    ...(value.currentObject === undefined ? {} : { currentObject: studyCurrentObject(value.currentObject) }),
    ...(accountRevision ? {accountRevision} : {}),
    ...(value.accountConfirmation === 1 && accountRevision ? {accountConfirmation:1 as const} : {}),
    ...(value.providerId === undefined ? {} : {providerId: field(value, 'providerId', 100)}),
    ...(value.protocol === undefined ? {} : {protocol: field(value, 'protocol', 32)}),
    ...(value.mcpRevision === undefined ? {} : {mcpRevision: field(value, 'mcpRevision', 64)}),
    ...(value.mcpGrants === undefined ? {} : {mcpGrants: studyMcpGrants(value.mcpGrants)}),
    model: field(value, 'model', 200),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: field(value, 'reasoningEffort', 40) }),
    baseUrl: field(value, 'baseUrl', 2000),
  };
}
export type StudyTurnReplay = {
  selected?: string;
  session: string;
  parent: string | null;
  answer: string | null;
  attachment?: ReturnType<typeof studyAttachmentRequest> | undefined;
  grants: ReturnType<typeof studyMcpGrants>;
  currentObject: StudyCurrentObjectSelection | undefined;
  allowBackgroundUnderstanding: boolean;
};

export function matchesStudyTurnReplay(existing: ReturnType<typeof studyTurn>, request: StudyTurnReplay) {
  const { selected, session, parent, answer, attachment, grants, currentObject, allowBackgroundUnderstanding } = request;
  return existing.sessionId === session && existing.parentId === parent && existing.answer === answer &&
    (!selected || existing.caseId === selected) &&
    JSON.stringify(existing.mcpGrants ?? []) === JSON.stringify(grants) &&
    existing.currentObject?.kind === currentObject?.kind &&
    existing.currentObject?.id === currentObject?.id &&
    existing.currentObject?.rev === currentObject?.rev &&
    JSON.stringify(existing.attachment) === JSON.stringify(attachment) &&
    (existing.allowBackgroundUnderstanding ?? false) === allowBackgroundUnderstanding;
}

export function turnAllowsBackgroundUnderstanding(fact: FactSnapshot) {
  return fact.type === 'activity.studyTurn' && fact.purpose.includes(turnResearchPurpose) &&
    studyTurn(fact.value).allowBackgroundUnderstanding === true;
}
export const turnResearchAccess = (fact: FactSnapshot) => ({
  allowed: turnAllowsBackgroundUnderstanding(fact), rev: fact.ref.rev, accessEpoch: fact.accessEpoch,
});
export function studyAttachment(input: unknown) {
  const value = object(input);
  if (value.mode !== 'ask' && value.mode !== 'prepare') throw new Error('材料使用方式无效');
  return {
    id: factId(field(value, 'id')),
    title: field(value, 'title', 240),
    text: field(value, 'text', 16_000),
    mode: value.mode as 'ask' | 'prepare',
  };
}
export function studyAttachmentRequest(input: unknown) {
  const value = object(input);
  if (value.mode !== 'ask' && value.mode !== 'prepare') throw new Error('材料使用方式无效');
  if (value.title === undefined && value.text === undefined)
    return { id: factId(field(value, 'id')), mode: value.mode as 'ask' | 'prepare' };
  return studyAttachment(input);
}
export const submitOfflinePack = 'activity.submitOfflinePack';
export const studyRecordType = 'activity.studyRecord';

export function offlinePackRecord(input: unknown) {
  const value = object(input);
  const id = field(value, 'id', 120);
  const { rev, choice, result } = value;
  if (!/^pack\/[a-z-]+$/.test(id) || typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1 ||
      typeof choice !== 'number' || !Number.isSafeInteger(choice) || choice < 0 ||
      (result !== 'correct' && result !== 'incorrect')) throw new Error('内置活动提交无效。');
  return { id, rev, choice, result };
}

export function studyRecord(input: unknown) {
  const value = object(input);
  return { title: field(value, 'title', 240), text: field(value, 'text') };
}
export function studyRecordFact(input: unknown) {
  const value = object(input);
  return {
    ...studyRecord(value),
    ...(value.offlinePack === undefined ? {} : {
      offlinePack: offlinePackRecord(value.offlinePack),
      submittedAt: new Date(field(value, 'submittedAt', 40)).toISOString(),
    }),
  };
}
export function creation<T>(value: (data: unknown) => T) {
  return {
    parse(input: unknown) {
      const record = object(input);
      return { id: factId(field(record, 'id')), data: value(record.data) };
    },
  };
}
