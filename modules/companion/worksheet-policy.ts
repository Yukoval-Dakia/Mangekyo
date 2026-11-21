import type { FactId, FactSnapshot, ReadContext } from '@mangekyo/kernel';
import attemptFact from '@mangekyo/module-activity/facts/workbook-attempt';
import { isWorksheetProfile, type WorkerConsent } from './worker-consent.ts';
import { readResearchSource, researchOrderType, researchWorksheetType, researchWorksheet,
  readResearchBasis, researchOrder, researchSettings, researchPurpose, ResearchBasisChanged,
  retentionReviewPermissionType, type retentionReviewPermission } from './research.ts';

const {type: workbookAttemptType, schema: {parse: workbookAttempt}} = attemptFact;
type ReviewRef = {id:FactId; revision:number; accessEpoch:string; anchor?:string | undefined};
type ReviewSpec = {sourceFactRev: ReviewRef; refs:ReviewRef[]; workerProfile:string; budgetCap:number;
  goal:string; autonomyTier:number; expiresAtMs:number; settingsRevision:number; dedupKey:string};
export type ReviewAccess = {
  read: ReadContext;
  open(id: FactId): Promise<FactSnapshot | null>;
  independent(source: FactSnapshot): Promise<boolean>;
  retention(source: FactSnapshot): Promise<ReturnType<typeof retentionReviewPermission> | null>;
  material(paper: ReturnType<typeof workbookAttempt>['paper']): Promise<boolean>;
};

import { reviewGoal } from './research-triage-policy.ts';
export { reviewGoal } from './research-triage-policy.ts';
export function reviewDedupKey({ id, revision, accessEpoch }: ReviewRef) {
  return 'review-attempt:' + id + ':' + revision + ':' + accessEpoch;
}

export function reviewEvidence(data: unknown, questionId: string) {
  const attempt = workbookAttempt(data);
  const index = attempt.paper.questions.findIndex(question => question.id === questionId);
  const question = attempt.paper.questions[index];
  const feedback = attempt.feedback.find(item => item.questionId === questionId);
  if (!question || question.sourceQuestionRef || feedback?.result !== 'incorrect' || !feedback.expected) throw new ResearchBasisChanged('原卷判题已变更。');
  return { paperId: attempt.paperId, paperTitle: attempt.paper.title, submittedAt: attempt.submittedAt,
    questionNumber: index + 1, questionId, prompt: question.prompt, feedback: { ...feedback, expected: feedback.expected } };
}
export type ReviewEvidence = ReturnType<typeof reviewEvidence>;

export const retentionReviewAnchor = 'retention-posttest';

export function retentionReviewEvidence(permission: ReturnType<typeof retentionReviewPermission>) {
  return { kind: 'retention_posttest_miss' as const, reconciliationKey: permission.key, resultId: permission.resultId,
    forecast: 'correct' as const, observation: 'incorrect' as const, exposure: 'independent' as const,
    href: `/api/retention/${permission.key}` };
}

export async function comparisonWitness(access: ReviewAccess, grant: WorkerConsent) {
  if (!grant.comparisonAttemptId || !grant.comparisonRevision || grant.comparisonAccessEpoch === undefined) return null;
  const other = await access.open(grant.comparisonAttemptId);
  if (!other || other.ref.rev !== grant.comparisonRevision || other.accessEpoch !== grant.comparisonAccessEpoch ||
      !other.purpose.includes(researchPurpose) || !await access.independent(other)) return null;
  const anchor = workbookAttempt(other.value).feedback.find(item => item.result === 'incorrect')?.questionId;
  return anchor ? { id:other.ref.id, revision:other.ref.rev, accessEpoch:other.accessEpoch, anchor } : null;
}

export async function planReview<T extends ReviewSpec>(access: ReviewAccess, spec: T, grant: WorkerConsent | null, budgetCap: number) {
  if (!grant || !isWorksheetProfile(grant.profile) || !budgetCap) return spec;
  const source = await access.open(spec.sourceFactRev.id);
  if (!source) return spec;
  if (source.type === retentionReviewPermissionType) {
    if (grant.profile !== 'heavy_tutor_prep' || spec.sourceFactRev.anchor !== retentionReviewAnchor ||
        !await access.retention(source)) return spec;
    return { ...spec, refs: [], workerProfile: grant.profile, budgetCap };
  }
  if (!await access.independent(source)) return spec;
  const refs: ReviewRef[] = [];
  if (grant.profile === 'deep_analyst') {
    if (source.ref.id === grant.comparisonAttemptId) return spec;
    const witness = await comparisonWitness(access, grant);
    if (!witness) return null;
    refs.push(witness);
  }
  return {...spec, refs, workerProfile:grant.profile, budgetCap};
}

export async function readComparison(access: ReviewAccess, ref: ReviewRef) {
  const source = await access.open(ref.id);
  if (!source || !ref.anchor || !source.purpose.includes('background-research') || source.ref.rev !== ref.revision ||
      source.accessEpoch !== ref.accessEpoch || !await access.independent(source)) return null;
  return { sourceId:source.ref.id, evidence:reviewEvidence(source.value, ref.anchor) };
}
export async function readEligibleReview(access: ReviewAccess, spec: ReviewSpec, settingsId: FactId, quote?: (grant: WorkerConsent) => number) {
  const { id, revision, accessEpoch, anchor } = spec.sourceFactRev;
  const model = isWorksheetProfile(spec.workerProfile);
  if ((!model && (spec.workerProfile !== 'deterministic_compute' || spec.budgetCap !== 0)) || spec.goal !== reviewGoal ||
      spec.autonomyTier !== 1 || spec.expiresAtMs <= Date.now() || !anchor) return null;

  if (spec.dedupKey !== reviewDedupKey(spec.sourceFactRev)) return null;
  const basis = researchOrder({ settingsId, settingsRevision: spec.settingsRevision,
    source: { attemptId: id, revision, accessEpoch, questionId: anchor } });
  const read = access.read;
  for (const ref of spec.refs) {
    const fact = await read.fact(ref.id, { mode: 'following' });
    if (fact.ref.rev !== ref.revision || fact.accessEpoch !== ref.accessEpoch) return null;
  }
  const source = await readResearchBasis(read, basis);
  const isRetention = source.type === retentionReviewPermissionType;
  const retention = isRetention && anchor === retentionReviewAnchor ? await access.retention(source) : null;
  if (isRetention && !retention) return null;
  let grant: WorkerConsent | null = null;
  const sourceIds = [source.ref.id];
  let comparison: ReviewEvidence | null = null;
  if (model) {
    grant = researchSettings((await read.fact(settingsId, {mode:'following'})).value).workerGrant;
    if (!grant || grant.profile !== spec.workerProfile || !spec.budgetCap ||
        (quote && quote(grant) !== spec.budgetCap) ||
        (retention ? grant.profile !== 'heavy_tutor_prep' : !await access.independent(source))) return null;
    if (grant.profile === 'deep_analyst') {
      const [ref] = spec.refs;
      if (spec.refs.length !== 1 || !ref || ref.id === id || ref.id !== grant.comparisonAttemptId ||
          ref.revision !== grant.comparisonRevision || ref.accessEpoch !== grant.comparisonAccessEpoch) return null;
      const reopened = await readComparison(access, ref);
      if (!reopened) return null;
      sourceIds.push(reopened.sourceId);
      comparison = reopened.evidence;
    } else if (spec.refs.length) return null;
  }
  if (retention) return { basis, evidence: null, retention: retentionReviewEvidence(retention), grant, comparison, sourceIds };
  if (source.type !== workbookAttemptType ||
      workbookAttempt(source.value).feedback.find(item => item.result === 'incorrect')?.questionId !== anchor) return null;
  if (!await access.material(workbookAttempt(source.value).paper)) return null;
  return { basis, grant, comparison, sourceIds, retention: null, evidence: reviewEvidence(source.value, anchor) };
}


export async function projectWorksheet(access: ReviewAccess, id: FactId, identify: (id: FactId, rev: number, epoch: string) => Promise<FactId>, openStored: (id: FactId) => Promise<unknown>) {
  const read = access.read;
  const fact = await read.fact(id, { mode: 'following' });
  if (fact.type !== researchWorksheetType || !fact.purpose.includes(researchPurpose)) return null;
  const result = researchWorksheet(fact.value);
  for (const reference of result.references ?? []) if (!await readComparison(access, reference)) return null;
  const order = 'todoId' in result ? null : await read.fact(result.orderId, { mode: 'following' });
  if (order && (order.type !== researchOrderType || !order.purpose.includes(researchPurpose))) return null;
  const ref = 'todoId' in result ? result.source : researchOrder(order?.value).source;
  const source = await readResearchSource(read, ref);
  if (id !== await identify(ref.attemptId, ref.revision, ref.accessEpoch)) return null;
  const retention = source.type === retentionReviewPermissionType && ref.questionId === retentionReviewAnchor
    ? await access.retention(source) : null;
  if (source.type !== workbookAttemptType && !retention) return null;
  if (!retention && !await access.material(workbookAttempt(source.value).paper)) return null;
  const evidence = retention ? null : reviewEvidence(source.value, ref.questionId);
  if (evidence) await openStored(ref.attemptId);
  const href = retention ? `/api/retention/${retention.key}`
    : `/api/papers/${evidence!.paperId}/attempts/${ref.attemptId}/research/${id}/source`;
  return {
    fact,
    worksheet: {
      id, ...result.draft, method: result.method, deliveredAt: result.deliveredAt, tier: 1, cost: result.actualUsdMicros === undefined ? 0 : result.actualUsdMicros,
      ...(result.references && {references:result.references, unit:'USD_MICROS'}),
      ...('todoId' in result ? { todoId: result.todoId, digest: result.digest } : { orderId: result.orderId }),
      source: { ...ref, href },
    },
    source: evidence && { ...ref, ...evidence },
  };
}

type OpenWorksheet = NonNullable<Awaited<ReturnType<typeof projectWorksheet>>>;

export function completedWorksheetEvent(fact: FactSnapshot, worksheet: OpenWorksheet['worksheet'], digest: string,
  todo: {id: string; chainId: string; hopCount: number}) {
  return { event_id: fact.ref.id, kind: 'work_completed', fact_ref: fact.ref.id, fact_rev: fact.ref.rev,
    payload: { todo_id: todo.id, chain_id: todo.chainId, hop_count: todo.hopCount, digest,
      source_fact_id: worksheet.source.attemptId, source_fact_rev: worksheet.source.revision,
      source_access_epoch: worksheet.source.accessEpoch } };
}

export function worksheetInventoryItem(opened: OpenWorksheet, title: string) {
  const { fact, worksheet: { source } } = opened;
  return { inventory_id: fact.ref.id, kind: 'research_worksheet', status: 'ready', usage: 'unknown',
    revision: fact.ref.rev, access_epoch: fact.accessEpoch, title,
    source_fact_id: source.attemptId, source_fact_rev: String(source.revision), source_access_epoch: source.accessEpoch,
    href: opened.source ? `/api/papers/${opened.source.paperId}/attempts/${source.attemptId}/research` : source.href };
}

export function summarizeReviewAttempt(fact: FactSnapshot, attempt: ReturnType<typeof workbookAttempt> | undefined,
  anchor: string | undefined, title: string | undefined) {
  return { id: fact.ref.id, rev: fact.ref.rev, fact_type: fact.type, access_epoch: fact.accessEpoch, retracted_rev: 0,
    purpose: researchPurpose, data: attempt && title !== undefined
      ? { submitted_at: attempt.submittedAt, title,
        first_incorrect_question: anchor ? attempt.paper.questions.findIndex(item => item.id === anchor) + 1 : null }
      : { status: 'missed', observation: 'independent' } };
}
