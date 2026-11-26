import { createHash } from 'node:crypto';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { sealCandidate, submitCandidate, type CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import {
  createPropagationHooks, factId, isFactUnavailable, markSlotFailed,
  readSlotStatus, type Db, type ReadTransaction, type Revision,
} from '../../kernel/src/index.ts';
import { failWork, readWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { artifactActionRecord } from '../../modules/activity/artifact-action.ts';
import type { AssessmentPublicationTarget } from '../../modules/activity/assessment-publication.ts';
import { assessmentRelease, assessmentSubmission, formalAssessmentValue, type AssessmentRelease, type AssessmentRevisionRef, type AssessmentSubmission } from '../../modules/activity/assessment-values.ts';
import { evaluateSentenceBreaks, qualifySentenceBreakAssessment, sentenceBreakRelease, type SentenceBreakPublicationEvidence } from '../../modules/activity/sentence-break-assessment.ts';
import slot from '../../modules/activity/slots/artifact-formal-assessment.ts';
import { artifactMount } from '../../modules/content/artifact.ts';
import { sentenceBreakQuestion, type Artifact } from '../../surfaces/shared/presentation/index.ts';
import { assessmentExecutionFailed, assessmentInputsBlocked, readFormalAssessment, type AssessmentScope } from './formal-assessment.ts';
import { purpose, stableId, studioHost } from './identity.ts';
export const artifactAssessmentSlot = slot.type;
export const artifactAssessmentPolicy: CandidatePolicy = { slot, purpose, deriver: 'activity/artifact-formal-assessment-v1' };
const propagation = createPropagationHooks([]);
type FrozenInputs = { release: AssessmentRelease; submission: AssessmentSubmission };
class ArtifactAssessmentInputUnavailable extends Error {}
export type ReadArtifactAssessmentWitness = (target: AssessmentPublicationTarget, view: Artifact, predictionPrompt: string) => SentenceBreakPublicationEvidence | null | undefined;
export function artifactAssessmentDigest(view: Artifact, predictionPrompt: string) { return createHash('sha256').update(canonicalJsonString({ view, predictionPrompt })).digest('hex'); }
export function qualifyArtifactAssessment(releaseRef: AssessmentRevisionRef, view: Artifact, predictionPrompt: string, alternatives: unknown, readWitness?: ReadArtifactAssessmentWitness) {
  const { itemId, slotId, breakpointIds } = sentenceBreakQuestion(view);
  const release = sentenceBreakRelease(releaseRef, itemId, slotId, breakpointIds, artifactAssessmentDigest(view, predictionPrompt), alternatives);
  return qualifySentenceBreakAssessment(release, target => readWitness?.(target, view, predictionPrompt), (witness, sample) => ({
    id: factId(stableId('sentence-break-verification', releaseRef.id, String(releaseRef.rev), witness.id, String(witness.rev), sample.id, String(sample.rev))), rev: 1 as Revision,
  }));
}
export function readArtifactAssessment(tx: ReadTransaction, releaseRef: AssessmentRevisionRef, submissionRef: AssessmentRevisionRef) {
  return readFormalAssessment(tx, artifactAssessmentSlot, releaseRef, submissionRef, purpose);
}
export async function executeArtifactAssessment(db: Db, ref: WorkRef, terminalFailure: boolean) {
  const host = studioHost(db), learner = host.learner, work = await readWork(db, ref);
  if (work?.slotType !== artifactAssessmentSlot || work.deriver !== artifactAssessmentPolicy.deriver) return;
  const row = await host.snapshot(tx => readSlotStatus<AssessmentScope>(tx, artifactAssessmentSlot, work.slotKey));
  if (!row) throw new Error('Artifact assessment is missing its frozen scope');
  const { releaseRef, submissionRef, releaseEpoch, submissionEpoch } = row.scopeKeys;
  try {
    const snapshot = await gatherSnapshot(db, { learner, purpose }, async ({ read }) => {
      const mount = await read.fact(releaseRef.id, { mode: 'pinned', rev: releaseRef.rev }), action = await read.fact(submissionRef.id, { mode: 'pinned', rev: submissionRef.rev });
      if (mount.type !== 'content.mountedArtifact' || action.type !== 'activity.artifactAction' || mount.accessEpoch !== releaseEpoch || action.accessEpoch !== submissionEpoch)
        throw new ArtifactAssessmentInputUnavailable();
      const { assessment } = artifactMount(mount.value), record = artifactActionRecord(action.value);
      if (!assessment || record.mountId !== mount.ref.id) throw new ArtifactAssessmentInputUnavailable();
      const release = assessmentRelease(assessment.release), submission = assessmentSubmission(record.submission, release);
      if (release.releaseRef.id !== releaseRef.id || release.releaseRef.rev !== releaseRef.rev || submission.submissionRef.id !== submissionRef.id || submission.submissionRef.rev !== submissionRef.rev)
        throw new ArtifactAssessmentInputUnavailable();
      return { kind: 'input', data: { release, submission }, effects: [] };
    });
    const sealed = await sealCandidate(db, ref, artifactAssessmentPolicy, snapshot);
    if (sealed.kind !== 'sealed') return;
    if (terminalFailure) { await submitCandidate(db, ref, artifactAssessmentPolicy, sealed.id, { kind: 'failed', reason: assessmentExecutionFailed }, propagation); return; }
    const { release, submission } = sealed.plan.data as FrozenInputs;
    await submitCandidate(db, ref, artifactAssessmentPolicy, sealed.id, { kind: 'value', value: formalAssessmentValue(release, submission, evaluateSentenceBreaks(release, submission), []) }, propagation);
  } catch (error) {
    if (!(isFactUnavailable(error) || error instanceof ArtifactAssessmentInputUnavailable)) throw error;
    await failWork(db, ref, tx => markSlotFailed(tx, artifactAssessmentSlot, work.slotKey, { status: 'blocked', reason: assessmentInputsBlocked }));
  }
}
