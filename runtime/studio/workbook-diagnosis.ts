import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type Revision, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { projectHelpExposure } from '../../modules/activity/help-exposure.ts';
import { helpAppliesTo } from '../../modules/activity/help-exposure-values.ts';
import { materialType, storagePurpose } from '../../modules/activity/library-values.ts';
import { sourceReference, type SourceRefV1 } from '../../modules/activity/source-values.ts';
import {
  sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType,
  type WorkbookAttempt,
} from '../../modules/activity/workbook-values.ts';
import { workspaceEntryType } from '../../modules/activity/workspace-values.ts';
import { purpose } from './identity.ts';
import { readWorkbookHelpDisplays, readWorkbookSubmissionBirth } from './learning-attempt-read.ts';
import { resolveSource, type SourceTrack, type WorkspaceSourceRecipient } from './source-read.ts';
import { readSavedWorkbookAssessment } from './workbook-assessment.ts';
import { readWorkspaceAttemptAssessments, type WorkspaceAssessmentBasis } from './workspace-read.ts';

type Access = { maySend: WorkspaceSourceRecipient; track: SourceTrack; trackAssessment?: (basis: WorkspaceAssessmentBasis) => void };
const unavailable = { state: 'unavailable' } as const;

async function openFrozenPaper(tx: ReadTransaction, attempt: WorkbookAttempt, cutoff: Tick, access: Access) {
  const id = factId(attempt.paperId);
  const ref = attempt.paper.assessmentRelease?.releaseRef;
  if (ref && ref.id !== id) return;
  const { rows: [version] } = await tx.query<{ rev: Revision }>(
    `SELECT rev FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND tick<$3::bigint AND kind='value'
       AND ($4::int IS NULL OR rev=$4) ORDER BY rev DESC LIMIT 1`,
    [tx.learner, id, cutoff, ref?.rev ?? null],
  );
  if (!version) return;
  const read = createCommandReadContext(tx, purpose);
  const matches = (fact: FactSnapshot) => fact.type === workbookPaperType && sameWorkbookJson(workbookPaper(fact.value), attempt.paper);
  try {
    const frozen = await read.fact(id, { mode: 'pinned', rev: version.rev });
    if (!access.maySend(frozen) || !matches(frozen)) return;
    access.track(frozen, 'pinned');
  } catch (error) {
    if (!(error instanceof FactReadDeniedError) || error.reason !== 'purpose') throw error;
    // A later grant can license an unchanged copy. Verify the archive only after
    // opening the currently authorized paper and matching its payload.
    const current = await read.fact(id, { mode: 'following' });
    if (!access.maySend(current) || !matches(current)) return;
    const original = await createCommandReadContext(tx, storagePurpose).fact(id, { mode: 'pinned', rev: version.rev });
    if (!matches(original)) return;
    access.track(current, 'following');
  }
  return { id, rev: version.rev };
}

async function readReleasedAssessment(tx: ReadTransaction, attempt: WorkbookAttempt, submission: FactSnapshot, access: Access) {
  const release = attempt.paper.assessmentRelease;
  if (!release) return unavailable;
  const read = createCommandReadContext(tx, purpose);
  const current = await read.fact(submission.ref.id, { mode: 'following' });
  const paper = await read.fact(factId(release.releaseRef.id), { mode: 'following' });
  if (current.ref.rev !== submission.ref.rev || !access.maySend(current) || !access.maySend(paper)) return unavailable;
  const result = await readSavedWorkbookAssessment(tx, release.releaseRef, current, paper);
  if (!result) return unavailable;
  // These current grants, rather than the original scoring epochs, license the diagnosis.
  access.track(current, 'following');
  access.track(paper, 'following');
  return { state: result.state, score: result.score };
}

export async function readWorkbookDiagnosis(tx: ReadTransaction, reference: string | SourceRefV1, access: Access) {
  if (typeof reference !== 'string' && (reference.fact.type !== workbookAttemptType || reference.anchor.kind !== 'whole')) return;
  let submission: FactSnapshot | undefined;
  const recipient = { recipient: 'workspace' as const, maySend: access.maySend };
  const source = await resolveSource(tx, reference, {
    ...recipient, maySend: fact => fact.type === workbookAttemptType && access.maySend(fact),
    track(fact, mode) { submission = fact; access.track(fact, mode); },
  });
  if (!source || !submission) return;
  const { ref } = submission;
  const attempt = workbookAttempt(submission.value);
  const birth = await readWorkbookSubmissionBirth(tx, ref.id);
  if (!birth || birth.condition !== null || birth.submitted_at !== attempt.submittedAt) return;
  try {
    const paper = await openFrozenPaper(tx, attempt, birth.tick, access);
    if (!paper) return;
    const sourceAccess = { ...recipient, track: access.track };
    if (attempt.paper.materialId !== null) {
      const material = await resolveSource(tx, attempt.paper.materialId, sourceAccess);
      if (material?.sourceRef.fact.type !== materialType) return;
    }
    for (const { sourceQuestionRef, prompt } of attempt.paper.questions) {
      if (!sourceQuestionRef) continue;
      const question = await resolveSource(tx, {
        v: 1, fact: { ...sourceQuestionRef, type: workspaceEntryType }, anchor: { kind: 'question', itemId: 'question' },
      }, sourceAccess);
      if (question?.content !== prompt) return;
    }

    // Workbook creates the original issuance at revision 1. Grants can add
    // revisions of the same paper. Ordinary workbooks have no coverage proof.
    const targets = attempt.paper.questions.map(({ id }) => ({
      activityId: paper.id, issuance: { id: paper.id, rev: 1 as Revision }, item: { itemId: id },
    }));
    const read = createCommandReadContext(tx, purpose);
    const events = await readWorkbookHelpDisplays(tx, purpose, paper.id, birth.tick, async (fact, display) => {
      if (!access.maySend(fact) || !targets.some(target => helpAppliesTo(display, target))) return false;
      const content = await read.fact(display.content.id, { mode: 'pinned', rev: display.content.rev });
      if (!await resolveSource(tx, sourceReference(content, { kind: 'whole' }), sourceAccess)) return false;
      access.track(fact, 'following');
      return true;
    });
    const assessments = new Map((access.trackAssessment
      ? await readWorkspaceAttemptAssessments(tx, submission, access.maySend, access.trackAssessment) : [])
      .map(({ questionId, verdict, score }) => [questionId, { verdict, ...(score ? { score } : {}) }]));
    const formalAssessment = attempt.paper.assessmentRelease ? await readReleasedAssessment(tx, attempt, submission, access) : undefined;
    const questions = attempt.paper.questions.map((question, index) => {
      const { id, prompt, kind } = question;
      const observed = projectHelpExposure({ submission: { ref, target: targets[index]!, cutoff: birth.tick },
        events, coverage: null });
      const { result } = attempt.feedback[index]!;
      const assessment = assessments.get(id) ?? { verdict: result };
      return { id, prompt, answer: attempt.answers[id], kind, assessment,
        ...(kind === 'numeric' ? { unit: question.unit } : {}),
        independence: observed.kind === 'exposed' ? 'exposed' : 'unknown',
        help_exposure: observed.kind === 'exposed'
          ? { state: 'exposed', evidenceRefs: observed.evidenceRefs.map(({ id, rev }) => ({ id, rev })) }
          : { state: 'unknown', reason: observed.kind === 'unknown' ? observed.reason : 'incomplete-observation' } };
    });
    return { id: source.id, rev: source.rev, title: source.title, kind: 'attempt', lens: 'diagnose',
      sourceRef: source.sourceRef, frozenPaper: paper, questions, ...(formalAssessment ? { formalAssessment } : {}),
      image_crop: unavailable, effective_duration_ms: unavailable, concept_history: unavailable,
      mastery: unavailable, retention: unavailable };
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return;
    throw error;
  }
}
