import { createHash } from 'node:crypto';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, learnerId, type Revision } from '../../kernel/src/declarations/ids.ts';
import { sealCandidate, submitCandidate, type CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { failWork, readWork, type WorkRef } from '../../kernel/src/work/index.ts';
import type { AssessmentPublicationTarget } from '../../modules/activity/assessment-publication.ts';
import {
  assessmentRelease, assessmentSubmission, formalAssessmentValue, type AssessmentRelease, type AssessmentRevisionRef,
  type AssessmentSubmission,
} from '../../modules/activity/assessment-values.ts';
import { artifactActionRecord } from '../../modules/activity/artifact-action.ts';
import {
  evaluateSentenceBreaks, qualifySentenceBreakAssessment, sentenceBreakRelease, type SentenceBreakPublicationEvidence,
} from '../../modules/activity/sentence-break-assessment.ts';
import slot from '../../modules/activity/slots/artifact-formal-assessment.ts';
import { artifactMount } from '../../modules/content/artifact.ts';
import { sentenceBreakQuestion, type Artifact } from '../../surfaces/shared/presentation/index.ts';
import {
  assessmentExecutionFailed, assessmentInputsBlocked, readFormalAssessment, type AssessmentScope,
} from './formal-assessment.ts';
import { purpose, stableId } from './identity.ts';

export const artifactAssessmentSlot = slot.type;
export const artifactAssessmentPolicy: CandidatePolicy = { slot, purpose, deriver: 'activity/artifact-formal-assessment-v1' };
const propagation = createPropagationHooks([]);
type FrozenInputs = { release: AssessmentRelease; submission: AssessmentSubmission };

/** Deployment-owned source. It attests an exact frozen question and provides expected results.
 * The host runs the evaluator locally and constructs the execution evidence.
 */
export type ReadArtifactAssessmentWitness = (
  target: AssessmentPublicationTarget, view: Artifact, predictionPrompt: string,
) => SentenceBreakPublicationEvidence | null | undefined;

export function artifactAssessmentDigest(view: Artifact, predictionPrompt: string) {
  return createHash('sha256').update(canonicalJsonString({ view, predictionPrompt })).digest('hex');
}

export function qualifyArtifactAssessment(
  releaseRef: AssessmentRevisionRef, view: Artifact, predictionPrompt: string, alternatives: unknown,
  readWitness?: ReadArtifactAssessmentWitness,
) {
  const { itemId, slotId, breakpointIds } = sentenceBreakQuestion(view);
  const release = sentenceBreakRelease(releaseRef, itemId, slotId, breakpointIds,
    artifactAssessmentDigest(view, predictionPrompt), alternatives);
  return qualifySentenceBreakAssessment(release, target => readWitness?.(target, view, predictionPrompt), (witness, sample) => ({
    id: factId(stableId('sentence-break-verification', releaseRef.id, String(releaseRef.rev), witness.id,
      String(witness.rev), sample.id, String(sample.rev))),
    rev: 1 as Revision,
  }));
}

class ArtifactAssessmentInputUnavailable extends Error {}

export function readArtifactAssessment(
  tx: ReadTransaction, releaseRef: AssessmentRevisionRef, submissionRef: AssessmentRevisionRef,
) {
  return readFormalAssessment(tx, artifactAssessmentSlot, releaseRef, submissionRef, purpose);
}

export async function executeArtifactAssessment(db: Db, ref: WorkRef, terminalFailure: boolean) {
  const learner = learnerId(ref.learner);
  const work = await readWork(db, ref);
  if (work?.slotType !== artifactAssessmentSlot || work.deriver !== artifactAssessmentPolicy.deriver) return;
  const { rows: [row] } = await db.query<{ scope_keys: AssessmentScope }>(
    'SELECT scope_keys FROM slot_state WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
    [learner, artifactAssessmentSlot, work.slotKey],
  );
  if (!row) throw new Error('Artifact assessment is missing its frozen scope');
  const { releaseRef, submissionRef, releaseEpoch, submissionEpoch } = row.scope_keys;
  try {
    const snapshot = await gatherSnapshot(db, { learner, purpose }, async ({ read }) => {
      const mount = await read.fact(releaseRef.id, { mode: 'pinned', rev: releaseRef.rev });
      const action = await read.fact(submissionRef.id, { mode: 'pinned', rev: submissionRef.rev });
      if (mount.type !== 'content.mountedArtifact' || action.type !== 'activity.artifactAction' ||
          mount.accessEpoch !== releaseEpoch || action.accessEpoch !== submissionEpoch)
        throw new ArtifactAssessmentInputUnavailable();
      const { assessment } = artifactMount(mount.value);
      const record = artifactActionRecord(action.value);
      if (!assessment || record.mountId !== mount.ref.id) throw new ArtifactAssessmentInputUnavailable();
      const release = assessmentRelease(assessment.release);
      const submission = assessmentSubmission(record.submission, release);
      if (release.releaseRef.id !== releaseRef.id || release.releaseRef.rev !== releaseRef.rev ||
          submission.submissionRef.id !== submissionRef.id || submission.submissionRef.rev !== submissionRef.rev)
        throw new ArtifactAssessmentInputUnavailable();
      return { kind: 'input', data: { release, submission }, effects: [] };
    });
    const sealed = await sealCandidate(db, ref, artifactAssessmentPolicy, snapshot);
    if (sealed.kind !== 'sealed') return;
    if (terminalFailure) {
      await submitCandidate(db, ref, artifactAssessmentPolicy, sealed.id,
        { kind: 'failed', reason: assessmentExecutionFailed }, propagation);
      return;
    }
    const { release, submission } = sealed.plan.data as FrozenInputs;
    const result = evaluateSentenceBreaks(release, submission);
    const value = formalAssessmentValue(release, submission, result, []);
    await submitCandidate(db, ref, artifactAssessmentPolicy, sealed.id, { kind: 'value', value }, propagation);
  } catch (error) {
    if (!(error instanceof FactReadDeniedError || error instanceof FactNotFoundError ||
        error instanceof ArtifactAssessmentInputUnavailable)) throw error;
    await failWork(db, ref, async tx => {
      await tx.query('UPDATE slot_state SET last_error=$4 WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
        [learner, artifactAssessmentSlot, work.slotKey, JSON.stringify({ status: 'blocked', reason: assessmentInputsBlocked })]);
    });
  }
}
