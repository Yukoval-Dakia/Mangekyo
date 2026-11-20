import type { FactRef, Tick } from '@mangekyo/kernel';

export type TraceAttempt = {
  submission: FactRef; item: { paper: FactRef; itemId: string };
  images: readonly FactRef[]; help: readonly FactRef[];
  occurredAt: string; admittedAt: Tick;
  conceptIds: readonly string[]; mechanismIds: readonly string[]; methodIds: readonly string[];
  outcome: 'correct' | 'incorrect' | 'unknown'; helpLevel: 'independent' | 'hinted' | 'solution_seen' | 'unknown';
  explanation?: { origin: 'learner-quote' | 'inference'; text: string; source: FactRef };
};

// The caller gathers the original authorized anchors (including image/help/
// explanation sources) into its manifest. This projection has no private index.
export function backtrace(target: {
  learner: FactRef['learner']; conceptIds: readonly string[]; mechanismIds: readonly string[]; methodIds: readonly string[];
  asOfAt: string; observedThrough: Tick; submissionId?: string;
}, history: readonly TraceAttempt[]) {
  const overlaps = (a: readonly string[], b: readonly string[]) => a.some(id => b.includes(id));
  const cutoff = Date.parse(target.asOfAt);
  const comparable = history.filter(a => a.submission.id !== target.submissionId &&
    Date.parse(a.occurredAt) <= cutoff && BigInt(a.admittedAt) <= BigInt(target.observedThrough) &&
    [a.submission, a.item.paper, ...a.images, ...a.help, ...(a.explanation ? [a.explanation.source] : [])]
      .every(ref => ref.learner === target.learner))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.submission.id.localeCompare(b.submission.id));
  return {
    similarErrors: comparable.filter(a => a.outcome === 'incorrect' && overlaps(target.mechanismIds, a.mechanismIds)),
    independentSuccesses: comparable.filter(a => a.outcome === 'correct' && a.helpLevel === 'independent' &&
      (overlaps(target.methodIds, a.methodIds) || overlaps(target.conceptIds, a.conceptIds))),
  };
}
