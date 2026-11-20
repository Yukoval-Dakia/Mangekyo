import type { FactId, FactSnapshot, ToolError } from '@mangekyo/kernel';
import { activityEvidence } from './activity-evidence.ts';
import { claimEvidence, claimExpiry, claimId, claimInput, claimRecord, ClaimInputError, claimText, claimValue, requirePreservedObjectScope, structuredClaim, type ClaimRef } from './claim.ts';
import { citationExcerpt, extractedUnderstanding, reviewUnderstanding, understandingPresentation, opensCitation, understandingCitation, understandingProjection, type ActivityCitation, type ExtractedUnderstanding } from './understanding.ts';

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

function directiveDetails(args: Record<string, unknown>, explicit: boolean, excerpt: string,
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

type TurnObject = {id: string; basis: readonly {id: string; rev: number; epoch: string}[]};
type TurnClaim = ReturnType<typeof structuredClaim>;

export function validateDirectiveScope(scope: unknown, hasObject: boolean) {
  if (scope !== undefined && scope !== 'general' && scope !== 'current_object' && scope !== 'unknown')
    throw new ClaimInputError('范围可为明确通用、当前对象或未知。');
  if (scope === 'current_object' && !hasObject)
    throw new ClaimInputError('本轮未绑定学习对象，不能使用当前对象范围。');
}

export function turnClaimData(args: Record<string, unknown>, input: {explicit: boolean; now: string;
  object?: TurnObject; quote: {id: string; rev: number; accessEpoch: string; excerpt: string; start: number};
  previous?: TurnClaim; supersedes: ClaimRef | null;
}) {
  const {object, now, explicit, quote, previous, supersedes} = input;
  const {action, scope, valid_until: expiry} = args;
  const usePrevious = previous && (scope === undefined ||
    (scope === 'current_object' && previous.scope.kind === 'object' && previous.scope.object === object?.id));
  const scopeInput = usePrevious ? previous.scope
    : scope === 'general' || scope === 'unknown' ? {kind: scope}
    : object ? {kind: 'object', object: object.id,
      basis: object.basis.map(({id, rev, epoch}) => ({id, rev, accessEpoch: epoch}))} : {kind: 'unknown'};
  const valid_until = action === 'forget' ? null : expiry === undefined && previous ? previous.valid_until : claimExpiry(expiry);
  if (valid_until && valid_until <= now) throw new ClaimInputError('有效期须晚于当前时刻。');
  const data = structuredClaim({
    action: action === 'update' ? 'correct' : action, ...directiveDetails(args, explicit, quote.excerpt, previous),
    origin: 'turn', scope: scopeInput, valid_until, evidence_refs: [quote], supersedes,
  });
  if (previous) requirePreservedObjectScope(previous.scope, data.scope);
  return data;
}

export function turnHypothesisData(args: Record<string, unknown>, input: {
  turn: string; object?: string; refs: readonly ActivityCitation[]; undoToken: string;
  previous?: ExtractedUnderstanding; supersedes: ClaimRef | null;
}) {
  const {turn, object, refs, undoToken, previous, supersedes} = input;
  const data = extractedUnderstanding({version: 2, kind: 'observation', ttl: null, sticky: false,
    text: previous?.text ?? args.text,
    scope: previous?.scope ?? (args.scope === 'general' ? {kind: 'general'} : {kind: 'object', object}),
    evidence_refs: [...(previous?.evidence_refs ?? []), ...refs],
    undo_token: undoToken, belief: {turn, forgotten: args.action === 'forget', supersedes},
  });
  return {...data, belief: data.belief!};
}

export function checkedHypothesis(value: unknown, text: unknown) {
  const data = extractedUnderstanding(value);
  if (!data.belief || data.belief.forgotten || data.sticky || (text !== undefined && text !== data.text))
    throw new ClaimInputError('核验只能追加证据，原假设文字保持不变。');
  return data;
}

export function checkedDirective(value: unknown, kind: unknown) {
  const data = structuredClaim(value);
  if (data.authority !== 'directive' || data.action === 'forget' || (kind !== undefined && kind !== data.category))
    throw new ClaimInputError('请选择同类、仍生效的主权规则。');
  return data;
}

export function claimRecallValue(fact: FactSnapshot, claim: ReturnType<typeof claimValue>, tick: string,
  excerpt: string, explicit: boolean) {
  const legacy = claim.version === 0;
  const understanding = understandingProjection(fact)!;
  return {id: fact.ref.id, rev: fact.ref.rev, text: legacy ? null : claim.text,
    ...(!legacy && claim.authority && {authority: claim.authority, ...(explicit && {category: claim.authority}), ...(claim.refusal && {refusal: claim.refusal})}),
    quote_excerpt: excerpt, kind: legacy ? 'legacy' : claim.category,
    scope: legacy ? {kind: 'unknown'} : claim.scope.kind === 'object'
      ? {kind: 'object', id: claim.scope.object} : claim.scope,
    valid_until: legacy ? null : claim.valid_until, recordedTick: tick, ttl: understanding.ttl, sticky: understanding.sticky,
    evidence_refs: understanding.evidence_refs};
}

export function managedUnderstanding(id: FactId, data: ExtractedUnderstanding, sources: Parameters<typeof reviewUnderstanding>[2]) {
  const evidenceState = sources.length === data.evidence_refs.length ? 'current' : 'unavailable';
  return {evidenceState,
    ...(data.evidence_refs.some(ref => ref.span) ? {status: data.sticky ? 'learner-corrected' : 'tentative'} : {}),
    understanding: evidenceState === 'current'
      && !data.belief?.forgotten
      ? {...data, kind: understandingPresentation(data, sources), ...(data.belief ? {category: 'hypothesis',
          status: hypothesisStatus(data)} : {}),
        review: reviewUnderstanding(id, data, sources),
        evidence_refs: data.evidence_refs.map((ref, index) => ({...ref, excerpt: citationExcerpt(sources[index]!, ref)}))}
      : {...data, text: null, scope: null, evidence_refs: []}};
}

export function memoryReceipt(id: string, rev: number, action: TurnClaim['action'], undo_token: string) {
  const title = action === 'forget' ? '已忘掉记忆' : action === 'correct' ? '已更新记忆' : '已记住';
  return {id, rev, title, memory: {status: 'saved' as const, action, undo_token}};
}

export const beliefReceiptAction = ({belief}: ReturnType<typeof turnHypothesisData>): TurnClaim['action'] =>
  belief.forgotten ? 'forget' : belief.supersedes ? 'correct' : 'remember';

export function recallClaimEvidence(claim: ReturnType<typeof claimValue>) {
  const legacy = claim.version === 0;
  return legacy ? {legacy, evidence: claim.source, excerpt: claim.quote, start: 0} :
    {legacy, evidence: claim.evidence_refs[0], excerpt: claim.evidence_refs[0]?.excerpt, start: claim.evidence_refs[0]?.start ?? 0};
}
