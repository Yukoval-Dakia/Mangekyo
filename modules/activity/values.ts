import { factId } from '@mangekyo/kernel';
import { isSourceFactId } from './source-values.ts';

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
  return {
    sessionId: factId(field(value, 'sessionId')),
    caseId: field(value, 'caseId', 120),
    parentId: value.parentId === null ? null : factId(field(value, 'parentId')),
    answer,
    ...(value.memoryVersion === 1 ? {memoryVersion: 1 as const} : {}),
    ...(value.agentVersion === 1 ? {agentVersion: 1 as const, allowSearch: value.allowSearch === true} : {}),
    ...(value.workspaceRevision === undefined ? {} : {workspaceRevision: field(value, 'workspaceRevision', 80)}),
    ...(value.attachment === undefined ? {} : { attachment: studyAttachment(value.attachment) }),
    ...(value.currentObject === undefined ? {} : { currentObject: studyCurrentObject(value.currentObject) }),
    ...(value.providerId === undefined ? {} : {providerId: field(value, 'providerId', 100)}),
    ...(value.protocol === undefined ? {} : {protocol: field(value, 'protocol', 32)}),
    ...(value.mcpRevision === undefined ? {} : {mcpRevision: field(value, 'mcpRevision', 64)}),
    ...(value.mcpGrants === undefined ? {} : {mcpGrants: studyMcpGrants(value.mcpGrants)}),
    model: field(value, 'model', 200),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: field(value, 'reasoningEffort', 40) }),
    baseUrl: field(value, 'baseUrl', 2000),
  };
}
export function studyAttachment(input: unknown) {
  const value = object(input);
  if (value.mode !== 'ask' && value.mode !== 'prepare') throw new Error('材料使用方式无效');
  return {
    id: factId(field(value, 'id')),
    title: field(value, 'title', 240),
    text: field(value, 'text', 3000),
    mode: value.mode as 'ask' | 'prepare',
  };
}
export function studyRecord(input: unknown) {
  const value = object(input);
  return { title: field(value, 'title', 240), text: field(value, 'text') };
}
export function creation<T>(value: (data: unknown) => T) {
  return {
    parse(input: unknown) {
      const record = object(input);
      return { id: factId(field(record, 'id')), data: value(record.data) };
    },
  };
}
