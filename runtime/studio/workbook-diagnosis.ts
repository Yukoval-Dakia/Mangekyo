import {
  createAuthorizedFactReader, createCommandReadContext, FactNotFoundError, FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type Revision, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { frozenWorkbookRevision, licensedQuestionCopy } from '../../modules/activity/evidence-read.ts';
import { helpAppliesTo } from '../../modules/activity/help-exposure-values.ts';
import { materialType, storagePurpose } from '../../modules/activity/library-values.ts';
import { assetType } from '../../modules/content/asset.ts';
import { sourceReference, type SourceRefV1 } from '../../modules/activity/source-values.ts';
import {
  sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType,
  type WorkbookAttempt,
} from '../../modules/activity/workbook-values.ts';
import { workbookDiagnosisView } from '../../modules/activity/workbook-views.ts';
import { workspaceEntryType } from '../../modules/activity/workspace-values.ts';
import { purpose } from './identity.ts';
import { readActivityHelpEvents, readActivitySubmissionBirth } from './learning-attempt-read.ts';
import { resolveSource, type SourceTrack, type WorkspaceSourceRecipient } from './source-read.ts';
import { readSavedWorkbookAssessment } from './workbook-assessment.ts';
import { readWorkspaceAttemptAssessments, type WorkspaceAssessmentBasis } from './workspace-read.ts';

type Access = { purpose?: string; ownerNotionRead?: true; maySend: WorkspaceSourceRecipient; track: SourceTrack; trackAssessment?: (basis: WorkspaceAssessmentBasis) => void };
const unavailable = { state: 'unavailable' } as const;

async function openFrozenPaper(tx: ReadTransaction, attempt: WorkbookAttempt, cutoff: Tick, access: Access) {
  const id = factId(attempt.paperId);
  const ref = attempt.paper.assessmentRelease?.releaseRef;
  if (ref && ref.id !== id) return;
  const version = await frozenWorkbookRevision(tx, id, cutoff, ref?.rev ?? null);
  if (!version) return;
  const read = createAuthorizedFactReader(tx, access.purpose ?? purpose, access.maySend);
  const matches = (fact: FactSnapshot) => fact.type === workbookPaperType && sameWorkbookJson(workbookPaper(fact.value), attempt.paper);
  try {
    const frozen = await read.fact(id, { mode: 'pinned', rev: version.rev });
    if (!matches(frozen)) return;
    access.track(frozen, 'pinned');
  } catch (error) {
    if (!(error instanceof FactReadDeniedError) || error.reason !== 'purpose') throw error;
    // A later grant can license an unchanged copy. Verify the archive only after
    // opening the currently authorized paper and matching its payload.
    const current = await read.fact(id, { mode: 'following' });
    if (!matches(current)) return;
    const original = await createCommandReadContext(tx, storagePurpose).fact(id, { mode: 'pinned', rev: version.rev });
    if (!matches(original)) return;
    access.track(current, 'following');
  }
  return { id, rev: version.rev };
}

export async function readReleasedAssessment(tx: ReadTransaction, attempt: WorkbookAttempt, submission: FactSnapshot, access: Access) {
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

export async function openWorkbookDiagnosisSource(tx: ReadTransaction, reference: string | SourceRefV1, access: Access) {
  if (typeof reference !== 'string' && (reference.fact.type !== workbookAttemptType || reference.anchor.kind !== 'whole')) return;
  let submission: FactSnapshot | undefined;
  const recipient = { recipient: 'workspace' as const, maySend: access.maySend };
  const source = await resolveSource(tx, reference, {
    ...recipient, maySend: fact => fact.type === workbookAttemptType && access.maySend(fact),
    track(fact, mode) { submission = fact; access.track(fact, mode); },
  });
  if (!source || !submission) return;
  const opened = await openWorkbookQuestionSources(tx, submission, access);
  return opened && {source, submission, ...opened};
}

export async function openWorkbookQuestionSources(tx: ReadTransaction, submission: FactSnapshot, access: Access, itemId?: string) {
  const attempt = workbookAttempt(submission.value);
  const birth = await readActivitySubmissionBirth(tx, submission.ref, workbookAttemptType);
  if (!birth?.unchanged || birth.submittedAt !== attempt.submittedAt) return;
  try {
    const paper = await openFrozenPaper(tx, attempt, birth.tick, access);
    if (!paper) return;
    const sourceAccess = {...access, recipient: 'workspace' as const, purpose: access.purpose ?? purpose};
    if (attempt.paper.materialId !== null) {
      const material = await resolveSource(tx, attempt.paper.materialId, sourceAccess);
      if (material?.sourceRef.fact.type !== materialType) return;
    }
    const read = createAuthorizedFactReader(tx, sourceAccess.purpose, access.maySend);
    for (const { id, sourceQuestionRef, prompt } of attempt.paper.questions) {
      if (itemId !== undefined && id !== itemId) continue;
      if (!sourceQuestionRef) continue;
      const readable = itemId ? await licensedQuestionCopy(tx, sourceQuestionRef, sourceAccess.purpose) : sourceQuestionRef;
      const { type } = await read.fact(factId(readable.id), {mode:'pinned', rev:readable.rev as Revision});
      if (type !== assetType && type !== workspaceEntryType) return;
      const question = await resolveSource(tx, {
        v: 1, fact: { ...readable, type }, anchor: { kind: 'question', itemId: 'question' },
      }, sourceAccess);
      if (question?.content !== prompt) return;
    }
    return {attempt, birth, paper, sourceAccess};
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return;
    throw error;
  }
}

export async function readWorkbookDiagnosis(tx: ReadTransaction, reference: string | SourceRefV1, access: Access) {
  const opened = await openWorkbookDiagnosisSource(tx, reference, access);
  if (!opened) return;
  const {source, submission, attempt, birth, paper, sourceAccess} = opened;
  const {ref} = submission;
  try {

    // Workbook creates the original issuance at revision 1. Grants can add
    // revisions of the same paper. Ordinary workbooks have no coverage proof.
    const targets = attempt.paper.questions.map(({ id }) => ({
      activityId: paper.id, issuance: { id: paper.id, rev: 1 as Revision }, item: { itemId: id },
    }));
    const read = createCommandReadContext(tx, purpose);
    const { events } = await readActivityHelpEvents(tx, read, {
      activities: [paper.id], cutoff: birth.tick, mode: 'following',
    }, async (fact, display) => {
      if (!access.maySend(fact) || !targets.some(target => helpAppliesTo(display, target))) return false;
      const content = await read.fact(display.content.id, { mode: 'pinned', rev: display.content.rev });
      if (!await resolveSource(tx, sourceReference(content, { kind: 'whole' }), sourceAccess)) return false;
      access.track(fact, 'following');
      return true;
    });
    const assessments = access.trackAssessment
      ? await readWorkspaceAttemptAssessments(tx, submission, access.maySend, access.trackAssessment) : [];
    const formalAssessment = attempt.paper.assessmentRelease ? await readReleasedAssessment(tx, attempt, submission, access) : undefined;
    return workbookDiagnosisView(source, attempt, paper, { ref, cutoff: birth.tick, targets, events }, assessments, formalAssessment);
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return;
    throw error;
  }
}
