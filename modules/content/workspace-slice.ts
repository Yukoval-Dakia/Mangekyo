import type { FactId, ManifestInput, Revision } from '@mangekyo/kernel';
import { assetType, questionAsset } from './asset.ts';
export { assetType };
import { knowledgeEdgeEvidenceType, knowledgeEdgeType, sourceUse } from './knowledge-edge.ts';
import type { parseSaveQuestion } from './question-authoring.ts';
import type { parseSavePage } from './textbook-edits.ts';
import { textbookPageType } from './textbook-page.ts';

export const ulidFactPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const wholeAnchor = { kind: 'whole' } as const;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const teachingFailureTable = {
  settings: [400, '开放设置无效。'],
  purpose: [400, '记录用途无效。'],
  revision: [400, '记录版本无效。'],
  missing: [404, '找不到这条学习记录。'],
  'source-type': [400, '请选择教材、试卷或来源题。'],
  conflict: [409, '这条记录已在别处更新。请刷新后再试。'],
  'intake-mismatch': [409, '材料与交入记录不匹配。'],
  'all-purposes': [409, '这条记录已设置为全部用途。'],
  'no-purpose': [409, '这条记录当前没有可用的读取用途。'],
} as const;

export type TeachingFailureReason = keyof typeof teachingFailureTable;
export function lookupTeachingFailure(reason: TeachingFailureReason): readonly [number, string] {
  return teachingFailureTable[reason];
}

export function validateRouteGrantInput(input: unknown, providerPattern: RegExp):
  { readonly ok: true; readonly id: string; readonly enabled: boolean; readonly baseUrl: string; readonly protocol: string }
  | { readonly ok: false; readonly message: string } {
  const value = isPlainObject(input) ? input : null;
  if (!value || typeof value.enabled !== 'boolean') return { ok: false, message: '授权设置无效。' };
  if (typeof value.id !== 'string' || !providerPattern.test(value.id)) return { ok: false, message: '模型配置无效。' };
  if (typeof value.baseUrl !== 'string' || typeof value.protocol !== 'string') return { ok: false, message: '模型端点或协议无效。' };
  return { ok: true, id: value.id, enabled: value.enabled, baseUrl: value.baseUrl, protocol: value.protocol };
}

export function buildUpdatedRouteEntry<TProtocol extends string>(
  previous: { readonly enabled: boolean; readonly baseUrl: string; readonly protocol: TProtocol; readonly revision: string; readonly credentialRevision?: string } | undefined,
  provider: { readonly baseUrl: string; readonly protocol: TProtocol; readonly credentialRevision?: string },
  enabled: boolean,
  freshRevision: string,
) {
  const unchanged = previous?.enabled === enabled && previous.baseUrl === provider.baseUrl &&
    previous.protocol === provider.protocol && previous.credentialRevision === provider.credentialRevision;
  return {
    enabled, baseUrl: provider.baseUrl, protocol: provider.protocol,
    revision: unchanged ? previous.revision : freshRevision,
    ...(provider.credentialRevision ? { credentialRevision: provider.credentialRevision } : {}),
  };
}

const advancedQueryKeys = ['conceptId', 'since', 'exposureFilter', 'tags', 'kinds'] as const;
export function parseAdvancedWorkspaceListParams(params: URLSearchParams): Record<string, unknown> | null {
  if (!advancedQueryKeys.some(key => params.has(key))) return null;
  const args: Record<string, unknown> = Object.fromEntries(params);
  for (const name of ['tags', 'kinds', 'edgeKinds']) if (params.has(name)) args[name] = params.getAll(name);
  if (params.has('hops')) args.hops = Number(params.get('hops'));
  return args;
}

export function projectWorkspacePreview<T extends { readonly id: string; readonly rev: number; readonly sourceRef: unknown; readonly title: string; readonly content: unknown }>(
  source: T,
  anchorKind: string,
  wholePrompts?: string,
) {
  const { id, rev, sourceRef, title } = source;
  if (anchorKind === 'answer-slot') return { id, rev, sourceRef, title, content: null };
  if (anchorKind === 'question') return { id, rev, sourceRef, title, content: source.content };
  return wholePrompts === undefined ? source : { id, rev, sourceRef, title, content: wholePrompts };
}

export function buildWorkspaceTeachingCommand(
  currentType: string,
  use: string,
  itemId: FactId,
  expectedRev: number,
  enabled: boolean,
  defaultCommand: string,
  intakeId?: string,
) {
  const type = currentType === textbookPageType
    ? (use === 'teaching' ? 'content.setTextbookTeaching' : 'content.setTextbookResearch')
    : defaultCommand;
  const input = {
    id: itemId, expectedRev, enabled,
    ...(use === 'background-research' && currentType !== textbookPageType ? { use } : {}),
    ...(intakeId ? { intakeId } : {}),
  };
  return { type, input };
}

type RelationRefLike = {
  readonly fact: { readonly id: string; readonly rev: number; readonly type: string };
  readonly anchor: { readonly kind: string };
  readonly textFact?: unknown;
};

export type RelationPickedItem<TWitness extends { readonly id: string; readonly rev: number; readonly epoch: string }> = {
  readonly ref: RelationRefLike;
  readonly witness: TWitness;
};

export function resolveOpenedRelationInputs<TWitness extends { readonly id: string; readonly rev: number; readonly epoch: string }>(
  parsedInputs: readonly { readonly field: string; readonly ref: string | RelationRefLike | undefined }[],
  opened: ReadonlyMap<string, RelationPickedItem<TWitness>>,
  limit: number,
  modelBasis: readonly { readonly id: string; readonly rev: number; readonly epoch: string }[],
  hasVerification: boolean,
) {
  const picked: RelationPickedItem<TWitness>[] = [];
  for (const { field, ref } of parsedInputs) {
    if (!ref || (typeof ref !== 'string' && ref.anchor.kind !== 'whole')) {
      return { ok: false as const, code: 'invalid_args' as const, field, message: '请传整份记录的 id 或固定 sourceRef。', retryKind: 'retry' as const };
    }
    const id = typeof ref === 'string' ? ref : ref.fact.id;
    const versions = [...opened.values()].filter(item => item.ref.fact.id === id);
    const source = typeof ref === 'string' ? versions.at(-1) : opened.get(`${ref.fact.id}:${ref.fact.rev}`);
    if (!source || (typeof ref !== 'string' && (source.ref.fact.type !== ref.fact.type ||
        JSON.stringify(source.ref.textFact) !== JSON.stringify(ref.textFact)))) {
      return versions.length
        ? { ok: false as const, code: 'version_conflict' as const, field, message: '引用版本与本轮打开的版本不符。', retryKind: 'reopen' as const, reopenRefs: id }
        : { ok: false as const, code: 'evidence_not_opened' as const, field, message: '请先打开本轮要引用的记录。', retryKind: 'reopen' as const, reopenRefs: typeof ref === 'string' ? ref : JSON.stringify(ref) };
    }
    if (source.ref.textFact) {
      return { ok: false as const, code: 'invalid_args' as const, field, message: '配对材料请把固定原件用作来源。', retryKind: 'reopen' as const, reopenRefs: JSON.stringify({ v: 1, fact: source.ref.textFact, anchor: wholeAnchor }) };
    }
    if ((field === 'verification') !== (source.ref.fact.type === knowledgeEdgeEvidenceType)) {
      return { ok: false as const, code: 'invalid_args' as const, field, message: '核验证明只接受已打开的专用证明事实。', retryKind: 'retry' as const };
    }
    picked.push(source);
  }
  const refs = [...new Set(picked.map(({ ref }) => ref.fact.id))].slice(0, limit);
  const uses = picked.map(({ witness: w }) => sourceUse({ id: w.id, rev: w.rev, accessEpoch: w.epoch }));
  const proof = hasVerification ? uses.pop()! : undefined;
  for (const { id, rev, epoch } of modelBasis) uses.push(sourceUse({ id, rev, accessEpoch: epoch }));
  return { ok: true as const, picked, refs, uses, proof };
}

export function projectConfirmedRelationState(
  fact: { readonly current_rev: number; readonly retracted_rev: number | null } | undefined,
  edgeId: string,
  undoToken: string,
) {
  if (fact?.retracted_rev) return { status: 'withdrawn' as const };
  if (fact?.current_rev === 1) {
    return { status: 'saved' as const, rev: 1, ref: { v: 1, fact: { id: edgeId, rev: 1, type: knowledgeEdgeType }, anchor: wholeAnchor }, undo_token: undoToken };
  }
  return { status: 'changed' as const };
}

export function extractAssessmentManifestFacts(
  inputs: readonly ManifestInput[],
  attemptId: string,
  syntheticIds: ReadonlySet<string>,
): Extract<ManifestInput, { kind: 'fact' }>[] | null {
  const facts: Extract<ManifestInput, { kind: 'fact' }>[] = [];
  for (const input of inputs) {
    if (input.kind !== 'fact' || syntheticIds.has(input.id)) return null;
    facts.push(input.id === attemptId ? { ...input, mode: 'following' } : input);
  }
  return facts;
}

export const workspaceQueryAllowedFields = [
  'query', 'kind', 'kinds', 'tags', 'since', 'exposureFilter', 'related', 'cursor',
  'conceptId', 'hops', 'direction', 'edgeKinds',
] as const;

export function findUnsupportedWorkspaceQueryFields(args: Record<string, unknown>) {
  return Object.keys(args)
    .filter(key => !(workspaceQueryAllowedFields as readonly string[]).includes(key))
    .map(field => ({ field, reason: 'unsupported' as const, message: '此查询入口暂不支持该筛选。' }));
}

export function buildLearnerModelPayload(observations: unknown, recentAttempts: unknown, goal: string | null, tasks: unknown) {
  return {
    id: 'learner', title: '学习者模型', observations, recentAttempts, goal, tasks,
    prerequisites: { tool: 'search_workspace', args: { hops: 2, direction: 'inbound', edgeKinds: ['prereq_of'] }, required: ['conceptId'] },
    note: '观察关联具体作答。按 id 打开依据，未观察到的能力保留未知。',
  };
}

export function findUnopenedTextbookLink(
  references: readonly (string | { readonly fact: { readonly id: string; readonly rev: number; readonly type: string } })[],
  opened: ReadonlyMap<string, { readonly id: string; readonly rev: number; readonly type: string }>,
): string | null {
  const list = [...opened.values()];
  for (const ref of references) {
    const id = typeof ref === 'string' ? ref : ref.fact.id;
    if (!list.some(w => w.id === id && (typeof ref === 'string' || (w.rev === ref.fact.rev && w.type === ref.fact.type)))) return id;
  }
  return null;
}

export function violatesTextbookBlockAnchor(
  base: unknown,
  parsed: ReturnType<typeof parseSavePage>,
): boolean {
  if (parsed.kind !== 'patch' || !base || typeof base !== 'object' || !('anchor' in base)) return false;
  const anchor = (base as { anchor: { kind: string; blockId?: string } }).anchor;
  if (anchor.kind !== 'block') return false;
  return parsed.edits.some(edit => (edit.kind === 'insert_after' ? edit.afterId : edit.blockId) !== anchor.blockId);
}

export function findTextbookPreviewFailure(draft: boolean, items: readonly { readonly state: string; readonly reason?: string }[]): string | null {
  if ((draft && items.some(item => item.state === 'invalid')) || items.every(item => item.state === 'invalid')) {
    return items.find(item => item.state === 'invalid')?.reason ?? '教材修改无效。';
  }
  return null;
}

export function classifyTextbookWriteError(message: string): { readonly code: 'version_conflict' | 'basis_stale' | 'invalid_args'; readonly field: string; readonly message: string; readonly reopen: boolean } | null {
  if (message.startsWith('Fact revision conflict:') || message === 'Only an unedited companion draft can be revised')
    return { code: 'version_conflict', field: 'expected_rev', message: '教材版本已变更，请重新打开。', reopen: true };
  if (message === '教材依据已变更。') return { code: 'basis_stale', field: 'links', message: '教材来源已变更。', reopen: true };
  if (/^(教材|请先打开教材块|引用|插入位置|来源)/.test(message)) return { code: 'invalid_args', field: 'patch', message, reopen: false };
  return null;
}

export function buildDraftQuestionAsset(
  parsed: Extract<ReturnType<typeof parseSaveQuestion>, { kind: 'create' }>,
  basis: readonly { readonly id: FactId; readonly rev: number; readonly epoch: string; readonly type: string }[],
) {
  const { prompt, title, interaction: _i, sources: _s, shared_materials: _m, ...contract } = parsed.question;
  return questionAsset({
    kind: 'question', title, promptBlockId: 'prompt', ...contract, basis,
    blocks: [{ id: 'prompt', parentId: null, body: { kind: 'text', text: prompt } }],
  });
}

export function hasAttemptAnswerContent(answers: Record<string, string | number | undefined | null>): boolean {
  return Object.values(answers).some(answer => typeof answer === 'number' || Boolean(answer?.trim()));
}

export function sortStudyObjectBasis<T extends { readonly id: string; readonly rev: number }>(witnesses: Iterable<T>): T[] {
  return [...witnesses].sort((a, b) => a.id.localeCompare(b.id) || a.rev - b.rev);
}

export function buildSavedEdgeRef(id: string, rev: number) {
  return { v: 1 as const, fact: { id, rev, type: knowledgeEdgeType }, anchor: wholeAnchor };
}

export function validateWorkspaceGraphParams(
  isValidConceptId: boolean,
  hops: unknown,
  direction: unknown,
  hasIncompatibleFilters: boolean,
): string | null {
  if (!isValidConceptId || (hops !== 0 && hops !== 1 && hops !== 2) ||
      (direction !== 'both' && direction !== 'inbound' && direction !== 'outbound')) {
    return 'conceptId 须为概念 id，hops 可选 0、1、2，direction 可选 inbound、outbound、both。';
  }
  if (hasIncompatibleFilters) return '概念图查询使用 conceptId、hops、edgeKinds 及记录过滤。';
  return null;
}

export function pickOpenLearningBatchFailure<T extends { readonly ok?: boolean; readonly code?: string }>(items: readonly T[]) {
  const failures = items.filter(item => item.ok === false);
  if (!failures.length) return null;
  return failures.length < items.length ? 'partial_success' as const : failures[0]!.code!;
}
