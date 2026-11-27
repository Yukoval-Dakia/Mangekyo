import {
  factId, isFactUnavailable, type CanonicalEvidenceSliceV1, type EvidenceEventV1, type FactId,
  type FactSnapshot, type ReadContext, type ReadTransaction, type Revision, type Tick,
} from '@mangekyo/kernel';
import type { AssessmentRelease, AssessmentRevisionRef, FormalAssessmentValue } from './assessment-values.ts';
import { workbookExamPacingEvent, workbookExamPacingItems } from './evidence-slice.ts';
import { readFrozenWorkbookBank } from './workbook-bank.ts';
import { workbookAttempt, workbookAttemptType, workbookPaperType } from './workbook-values.ts';

/**
 * Authorized CanonicalEvidenceSliceV1 builder for `GET /api/papers/exam-pacing`.
 * Opens attempts and pinned papers through the caller's authorized Notion-aware reader, skips sealed
 * practice and revoked bank sources, reads settled formal scores through `readWorkbookAssessment`,
 * preserves per-paper `paper_key` (preventing cross-paper comparisons), omits 0ms whole-paper durations
 * so `plan/exam-pacing@1` never fails on valid 0ms attempts, and emits per-item `pacing` events.
 */

export type ExamPacingFormalResult = {
  readonly state: string;
  readonly releaseRef?: AssessmentRevisionRef;
  readonly score?: FormalAssessmentValue['score'] | null;
  readonly result?: FormalAssessmentValue['result'];
};

export type ExamPacingSliceDeps = {
  readonly read: Pick<ReadContext, 'fact'>;
  readonly isPracticeWorkbook: (tx: ReadTransaction, paperId: FactId) => Promise<boolean>;
  readonly readFormal: (
    tx: ReadTransaction, release: AssessmentRelease, submissionRef: AssessmentRevisionRef,
    epochs: { readonly releaseEpoch: string; readonly submissionEpoch: string },
  ) => Promise<ExamPacingFormalResult>;
};

export type GatheredExamPacingSlice = {
  readonly slice: CanonicalEvidenceSliceV1;
  readonly checked: readonly {
    readonly attemptId: FactId; readonly attemptRev: Revision; readonly attemptEpoch: string;
    readonly paperId: FactId; readonly paperRev: Revision; readonly paperEpoch: string;
  }[];
};

const unavailableErrorNames = new Set(['FactNotFoundError', 'FactReadDeniedError', 'FactRevisionNotFoundError']);
const isUnavailableError = (error: unknown): boolean =>
  isFactUnavailable(error) || (error instanceof Error &&
    (unavailableErrorNames.has(error.name) || unavailableErrorNames.has(error.constructor?.name ?? '')));

type SourceWitness = { readonly id: string; readonly rev: number; readonly accessEpoch?: string | number };

function collectWitnesses(data: unknown, out: SourceWitness[] = []): SourceWitness[] {
  if (Array.isArray(data)) { for (const item of data) collectWitnesses(item, out); return out; }
  if (data && typeof data === 'object') {
    const row = data as Record<string, unknown>;
    const epoch = typeof row.accessEpoch === 'string' || typeof row.accessEpoch === 'number' ? row.accessEpoch : row.epoch;
    if (typeof row.id === 'string' && row.id.length === 26 && typeof row.rev === 'number' &&
        (typeof epoch === 'string' || typeof epoch === 'number')) {
      out.push({ id: row.id, rev: row.rev, accessEpoch: epoch });
    }
    for (const value of Object.values(row)) collectWitnesses(value, out);
  }
  return out;
}

async function verifyWitnesses(read: Pick<ReadContext, 'fact'>, fact: FactSnapshot, seen = new Set<string>()) {
  for (const use of collectWitnesses(fact.value)) {
    const key = `${use.id}:${use.rev}:${use.accessEpoch ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dep = await read.fact(factId(use.id), { mode: 'pinned', rev: use.rev as Revision });
    if (use.accessEpoch !== undefined && dep.accessEpoch !== String(use.accessEpoch)) throw new Error('epoch_changed');
    await verifyWitnesses(read, dep, seen);
  }
}

async function verifyAttemptPaper(
  tx: ReadTransaction, deps: ExamPacingSliceDeps, attemptFact: FactSnapshot, paperId: FactId, paperRev: Revision,
) {
  if (await deps.isPracticeWorkbook(tx, paperId)) return undefined;
  const paperFact = await deps.read.fact(paperId, { mode: 'pinned', rev: paperRev });
  if (paperFact.type !== workbookPaperType) return undefined;
  const parsed = workbookAttempt(attemptFact.value);
  await readFrozenWorkbookBank(deps.read, parsed.paper);
  await verifyWitnesses(deps.read, paperFact);
  await verifyWitnesses(deps.read, attemptFact);
  return { paperFact, attempt: parsed };
}

/** Gather an authorized CanonicalEvidenceSliceV1 inside one short read-only snapshot. */
export async function gatherExamPacingSlice(
  tx: ReadTransaction, deps: ExamPacingSliceDeps, paperIdFilter?: string, limit = 16,
): Promise<GatheredExamPacingSlice> {
  const [{ rows: candidates }, { rows: [clockRow] }] = await Promise.all([
    tx.query<{ id: string }>(
      `SELECT f.id FROM facts f
         JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
        WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
          AND (f.purpose && ARRAY['storage','all']::text[])
          AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
          AND ($3::text IS NULL OR r.data->>'paperId'=$3)
        ORDER BY f.created_tick DESC LIMIT $4`,
      [tx.learner, workbookAttemptType, paperIdFilter ?? null, limit]),
    tx.query<{ clock: string }>('SELECT clock::text AS clock FROM learners WHERE id=$1', [tx.learner]),
  ]);

  const events: EvidenceEventV1[] = [];
  const checked: GatheredExamPacingSlice['checked'][number][] = [];
  let maxOccurredAt = new Date().toISOString();

  for (const { id } of candidates) {
    let attemptFact: FactSnapshot;
    try { attemptFact = await deps.read.fact(factId(id), { mode: 'following' }); }
    catch (error) { if (isUnavailableError(error)) continue; throw error; }
    if (attemptFact.type !== workbookAttemptType) continue;

    let attempt;
    try { attempt = workbookAttempt(attemptFact.value); }
    catch { continue; }
    if (paperIdFilter !== undefined && attempt.paperId !== paperIdFilter) continue;

    const paperId = factId(attempt.paperId);
    const paperRev = (attempt.paperRev ?? 1) as Revision;
    let verified;
    try { verified = await verifyAttemptPaper(tx, deps, attemptFact, paperId, paperRev); }
    catch (error) {
      if (isUnavailableError(error) || (error instanceof Error && error.message === 'epoch_changed')) continue;
      throw error;
    }
    if (!verified) continue;

    const paperRef: AssessmentRevisionRef = { id: paperId, rev: paperRev };
    const release = attempt.paper.assessmentRelease;
    let formal: ExamPacingFormalResult | undefined;
    if (release) {
      formal = await deps.readFormal(tx, release, { id: attemptFact.ref.id, rev: attemptFact.ref.rev }, {
        releaseEpoch: verified.paperFact.accessEpoch, submissionEpoch: attemptFact.accessEpoch,
      });
    }

    // plan/exam-pacing@1 requires whole-paper effective_duration_ms >= 1; omit 0ms so valid attempts do not fail validation.
    const { effectiveDurationMs, ...attemptWithoutDuration } = attempt;
    const normalizedAttempt = effectiveDurationMs === 0 ? attemptWithoutDuration : attempt;
    const formalForEvent = formal && formal.state === 'complete' && formal.releaseRef && formal.score
      ? { state: formal.state, releaseRef: formal.releaseRef, score: formal.score } : undefined;
    const formalForItems = formal && formal.state === 'complete' && formal.releaseRef
      ? { state: formal.state, releaseRef: formal.releaseRef, ...(formal.result ? { result: formal.result } : {}) } : undefined;

    events.push(workbookExamPacingEvent(attemptFact.ref, normalizedAttempt, paperRef, formalForEvent) as EvidenceEventV1);
    events.push(...workbookExamPacingItems(attemptFact.ref, attempt, paperRef, formalForItems));
    if (attempt.submittedAt > maxOccurredAt) maxOccurredAt = attempt.submittedAt;
    checked.push({
      attemptId: attemptFact.ref.id, attemptRev: attemptFact.ref.rev, attemptEpoch: attemptFact.accessEpoch,
      paperId: paperRef.id, paperRev: paperRef.rev, paperEpoch: verified.paperFact.accessEpoch,
    });
  }

  events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.ref.localeCompare(b.ref));
  const slice: CanonicalEvidenceSliceV1 = {
    clock_watermark: String(clockRow?.clock ?? '0') as Tick,
    as_of_at: maxOccurredAt,
    events,
    constraints: { budget_min: null, locks: [], deadlines: [] },
    candidate_pool: [],
  };
  return { slice, checked };
}

/** Post-derive authorization re-check confirming none of the gathered attempts/papers changed or were revoked. */
export async function verifyExamPacingSlice(
  tx: ReadTransaction, deps: ExamPacingSliceDeps, gathered: GatheredExamPacingSlice,
): Promise<boolean> {
  for (const item of gathered.checked) {
    try {
      const attemptFact = await deps.read.fact(item.attemptId, { mode: 'following' });
      if (attemptFact.ref.rev !== item.attemptRev || attemptFact.accessEpoch !== item.attemptEpoch) return false;
      const verified = await verifyAttemptPaper(tx, deps, attemptFact, item.paperId, item.paperRev);
      if (!verified || verified.paperFact.accessEpoch !== item.paperEpoch) return false;
    } catch (error) {
      if (isUnavailableError(error) || (error instanceof Error && error.message === 'epoch_changed')) return false;
      throw error;
    }
  }
  return true;
}
