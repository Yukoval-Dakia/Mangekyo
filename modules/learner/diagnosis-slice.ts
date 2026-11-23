import type { FactId, Manifest, Revision } from '@mangekyo/kernel';
import type { ConceptForecastSignal } from './knowledge-mastery.ts';
import type { PreSubmitPitfall, PreSubmitPitfallInput } from './pre-submit-pitfalls.ts';

export const ulidCursorPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function indexLinksByQuestionRev<T extends { readonly questionId: string; readonly questionRev: Revision }>(
  links: readonly T[],
): Map<string, Map<Revision, T[]>> {
  const byQuestion = new Map<string, Map<Revision, T[]>>();
  for (const link of links) {
    const revisions = byQuestion.get(link.questionId) ?? new Map<Revision, T[]>();
    byQuestion.set(link.questionId, revisions);
    revisions.set(link.questionRev, [...revisions.get(link.questionRev) ?? [], link]);
  }
  return byQuestion;
}

export function projectDiagnosisConceptHistory<T extends {
  readonly conceptId: FactId;
  readonly submission: { readonly id: FactId; readonly rev: Revision };
  readonly occurredAt: string;
  readonly recordedTick: string;
  readonly outcome: 'correct' | 'incorrect' | 'partial' | 'unknown';
  readonly exposure: 'independent' | 'exposed' | 'unknown';
}>(conceptIds: readonly FactId[], titles: ReadonlyMap<FactId, string>, attempts: readonly T[]) {
  if (!attempts.length) return { state: 'unknown' as const, reason: 'no-attempt-history' as const, conceptIds: [...conceptIds] };
  const byConcept = new Map<string, T[]>();
  for (const row of attempts) byConcept.set(row.conceptId, [...byConcept.get(row.conceptId) ?? [], row]);
  const recent = (rows: readonly T[]) => [...rows].sort((a, b) => {
    const timeDiff = Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
    if (timeDiff) return timeDiff;
    const tickDiff = BigInt(b.recordedTick) - BigInt(a.recordedTick);
    return tickDiff > 0n ? 1 : tickDiff < 0n ? -1 : 0;
  }).slice(0, 3);
  return {
    state: 'observed' as const,
    concepts: conceptIds.filter(id => byConcept.has(id)).map(id => ({
      conceptId: id, title: titles.get(id),
      recentAttempts: recent(byConcept.get(id)!).map(row => ({
        submissionId: row.submission.id, rev: row.submission.rev, occurredAt: row.occurredAt, outcome: row.outcome, exposure: row.exposure,
      })),
    })),
  };
}

export function filterValidDiagnosisSignals(
  signals: readonly ConceptForecastSignal[],
  titles: ReadonlyMap<FactId, string>,
): ConceptForecastSignal[] {
  return signals.filter(signal => Number.isFinite(signal.probability) && signal.probability >= 0 && signal.probability <= 1 &&
    (signal.crossingAt === undefined || Number.isFinite(Date.parse(signal.crossingAt))) && titles.has(signal.conceptId));
}

export function projectDiagnosisRetention(
  conceptIds: readonly FactId[],
  titles: ReadonlyMap<FactId, string>,
  signals: readonly ConceptForecastSignal[],
) {
  const latest = new Map<FactId, ConceptForecastSignal>();
  for (const signal of signals) {
    const existing = latest.get(signal.conceptId);
    if (!existing || BigInt(signal.effectiveTick) > BigInt(existing.effectiveTick)) latest.set(signal.conceptId, signal);
  }
  const concepts = [...latest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, signal]) => ({
    conceptId: id, title: titles.get(id), probability: signal.probability,
    ...(signal.crossingAt ? { crossingAt: signal.crossingAt } : {}), observedThrough: signal.observedThrough,
  }));
  return concepts.length
    ? { state: 'observed' as const, concepts }
    : { state: 'unknown' as const, reason: 'no-retention-forecast' as const, conceptIds: [...conceptIds] };
}

export function projectDiagnosisMastery<TStatus extends string>(
  conceptIds: readonly FactId[],
  concepts: readonly { readonly conceptId: FactId; readonly title: string | undefined; readonly status: TStatus; readonly retrievability: number | null; readonly independentCount: number }[],
) {
  return concepts.some(({ status }) => status !== 'unknown')
    ? { state: 'observed' as const, concepts: [...concepts] }
    : { state: 'unknown' as const, reason: 'no-independent-evidence' as const, conceptIds: [...conceptIds] };
}

type PitfallRule = PreSubmitPitfallInput['rules'][number];
export function assemblePreSubmitRule(
  candidate: Omit<Extract<PitfallRule, { readonly kind: 'sticky' }>, 'ref' | 'basis'> | Omit<Exclude<PitfallRule, { readonly kind: 'sticky' }>, 'ref' | 'basis'>,
  ref: PitfallRule['ref'],
  basis: PitfallRule['basis'],
): PitfallRule {
  return candidate.kind === 'sticky'
    ? { kind: 'sticky', ref, errorStage: candidate.errorStage, conceptIds: candidate.conceptIds, basis }
    : { kind: candidate.kind, stage: candidate.stage, ref, errorStage: candidate.errorStage, conceptIds: candidate.conceptIds, basis };
}

export function selectAuthorizedPreSubmitItems(pitfalls: readonly PreSubmitPitfall[], candidateItemIds: readonly string[]): string[] {
  const anchors = new Set(pitfalls.flatMap(pitfall => pitfall.anchors.map(anchor => anchor.itemId)));
  return candidateItemIds.filter(itemId => anchors.has(itemId));
}

export function manifestEpochsMatch(
  manifest: Manifest,
  releaseId: string,
  submissionId: string,
  expected?: { readonly releaseEpoch?: string; readonly submissionEpoch?: string },
): boolean {
  const check = (id: string, epoch: string | undefined) =>
    epoch === undefined || manifest.inputs.some(input => input.kind === 'fact' && input.id === id && input.accessEpoch === epoch);
  return check(releaseId, expected?.releaseEpoch) && check(submissionId, expected?.submissionEpoch);
}

export function projectFormalAssessmentFallback<TRefs extends Record<string, unknown>>(
  slot: { readonly last_error: { readonly status: string; readonly reason: string } | null } | undefined,
  refs: TRefs,
  executionFailedReason: string,
) {
  if (slot?.last_error) {
    return {
      ...refs,
      state: slot.last_error.reason === executionFailedReason ? 'failed' as const : 'blocked' as const,
      reason: slot.last_error.reason, score: null,
    };
  }
  return slot
    ? { ...refs, state: 'queued' as const, score: null }
    : { ...refs, state: 'blocked' as const, reason: '缺少自动评估工作记录。', score: null };
}

export function mapDisplayedQuestionNumbers(questions: readonly { readonly id: string }[], displayedItemIds: readonly string[]): number[] {
  return questions.flatMap((item, index) => displayedItemIds.includes(item.id) ? [index + 1] : []);
}
