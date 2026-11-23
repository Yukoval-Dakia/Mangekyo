import { classifyKernelError, type FactId, type FactSnapshot, type Json, type ReadContext, type Revision } from '@mangekyo/kernel';
import { assetType, checkQuestionTeachingSources, checkTextbookBasis, freezeQuestionAssessment, parseTextbookBasis, questionAsset, type AssetReadContext } from './asset.ts';
import { contentStableId, normalizeKnowledgeName } from './knowledge-entity.ts';
import { fields, list, pageId, record, revision, text } from './parse.ts';
import { parseQuestionMetadata } from './question-authoring.ts';
import { pinQuestionHintSource } from './question-meta-source.ts';
import { independentQuestionExecutions, type QuestionExecution } from './question-effects.ts';
import { arithmeticPractice as parseArithmeticPractice } from './arithmetic-practice.ts';

export const questionStateType = 'content.questionState';
export const questionMetaType = 'overlay.question_meta';
export const questionVerificationType = 'content.questionVerification';
export const questionVerificationMethodVersion = '4';
export const questionMetaDraftType = 'content.questionMetaDraft';
export const questionKey = ({ id, rev }: { id: string; rev: number }) => `${id}:${rev}`;
export const questionVerificationKey = (input: { id: string; rev: number; recheck?: number }) =>
  `${questionKey(input)}:${input.recheck ?? 0}:${questionVerificationMethodVersion}`;
export function matchesQuestionVerificationSlot(
  slotKey: string, basis: QuestionVerificationBasis | undefined,
  inputs: readonly { readonly kind: string; readonly mode?: string; readonly id?: string; readonly rev?: number; readonly accessEpoch?: string }[],
): boolean {
  return Boolean(basis && questionVerificationKey(basis) === slotKey && inputs.some(i =>
    i.kind === 'fact' && i.mode === 'following' && i.id === basis.id && i.rev === basis.rev && i.accessEpoch === basis.accessEpoch));
}

export function parseSetQuestionTeachingInput(id: string, raw: Record<string, unknown> | undefined) {
  const input = raw ?? {};
  const { requestId, expectedRev, allowed, includeSourceMaterial } = input;
  if (typeof requestId !== 'string' || !requestId.trim() || typeof expectedRev !== 'number' || !Number.isSafeInteger(expectedRev) ||
      expectedRev < 1 || typeof allowed !== 'boolean' || (includeSourceMaterial !== undefined && typeof includeSourceMaterial !== 'boolean')) {
    throw new Error('题库教学授权请求无效。');
  }
  return { questionId: pageId(id), requestId, expectedRev, allowed, includeSourceMaterial };
}

export function classifySetQuestionTeachingError(
  error: unknown, flags?: { readonly notFound?: boolean; readonly deniedReason?: string | undefined },
): { readonly status: 404 | 409; readonly message: string } | null {
  const { kind, reason } = classifyKernelError(error);
  const deniedReason = flags?.deniedReason ?? (kind === 'denied' ? reason : undefined);
  if (flags?.notFound || kind === 'not_found' || (deniedReason !== undefined && deniedReason !== 'purpose'))
    return { status: 404, message: '找不到这道题。' };
  if (deniedReason === 'purpose')
    return { status: 409, message: '题目来源未授权教学用途，请先开放对应来源材料的教学权限。' };
  if (kind === 'revision_conflict' || (error instanceof Error && error.message === '题目基版已变化。'))
    return { status: 409, message: '题目基版已变化，请刷新后再试。' };
  if (kind === 'duplicate_command') return { status: 409, message: '同一个请求标识已经用于不同的教学授权。' };
  if (error instanceof Error && error.message === '题目来源未授权教学用途或依据已变化。')
    return { status: 409, message: '题目来源未授权教学用途，请先开放对应来源材料的教学权限。' };
  return null;
}
export function parseQuestionVerificationKey(key: string) {
  const [rawId, rawRev, rawRecheck] = key.split(':');
  try {
    const version = { id: pageId(rawId), rev: revision(Number(rawRev)), recheck: Number(rawRecheck) };
    if (Number.isSafeInteger(version.recheck) && version.recheck >= 0 && questionVerificationKey(version) === key)
      return version;
  } catch { /* Treat an invalid slot coordinate as unavailable. */ }
  return undefined;
}

export const questionStateId = (id: FactId) => contentStableId(questionStateType, id);

export function parseQuestionDisposition(input: unknown) {
  const value = record(input);
  fields(value, 'action', 'scope', 'reason');
  const action = value.action;
  if (action !== 'resume' && action !== 'stop' && action !== 'withdraw' && action !== 'recheck') {
    throw new Error('题目处置方式无效。');
  }
  const scope = text(value.scope, '影响用途');
  if (scope.length > 160 || (action === 'withdraw' && scope !== 'all')) throw new Error('题目处置范围无效。');
  const reason = text(value.reason, '处置原因');
  if (reason.length > 2000) throw new Error('题目处置原因过长。');
  return { action, scope, reason } as const;
}

export function parseQuestionState(input: unknown) {
  const value = record(input);
  fields(value, 'questionId', 'restrictions', 'last', 'recheck', 'arithmeticPractice');
  const recheck = value.recheck;
  if (typeof recheck !== 'number' || !Number.isSafeInteger(recheck) || recheck < 0) throw new Error('复验代次无效。');
  const restrictions = list(value.restrictions).map(parseQuestionDisposition);
  if (restrictions.length > 32 || new Set(restrictions.map(entry => entry.scope)).size !== restrictions.length ||
      restrictions.some(entry => entry.action !== 'stop' && entry.action !== 'withdraw')) {
    throw new Error('题目停发记录无效。');
  }
  const practice = value.arithmeticPractice === undefined ? undefined : parseArithmeticPractice(value.arithmeticPractice);
  return { questionId: pageId(value.questionId), restrictions, recheck,
    ...(practice === undefined ? {} : {arithmeticPractice: practice}),
    last: value.last === null ? null : parseQuestionDisposition(value.last),
  };
}

export async function readQuestionState(read: {fact(...args: Parameters<ReadContext['fact']>): Promise<FactSnapshot>}, id: FactId) {
  const snapshot = await read.fact(await questionStateId(id), { mode: 'following' });
  if (snapshot.type !== questionStateType) throw new Error('题目处置记录类型不匹配。');
  const state = parseQuestionState(snapshot.value);
  if (state.questionId !== id) throw new Error('题目处置记录不匹配。');
  return { snapshot, state };
}

export function parseQuestionMetaDraft(input: unknown) {
  const value = record(input);
  fields(value, 'id', 'expectedRev', 'append_metadata', 'basis', 'sticky');
  const id = pageId(value.id), expectedRev = revision(value.expectedRev);
  const append_metadata = value.append_metadata === null ? null : parseQuestionMetadata(value.append_metadata);
  if (typeof value.sticky !== 'boolean') throw new Error('题目活元信息无效。');
  return { id, expectedRev, append_metadata, basis: parseTextbookBasis(value.basis), sticky: value.sticky };
}

export type QuestionMetaDraft = ReturnType<typeof parseQuestionMetaDraft>;
export const questionTagKey = (tag: { kind: string; term: string; scope: string }) =>
  JSON.stringify([tag.kind, normalizeKnowledgeName(tag.term), tag.scope]);
export const questionSolutionKey = (solution: { method: string }) => normalizeKnowledgeName(solution.method);


export type QuestionVerificationBasis = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly accessEpoch: string;
  readonly recheck: number;
  readonly methodVersion: string;
};
export type VerificationReceipt = { readonly invocationId: string; readonly result: Json; readonly execution: QuestionExecution };
export type QuestionVerification = ReturnType<typeof evaluateQuestionVerification>;

export function questionVerificationReview(basis: QuestionVerificationBasis, reason: string) {
  return { status: 'needs-review' as const, basis, reason };
}

/** The public settler supplies results already matched to the sealed ledger plan. */
export function evaluateQuestionVerification(
  basis: QuestionVerificationBasis, checks: readonly VerificationReceipt[],
) {
  const review = (reason: string) => questionVerificationReview(basis, reason);
  if (checks.length !== 4 || checks.some(check => !check.invocationId) ||
      new Set(checks.map(check => check.invocationId)).size !== checks.length ||
      !independentQuestionExecutions(checks.map(check => check.execution))) {
    return review('需要三次独立求解和一次独立契约验收回执。');
  }
  const [first, second, third, validation] = checks;
  const solutions = [first, second, third].map(check => check?.result);
  const valid = (result: Json | undefined): result is { readonly [key: string]: Json } =>
    result !== undefined && result !== null && typeof result === 'object' && !Array.isArray(result);
  if (!solutions.every(valid) || !valid(validation?.result)) return review('独立验证结果无效。');
  const [primary] = solutions;
  if (!primary || typeof primary.answerKey !== 'string' || !primary.answerKey.trim() ||
      typeof primary.conditionKey !== 'string' || !primary.conditionKey.trim() ||
      solutions.some(solution => solution.answerKey !== primary.answerKey || solution.conditionKey !== primary.conditionKey ||
        typeof solution.reasoning !== 'string' || !solution.reasoning.trim())) {
    return review('独立求解对答案、单位或题目条件的结论不一致。');
  }
  if (validation.result.eligible !== true || validation.result.answerKey !== primary.answerKey ||
      validation.result.conditionKey !== primary.conditionKey) {
    return review('冻结评估契约未通过独立样例验证，或其结论与独立求解冲突。');
  }
  return { status: 'ready' as const, basis, invocations: checks.map(check => check.invocationId),
    executions: checks.map(check => check.execution), solutions: solutions.map(solution => String(solution.reasoning)),
  };
}

/** Server-only release read. Use a witness-tracking context and project for the actual recipient. */
export async function openQuestionForRelease(
  read: Pick<ReadContext, 'fact' | 'slot'>, id: FactId, releaseUse: string | readonly string[],
) {
  const releaseUses = typeof releaseUse === 'string' ? [releaseUse] : [...releaseUse];
  if (!releaseUses.length || releaseUses.some(use => typeof use !== 'string' || !use.trim())) {
    throw new Error('请提供至少一种有效的题目发放用途。');
  }
  const question = await read.fact(id, { mode: 'following' });
  if (question.type !== assetType) throw new Error('请选择题目资产。');
  const asset = questionAsset(question.value);
  if (!question.purpose.includes('teaching') && !question.purpose.includes('all')) {
    throw new Error('题目未授权教学用途。');
  }
  await checkQuestionTeachingSources(read, asset);
  const { state } = await readQuestionState(read, id);
  if (state.arithmeticPractice) throw new Error('整数练习须经封闭练习发放。');
  const stop = state.restrictions.find(entry => entry.scope === 'all' || releaseUses.includes(entry.scope));
  if (stop) throw new Error(stop.reason);
  const slot = await read.slot<QuestionVerification>({
    learner: question.ref.learner, type: questionVerificationType, key: questionVerificationKey({ ...question.ref, recheck: state.recheck }),
  }, { mode: 'following' });
  const result = slot.outcome;
  if (result.kind !== 'value' || result.value.status !== 'ready' ||
      result.value.basis.id !== id || result.value.basis.rev !== question.ref.rev ||
      result.value.basis.accessEpoch !== question.accessEpoch || result.value.basis.recheck !== state.recheck ||
      result.value.basis.methodVersion !== questionVerificationMethodVersion ||
      !independentQuestionExecutions(result.value.executions)) {
    throw new Error('这版题目需要当前有效的独立验收。');
  }
  return { ref: question.ref, asset, contract: freezeQuestionAssessment(asset, question.ref) };
}

export function questionMetaDraftId(question: FactSnapshot['ref']) {
  return contentStableId(questionMetaDraftType, question.id, String(question.rev));
}

/** The update command validates the resulting hint anchor before retaining or replacing the ladder. */
export async function readQuestionMetaForUpdate(read: AssetReadContext['read'], question: FactSnapshot['ref']) {
  const target = await read.fact(question.id, { mode: 'pinned', rev: question.rev });
  if (target.ref.learner !== question.learner || target.type !== assetType) throw new Error('请选择授权的题版。');
  await checkTextbookBasis(read, questionAsset(target.value).basis ?? []);
  const snapshot = await read.fact(await questionMetaDraftId(question), { mode: 'following' });
  if (snapshot.ref.learner !== question.learner || snapshot.type !== questionMetaDraftType) {
    throw new Error('活元信息记录类型或归属不匹配。');
  }
  const draft = parseQuestionMetaDraft(snapshot.value);
  if (draft.id !== question.id || draft.expectedRev !== question.rev) throw new Error('活元信息与题版不匹配。');
  await checkTextbookBasis(read, draft.basis);
  return { snapshot, draft };
}

export async function openQuestionMetaDraft(read: AssetReadContext['read'], question: FactSnapshot['ref']) {
  const { snapshot, draft } = await readQuestionMetaForUpdate(read, question);
  const ladder = draft.append_metadata?.hint_ladder;
  if (ladder) await pinQuestionHintSource({ learner: question.learner, read }, ladder.source_ref, draft.basis);
  return { snapshot, draft };
}

export function validateQuestionMetaReferences(draft: QuestionMetaDraft) {
  if (!draft.append_metadata) return;
  const { tags, solutions, hint_ladder: ladder } = draft.append_metadata;
  for (const { source_ref } of [...tags, ...solutions, ...(ladder ? [ladder] : [])]) {
    if (!source_ref) continue;
    if (draft.basis.some(use => use.id === source_ref)) continue;
    let source;
    try {
      const ref = record(JSON.parse(source_ref));
      if (ref.v === 1) source = record(ref.fact);
    } catch {
      // A plain ID or the established versioned reference wire format is required.
    }
    if (!source || !draft.basis.some(use => use.id === source.id && use.rev === source.rev && use.type === source.type)) {
      throw new Error('请先打开题目元信息引用的来源版本。');
    }
  }
}
