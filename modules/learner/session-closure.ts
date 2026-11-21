type FixedRef = { id: string; rev: number };

export type SessionClosureScope =
  | ({ kind: 'attempt' | 'classroom' } & FixedRef)
  | { kind: 'today'; day: string; timeZone: string };

type ClosureItem = {
  // Stable identity of the frozen question item, including its release.
  itemKey: string;
  result: 'correct' | 'incorrect' | 'skipped' | 'unknown';
  help: 'independent' | 'assisted' | 'unknown';
  confidence: number | null;
};

export type SessionClosureEvidence = {
  // Newest last. A null collection or item list means coverage could not be established.
  submissions: readonly { ref: FixedRef; items: readonly ClosureItem[] | null }[] | null;
  // Only authorized positive refutations revalidated by the Hypothesis owner.
  refutations: readonly { submission: FixedRef; hypothesisId: string; oldStep: string | null }[] | null;
  // Only explicitly unresolved blockers. The host orders by most recent first.
  blockers: readonly { text: string }[] | null;
  openThoughtIds: readonly string[] | null;
};

export type SessionClosureReceipt = {
  stabilized: number | null;
  contradicted: number | null;
  refutedSteps: readonly string[] | null;
  blocker: { text: string } | null;
  blockerKnown: boolean;
  openThoughts: number | null;
};

export class SessionClosureConflict extends Error {}

export const sessionClosureType = 'learner.sessionClosure';
export const activitySubmissionTypes = ['activity.workbookAttempt', 'activity.retentionPosttestSubmission'];

export function sameClosureRef(a: FixedRef, b: FixedRef) {
  return a.id === b.id && a.rev === b.rev;
}

function stabilizedCount(submissions: NonNullable<SessionClosureEvidence['submissions']>) {
  const latest = new Map<string, ClosureItem>();
  for (const { items } of submissions) {
    if (items === null) return null;
    for (const item of items) latest.set(item.itemKey, item);
  }
  let count = 0;
  for (const { result, help, confidence } of latest.values()) {
    if (result === 'unknown' || (result === 'correct' && help === 'unknown')) return null;
    if (result === 'correct' && help === 'independent' && (confidence === null || confidence > 0.35)) count++;
  }
  return count;
}

export function projectSessionClosure(evidence: SessionClosureEvidence): SessionClosureReceipt {
  const { submissions, refutations, blockers, openThoughtIds } = evidence;
  const refuted = submissions === null || refutations === null ? null : new Map<string, string | null>();
  if (refuted && submissions && refutations) {
    for (const { submission, hypothesisId, oldStep } of refutations) {
      if (submissions.some(({ ref }) => sameClosureRef(submission, ref)))
        refuted.set(hypothesisId, refuted.get(hypothesisId) ?? oldStep);
    }
  }
  return {
    stabilized: submissions === null ? null : stabilizedCount(submissions),
    contradicted: refuted?.size ?? null,
    refutedSteps: refuted ? [...refuted.values()].filter((step): step is string => step !== null) : null,
    blocker: blockers?.[0] ? { text: blockers[0].text } : null,
    blockerKnown: blockers !== null,
    openThoughts: openThoughtIds === null ? null : new Set(openThoughtIds).size,
  };
}
