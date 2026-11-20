import { factId, type CommandContext, type FactId, type FactSnapshot, type FactWrite, type Revision, type Tick } from '@mangekyo/kernel';

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

function refusalBoundary(input: unknown) {
  const fields = claimRecord(input);
  const goal = claimText(fields.goal, 200).trim();
  const intent_key = claimText(fields.intent_key, 160).trim();
  const condition = claimRecord(fields.reopen_condition);
  if (Object.keys(fields).some(key => !['goal', 'intent_key', 'reopen_condition'].includes(key)))
    throw new ClaimInputError('拒绝边界含未知字段。');
  if (condition.kind === 'learner_request' && Object.keys(condition).length === 1)
    return {goal, intent_key, reopen_condition: {kind: 'learner_request' as const}};
  if (condition.kind === 'at' && Object.keys(condition).length === 2) {
    const at = claimExpiry(condition.at);
    if (at) return {goal, intent_key, reopen_condition: {kind: 'at' as const, at}};
  }
  throw new ClaimInputError('请指定由本人重新提出，或明确开放时间。');
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

export function claimEvidence(input: unknown) {
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
  if (category !== 'preference' && category !== 'claim' && category !== 'state' && category !== 'refusal') throw new ClaimInputError('记忆类别无效。');
  if (origin !== 'turn' && origin !== 'learner') throw new ClaimInputError('记忆来源无效。');
  const supersedes = value.supersedes === null ? null : claimRef(value.supersedes);
  if (Boolean(supersedes) !== (action !== 'remember')) throw new ClaimInputError('更正或遗忘须引用前驱。');
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.length !== (origin === 'turn' ? 1 : 0))
    throw new ClaimInputError('每项须绑定本轮实际原话。');
  if (value.authority !== undefined && value.authority !== 'directive')
    throw new ClaimInputError('主权规则只接受 directive。');
  const directive = value.authority === 'directive';
  if ((category === 'refusal' && !directive) || (category !== 'refusal' && value.refusal !== undefined))
    throw new ClaimInputError('拒绝须作为主权规则保存。');
  const refusal = category === 'refusal' ? refusalBoundary(value.refusal) : undefined;
  const common = {...(directive && {authority: 'directive' as const}), ...(refusal && {refusal}), version: 1 as const, category, origin, scope: claimScope(value.scope),
    evidence_refs: value.evidence_refs.map(claimEvidence), supersedes, sticky: origin === 'learner' || action !== 'remember'};
  if (action === 'forget') return {...common, action, text: null, valid_until: null} as const;
  const valid_until = claimExpiry(value.valid_until);
  if (category === 'state' && !valid_until) throw new ClaimInputError('短期状态必须提供明确有效期。');
  const inputText = claimText(value.text, 600);
  const text = directive && inputText === common.evidence_refs[0]?.excerpt ? inputText : inputText.trim();
  if (directive && origin === 'turn' && text.trim() !== common.evidence_refs[0]?.excerpt.trim())
    throw new ClaimInputError('主权规则须保留学习者本轮逐字原话。');
  if (directive && category !== 'state' && valid_until !== null)
    throw new ClaimInputError('只有短期状态可设置有效期。限时拒绝请填写重新开放条件。');
  return {...common, action, text, valid_until} as const;
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
  if (claim.version === 0 || claim.sticky || claim.authority === 'directive')
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

function allowsTeaching(fact: FactSnapshot) {
  return fact.purpose.includes('teaching') || fact.purpose.includes('all');
}

export async function writeTurnClaims(ctx: CommandContext, entries: ReturnType<typeof claimInput>, directive = false): Promise<readonly FactWrite[]> {
  const writes: FactWrite[] = [];
  for (const {id, data} of entries) {
    const evidence = data.evidence_refs[0]!;
    const source = await ctx.read.fact(evidence.id, {mode: 'following'});
    if (!allowsTeaching(source) || !matchesClaimEvidence(source, evidence, evidence.excerpt, evidence.start))
      throw new ClaimInputError('本轮教学用途或原话已变化。');
    if (data.supersedes) {
      const target = await readClaimPredecessor(ctx, data.supersedes);
      if (!allowsTeaching(target)) throw new ClaimInputError('目标记忆不允许教学用途。');
      const previous = directive ? structuredClaim(target.value) : editableTurnClaim(target.value);
      if (previous.action === 'forget' || (directive && previous.authority !== 'directive') ||
          (directive && previous.category !== data.category))
        throw new ClaimInputError('更正须沿用同类生效中的主权规则。');
      if (previous.authority && data.authority !== previous.authority)
        throw new ClaimInputError('更正须保留学习者主权规则。');
      requirePreservedObjectScope(previous.scope, data.scope);
    }
    if (data.scope.kind === 'object') for (const ref of data.scope.basis) {
      const object = await ctx.read.fact(ref.id, {mode: 'following'});
      if (!allowsTeaching(object) || object.ref.rev !== ref.rev || object.accessEpoch !== ref.accessEpoch)
        throw new ClaimInputError('学习对象范围已变化。');
    }
    writes.push({kind: 'create', id, factType: claimType, data, purpose: ['storage', 'teaching']});
  }
  return writes;
}
