import { factId, type CommandContext, type FactId, type FactSnapshot, type Revision, type Tick } from '@mangekyo/kernel';

export const claimType = 'companion.claim';
export const applyClaimCommand = 'companion.saveTurnMemory';
export const manageClaimCommand = 'companion.manageMemory';
export const undoClaimCommand = 'companion.undoMemory';
export class ClaimInputError extends Error {}

export function claimRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClaimInputError('需要一个记录对象。');
  return value as Record<string, unknown>;
}

export function claimId(value: unknown): FactId {
  if (typeof value !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) throw new ClaimInputError('记忆引用无效。');
  return factId(value);
}

export function claimRef(value: unknown) {
  const {id, rev, accessEpoch} = claimRecord(value);
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1 || rev > 2_147_483_647 ||
      typeof accessEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(accessEpoch)) throw new ClaimInputError('缺少版本与用途见证。');
  return {id: claimId(id), rev: rev as Revision, accessEpoch: accessEpoch as Tick};
}
export type ClaimRef = ReturnType<typeof claimRef>;

export function claimText(value: unknown, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || !value.isWellFormed() || value.includes('\0'))
    throw new ClaimInputError('文字为空或超出长度限制。');
  return value;
}

export function claimExpiry(value: unknown) {
  if (value == null) return null;
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new ClaimInputError('有效期须为完整 UTC 时间。');
  return value;
}

function claimScope(input: unknown) {
  const {kind, object, basis} = claimRecord(input);
  if (kind === 'general' || kind === 'unknown') return {kind} as const;
  if (kind !== 'object' || !Array.isArray(basis) || !basis.length || basis.length > 48)
    throw new ClaimInputError('学习对象范围缺少依据。');
  const objectId = claimId(object);
  const witnesses = basis.map(claimRef);
  if (!witnesses.some(ref => ref.id === objectId)) throw new ClaimInputError('缺少当前学习对象版本。');
  return {kind, object: objectId, basis: witnesses} as const;
}
export type ClaimScope = ReturnType<typeof claimScope>;

function claimEvidence(input: unknown) {
  const value = claimRecord(input);
  const {start} = value;
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 || start > 4000)
    throw new ClaimInputError('原话位置无效。');
  return {...claimRef(value), start, excerpt: claimText(value.excerpt, 600)};
}

export function structuredClaim(input: unknown) {
  const value = claimRecord(input);
  if (value.version !== undefined && value.version !== 1) throw new ClaimInputError('记忆版本无效。');
  const {action, category, origin} = value;
  if (action !== 'remember' && action !== 'correct' && action !== 'forget') throw new ClaimInputError('记忆操作无效。');
  if (category !== 'preference' && category !== 'claim' && category !== 'state') throw new ClaimInputError('记忆类别无效。');
  if (origin !== 'turn' && origin !== 'learner') throw new ClaimInputError('记忆来源无效。');
  const supersedes = value.supersedes === null ? null : claimRef(value.supersedes);
  if (Boolean(supersedes) !== (action !== 'remember')) throw new ClaimInputError('更正或遗忘须引用前驱。');
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.length !== (origin === 'turn' ? 1 : 0))
    throw new ClaimInputError('每项须绑定本轮实际原话。');
  const common = {version: 1 as const, category, origin, scope: claimScope(value.scope),
    evidence_refs: value.evidence_refs.map(claimEvidence), supersedes, sticky: origin === 'learner' || action !== 'remember'};
  if (action === 'forget') return {...common, action, text: null, valid_until: null} as const;
  const valid_until = claimExpiry(value.valid_until);
  if (category === 'state' && !valid_until) throw new ClaimInputError('短期状态必须提供明确有效期。');
  return {...common, action, text: claimText(value.text, 600).trim(), valid_until} as const;
}

function legacyRef(input: unknown) {
  try { return claimRef(input); } catch (error) {
    if (error instanceof ClaimInputError) return null;
    throw error;
  }
}

export function claimValue(input: unknown) {
  const value = claimRecord(input);
  if (value.version !== undefined && value.version !== 0) return structuredClaim(value);
  return {version: 0 as const, quote: claimText(value.quote, 4000), source: legacyRef(value.source),
    supersedes: legacyRef(value.supersedes)};
}

export function editableTurnClaim(input: unknown) {
  const claim = claimValue(input);
  if (claim.version === 0 || claim.sticky)
    throw new ClaimInputError('这条记忆由学习者保留，请在「我 → 记忆」更正或忘掉。');
  return claim;
}

export function requirePreservedObjectScope(previous: ClaimScope, next: ClaimScope) {
  if (previous.kind !== 'object') return;
  if (next.kind !== 'object' || next.object !== previous.object || next.basis.length !== previous.basis.length ||
      previous.basis.some(({id, rev, accessEpoch}, index) => {
        const ref = next.basis[index];
        return ref?.id !== id || ref.rev !== rev || ref.accessEpoch !== accessEpoch;
      })) throw new ClaimInputError('对象记忆须保留原学习对象范围和版本依据。');
}

export function claimInput(input: unknown) {
  const {entries} = claimRecord(input);
  if (!Array.isArray(entries) || !entries.length || entries.length > 12) throw new ClaimInputError('每轮可保存 1–12 项记忆。');
  const parsed = entries.map(entry => {
    const {id, data} = claimRecord(entry);
    const value = structuredClaim(data);
    if (value.origin !== 'turn') throw new ClaimInputError('仅接受对话证据。');
    return {id: claimId(id), data: value};
  });
  if (new Set(parsed.map(entry => entry.data.evidence_refs[0]!.id)).size !== 1)
    throw new ClaimInputError('一次记忆命令只能引用一个回合。');
  const predecessors = parsed.flatMap(entry => entry.data.supersedes ? [entry.data.supersedes.id] : []);
  if (new Set(predecessors).size !== predecessors.length) throw new ClaimInputError('同轮只能变更该记忆一次。');
  return parsed;
}

export async function readClaimPredecessor(ctx: CommandContext, expected: ClaimRef) {
  const target = await ctx.read.fact(expected.id, {mode: 'following'});
  if (target.type !== claimType || target.ref.rev !== expected.rev || target.accessEpoch !== expected.accessEpoch)
    throw new ClaimInputError('目标记忆的版本或用途已变更。');
  return target;
}

export function matchesClaimEvidence(fact: FactSnapshot, ref: ClaimRef, excerpt: string, start: number, legacy = false) {
  if (fact.type !== 'activity.studyTurn' || fact.ref.id !== ref.id ||
      fact.ref.rev !== ref.rev || fact.accessEpoch !== ref.accessEpoch) return false;
  if (!fact.value || typeof fact.value !== 'object' || Array.isArray(fact.value)) return false;
  const {answer, caseId, memoryVersion, workspaceRevision} = claimRecord(fact.value);
  if (caseId !== 'companion' || typeof answer !== 'string') return false;
  return legacy ? answer === excerpt : memoryVersion === 1 && typeof workspaceRevision === 'string' &&
    answer.slice(start, start + excerpt.length) === excerpt;
}
