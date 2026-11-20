import type { FactSnapshot, ToolError } from '@mangekyo/kernel';
import { activityEvidence } from './activity-evidence.ts';
import { claimEvidence, claimId, claimInput, claimRecord, ClaimInputError, claimText, structuredClaim } from './claim.ts';
import { extractedUnderstanding, opensCitation, understandingCitation, type ActivityCitation, type ExtractedUnderstanding } from './understanding.ts';

export const saveBeliefCommand = 'companion.saveBelief';
export const undoHypothesisCommand = 'companion.undoHypothesis';

export function objectiveBeliefEvidence(fact: FactSnapshot) {
  if (fact.type !== 'activity.workbookAttempt' && fact.type !== 'activity.retentionPosttestSubmission') return;
  return activityEvidence(fact);
}

export function matchesBeliefEvidence(fact: FactSnapshot, citation: ActivityCitation) {
  const evidence = objectiveBeliefEvidence(fact);
  return evidence && opensCitation({...evidence, ref: {...fact.ref, accessEpoch: fact.accessEpoch}}, citation);
}

export function beliefInput(input: unknown) {
  const {turn, directives, hypotheses} = claimRecord(input);
  const turnId = claimId(turn);
  if (!Array.isArray(directives) || !Array.isArray(hypotheses) ||
      !directives.length && !hypotheses.length || directives.length + hypotheses.length > 12)
    throw new ClaimInputError('每轮可保存 1–12 项 Belief。');
  const claims = directives.length ? claimInput({entries: directives}) : [];
  for (const {data} of claims) {
    const evidence = data.evidence_refs[0]!;
    if (data.authority !== 'directive' || evidence.id !== turnId ||
        (data.action !== 'forget' && data.text !== evidence.excerpt))
      throw new ClaimInputError('主权规则须保存本轮逐字原话。');
  }
  const assertions = hypotheses.map(value => {
    const entry = claimRecord(value);
    const data = extractedUnderstanding(entry.data);
    const quote = entry.quote === null ? null : claimEvidence(entry.quote);
    if (data.belief?.turn !== turnId || data.sticky ||
        (data.belief.forgotten ? quote?.id !== turnId : quote !== null))
      throw new ClaimInputError('假设变更缺少当前回合依据。');
    return {id: claimId(entry.id), data: {...data, belief: data.belief}, quote};
  });
  const targets = [...claims.map(entry => entry.data.supersedes?.id),
    ...assertions.map(entry => entry.data.belief.supersedes?.id)].filter(Boolean);
  if (new Set(targets).size !== targets.length) throw new ClaimInputError('同轮只能变更该记忆一次。');
  return {claims, assertions};
}

export function beliefToolFailure(tool: string, message: string): ToolError {
  return {ok: false, code: 'invalid_args', message: [...message].slice(0, 60).join(''),
    next: {tool: 'find_tools', args: {query: tool}}};
}

export function beliefFields(args: Record<string, unknown>, fields: string[]) {
  if (Object.keys(args).some(key => !['category', 'action', ...fields].includes(key)))
    throw new ClaimInputError('使用工具声明中的字段。');
}

export function hypothesisRequest(args: Record<string, unknown>, currentObject: string | undefined,
  opened: (ref: ActivityCitation) => boolean) {
  const {action, scope, evidence_refs} = args;
  beliefFields(args, action === 'forget'
    ? ['supersedes', 'quote_excerpt'] : action === 'update'
      ? ['supersedes', 'evidence_refs', 'text'] : ['text', 'scope', 'evidence_refs']);
  if (action === 'remember' && scope !== 'general' && (scope !== 'current_object' || !currentObject))
    throw new ClaimInputError('假设须使用明确通用或本轮对象范围。');
  if (action === 'forget') return [];
  if (!Array.isArray(evidence_refs) || !evidence_refs.length || evidence_refs.length > 6)
    throw new ClaimInputError('假设须引用 1–6 条实际打开的作答片段。');
  const refs = evidence_refs.map(ref => understandingCitation(ref));
  if (refs.some(ref => !opened(ref))) throw new ClaimInputError('假设须引用本轮实际打开的原始作答片段。');
  if (action === 'remember' && !refs.some(ref => ref.direction === 'support'))
    throw new ClaimInputError('新假设须有支持证据。');
  return refs;
}

export function directiveDetails(args: Record<string, unknown>, explicit: boolean, excerpt: string,
  previous?: ReturnType<typeof structuredClaim>) {
  if (explicit && args.action === 'remember' && args.kind === undefined)
    throw new ClaimInputError('新主权规则须指定 kind。');
  const kind = (explicit ? args.kind : args.category) ?? previous?.category ?? 'preference';
  const boundary = ['goal', 'intent_key', 'reopen_condition'].some(key => Object.hasOwn(args, key));
  if (boundary && kind !== 'refusal') throw new ClaimInputError('拒绝边界仅用于 refusal。');
  if (explicit && args.text !== undefined && args.text !== excerpt) throw new ClaimInputError('主权规则须保留逐字原话。');
  const refusal = boundary ? {goal: args.goal, intent_key: args.intent_key, reopen_condition: args.reopen_condition} : previous?.refusal;
  return {category: kind, text: explicit ? excerpt : args.text,
    ...(explicit ? {authority: 'directive', ...(refusal ? {refusal} : {})} : {})};
}

export const hypothesisStatus = (data: ExtractedUnderstanding) =>
  data.evidence_refs.some(ref => ref.direction === 'contradict') ? 'disputed' as const : 'tentative' as const;

export function quoteFromTurn(answer: string, excerptValue: unknown) {
  const excerpt = claimText(excerptValue, 600);
  const start = answer.indexOf(excerpt);
  if (start < 0) throw new ClaimInputError('请逐字引用本轮学习者的实际消息。');
  return {excerpt, start};
}

export function openedAnswerCitations(source: NonNullable<ReturnType<typeof objectiveBeliefEvidence>>,
  ref: ActivityCitationRef, content: string, itemId?: string) {
  return source.fragments.flatMap(fragment => {
    const excerpt = fragment.text.slice(0, 360).toWellFormed();
    return (!itemId || fragment.anchor === itemId) && content.includes(excerpt)
      ? [{...ref, anchor: fragment.anchor, excerpt}] : [];
  });
}

type ActivityCitationRef = Pick<ActivityCitation, 'id' | 'rev' | 'accessEpoch'>;
