import {
  FactNotFoundError, FactReadDeniedError, factId,
  type FactSnapshot, type ReadContext, type ReadTransaction, type Revision, type Tick,
} from '@mangekyo/kernel';
import { assetType } from '@mangekyo/module-content/facts/asset-contract';
import { frozenWorkbookRevision, licensedQuestionCopy, type FactReadChecks } from './evidence-read.ts';
import { helpAppliesTo } from './help-exposure-values.ts';
import { materialType, storagePurpose } from './library-values.ts';
import { workbookAttemptView } from './workbook-assessment-values.ts';
import { readFrozenWorkbookBank } from './workbook-bank.ts';
import { sourceReference, type SourceRefV1 } from './source-values.ts';
import {
  sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType,
  WorkbookSourceMismatch, type WorkbookAttempt,
} from './workbook-values.ts';
import { formalDiagnosisSummary, workbookDiagnosisView, type WorkbookDiagnosisContext } from './workbook-views.ts';
import { workspaceEntryType } from './workspace-values.ts';
import { readActivityHelpEvents, readActivitySubmissionBirth } from './learning-attempt-read.ts';
export type DiagnosisTrack = (fact: FactSnapshot, mode?: 'pinned' | 'following') => void;
export type DiagnosisMaySend = (fact: FactSnapshot) => boolean;
export type StudioDiagnosisDeps = FactReadChecks & {
  readonly purpose: string;
  readonly revisionsOnlyChangeGrants: (tx: ReadTransaction, id: FactSnapshot['ref']['id'], fromRev: number, toRev: number) => Promise<boolean>;
  readonly createAuthorizedFactReader: (tx: ReadTransaction, purpose: string, maySend: DiagnosisMaySend) => Pick<ReadContext, 'fact'>;
  readonly createCommandReadContext: (tx: ReadTransaction, purpose: string) => ReadContext;
  readonly resolveSource: (tx: ReadTransaction, input: unknown, access: unknown) => Promise<any>;
  readonly readSavedWorkbookAssessment: (tx: ReadTransaction, releaseRef: any, submission: FactSnapshot, paper: FactSnapshot, cutoff?: Tick) => Promise<any>;
  readonly readWorkspaceAttemptAssessments: (tx: ReadTransaction, attempt: FactSnapshot, maySend: DiagnosisMaySend, track: (basis: any) => void) => Promise<any>;
  readonly diagnosisContext: (tx: ReadTransaction, input: { readonly attempt: WorkbookAttempt; readonly access: StudioDiagnosisAccess }) => Promise<WorkbookDiagnosisContext>;
};
export type StudioDiagnosisAccess = {
  purpose?: string; ownerNotionRead?: true; maySend: DiagnosisMaySend; track: DiagnosisTrack;
  trackAssessment?: (basis: any) => void;
};
export const studioDiagnosisSourceUnavailable = (deps: Pick<StudioDiagnosisDeps, 'isFactNotFound' | 'isFactReadDenied'>, error: unknown) =>
  deps.isFactReadDenied(error) || deps.isFactNotFound(error) || error instanceof WorkbookSourceMismatch;
async function openFrozenPaper(deps: StudioDiagnosisDeps, tx: ReadTransaction, attempt: WorkbookAttempt, cutoff: Tick,
  access: StudioDiagnosisAccess) {
  const id = factId(attempt.paperId);
  const ref = attempt.paper.assessmentRelease?.releaseRef;
  if (ref && ref.id !== id) return;
  const version = await frozenWorkbookRevision(tx, id, cutoff, ref?.rev ?? null);
  if (!version) return;
  const read = deps.createAuthorizedFactReader(tx, access.purpose ?? deps.purpose, access.maySend);
  const matches = (fact: FactSnapshot) => fact.type === workbookPaperType && sameWorkbookJson(workbookPaper(fact.value), attempt.paper);
  try {
    const frozen = await read.fact(id, { mode: 'pinned', rev: version.rev });
    if (!matches(frozen)) return;
    access.track(frozen, 'pinned');
  } catch (error) {
    if (!(deps.isFactReadDenied(error) || error instanceof FactReadDeniedError) ||
        (error as { reason?: string }).reason !== 'purpose') throw error;
    // A later grant can license an unchanged copy. Verify the archive only after
    // opening the currently authorized paper and matching its payload.
    const current = await read.fact(id, { mode: 'following' });
    if (!matches(current) || !await deps.revisionsOnlyChangeGrants(tx, id, version.rev, current.ref.rev)) return;
    const original = await deps.createCommandReadContext(tx, storagePurpose).fact(id, { mode: 'pinned', rev: version.rev });
    if (!matches(original)) return;
    access.track(current, 'following');
  }
  return { id, rev: version.rev };
}
export async function readReleasedAssessment(deps: StudioDiagnosisDeps, tx: ReadTransaction, attempt: WorkbookAttempt,
  submission: FactSnapshot, access: StudioDiagnosisAccess, cutoff?: Tick) {
  const release = attempt.paper.assessmentRelease;
  if (!release) return;
  const read = deps.createAuthorizedFactReader(tx, deps.purpose, access.maySend);
  try {
    const current = await read.fact(submission.ref.id, { mode: 'following' });
    const paper = await read.fact(release.releaseRef.id, { mode: 'following' });
    if (current.ref.rev !== submission.ref.rev) return;
    const result = await deps.readSavedWorkbookAssessment(tx, release.releaseRef, current, paper, cutoff);
    if (!result) return;
    // Current grants license the unchanged paper and submission.
    access.track(current, 'following');
    access.track(paper, 'following');
    return result;
  } catch (error) {
    if (studioDiagnosisSourceUnavailable(deps, error)) return;
    throw error;
  }
}
export async function openWorkbookDiagnosisSource(deps: StudioDiagnosisDeps, tx: ReadTransaction,
  reference: string | SourceRefV1, access: StudioDiagnosisAccess) {
  if (typeof reference !== 'string' && (reference.fact.type !== workbookAttemptType || reference.anchor.kind !== 'whole')) return;
  const id = typeof reference === 'string' ? reference : reference.fact.id;
  let submission: FactSnapshot | undefined;
  const source = await deps.resolveSource(tx, reference, {
    recipient: 'workspace', rootType: workbookAttemptType, maySend: access.maySend,
    track(fact: FactSnapshot, mode?: 'pinned' | 'following') {
      if (fact.ref.id === id && fact.type === workbookAttemptType) submission = fact;
      access.track(fact, mode);
    },
  });
  if (!source || !submission) return;
  const opened = await openWorkbookQuestionSources(deps, tx, submission, access);
  return opened && { source, submission, ...opened };
}
export async function openWorkbookQuestionSources(deps: StudioDiagnosisDeps, tx: ReadTransaction,
  submission: FactSnapshot, access: StudioDiagnosisAccess, itemId?: string) {
  if (submission.type !== workbookAttemptType || submission.ref.learner !== tx.learner) return;
  const attempt = workbookAttempt(submission.value);
  const birth = await readActivitySubmissionBirth(tx, submission.ref, workbookAttemptType);
  if (!birth?.unchanged || birth.submittedAt !== attempt.submittedAt) return;
  try {
    const paper = await openFrozenPaper(deps, tx, attempt, birth.tick, access);
    if (!paper) return;
    const sourceAccess = { ...access, recipient: 'workspace' as const, purpose: access.purpose ?? deps.purpose };
    if (attempt.paper.materialId !== null) {
      const material = await deps.resolveSource(tx, attempt.paper.materialId, sourceAccess);
      if (material?.sourceRef.fact.type !== materialType) return;
    }
    const questions = itemId === undefined ? attempt.paper.questions : attempt.paper.questions.filter(q => q.id === itemId);
    const read = deps.createAuthorizedFactReader(tx, sourceAccess.purpose, access.maySend);
    await readFrozenWorkbookBank(read, { ...attempt.paper, questions }, access.track);
    for (const { kind, sourceQuestionRef, prompt } of questions) {
      if (kind === 'bank' || !sourceQuestionRef) continue;
      const readable = await licensedQuestionCopy(tx, sourceQuestionRef, sourceAccess.purpose);
      const { type } = await read.fact(factId(readable.id), { mode: 'pinned', rev: readable.rev as Revision });
      if (type !== assetType && type !== workspaceEntryType) return;
      const question = await deps.resolveSource(tx, {
        v: 1, fact: { ...readable, type }, anchor: { kind: 'question', itemId: 'question' },
      }, sourceAccess);
      if (question?.content !== prompt) return;
    }
    return { attempt, birth, paper, sourceAccess };
  } catch (error) {
    if (studioDiagnosisSourceUnavailable(deps, error)) return;
    throw error;
  }
}
export async function readWorkbookDiagnosis(deps: StudioDiagnosisDeps, tx: ReadTransaction,
  reference: string | SourceRefV1, access: StudioDiagnosisAccess) {
  const opened = await openWorkbookDiagnosisSource(deps, tx, reference, access);
  if (!opened) return;
  const { source, submission, attempt, birth, paper, sourceAccess } = opened;
  const { ref } = submission;
  try {
    // Workbook creates the original issuance at revision 1. Grants can add
    // revisions of the same paper. Ordinary workbooks have no coverage proof.
    const targets = attempt.paper.questions.map(({ id }) => ({
      activityId: paper.id, issuance: { id: paper.id, rev: 1 as Revision }, item: { itemId: id },
    }));
    const read = deps.createCommandReadContext(tx, deps.purpose);
    const { events } = await readActivityHelpEvents(tx, read, {
      activities: [paper.id], cutoff: birth.tick, mode: 'following',
    }, async (fact, display) => {
      if (!access.maySend(fact) || !targets.some(target => helpAppliesTo(display, target))) return false;
      const content = await read.fact(display.content.id, { mode: 'pinned', rev: display.content.rev });
      if (!await deps.resolveSource(tx, sourceReference(content, { kind: 'whole' }), sourceAccess)) return false;
      access.track(fact, 'following');
      return true;
    });
    const assessments = access.trackAssessment
      ? await deps.readWorkspaceAttemptAssessments(tx, submission, access.maySend, access.trackAssessment) : [];
    const formal = await readReleasedAssessment(deps, tx, attempt, submission, access);
    const feedback = workbookAttemptView(ref.id, attempt, [], formal?.result).feedback;
    const diagnosisContext = await deps.diagnosisContext(tx, { attempt, access: sourceAccess });
    return workbookDiagnosisView(source, attempt, paper, { ref, cutoff: birth.tick, targets, events },
      assessments, formalDiagnosisSummary(formal, Boolean(attempt.paper.assessmentRelease)), feedback, diagnosisContext);
  } catch (error) {
    if (studioDiagnosisSourceUnavailable(deps, error)) return;
    throw error;
  }
}
