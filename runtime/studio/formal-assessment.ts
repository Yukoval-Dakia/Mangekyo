import type { CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { parseManifest, revalidateManifest, type DbTransaction, type FactSnapshot, type ReadTransaction, type Tick } from '../../kernel/src/index.ts';
import { requestCatalogedWork } from '../../kernel/src/work/index.ts';
import { settledAssessmentState, type AssessmentRevisionRef, type FormalAssessmentValue } from '../../modules/activity/assessment-values.ts';
import { manifestEpochsMatch, projectFormalAssessmentFallback } from '../../modules/learner/diagnosis-slice.ts';
import { stableId } from './identity.ts';

export const assessmentExecutionFailed = '自动评估执行失败。', assessmentInputsBlocked = '冻结依据已变化或不可读取。';
export type AssessmentScope = { releaseRef: AssessmentRevisionRef; submissionRef: AssessmentRevisionRef; releaseEpoch: string; submissionEpoch: string };
export function formalAssessmentSlotKey(type: string, release: AssessmentRevisionRef, submission: AssessmentRevisionRef) {
  return stableId(type, release.id, String(release.rev), submission.id, String(submission.rev));
}
export async function registerFormalAssessment(tx: DbTransaction, tick: Tick, policy: CandidatePolicy, release: FactSnapshot, submission: FactSnapshot) {
  const scope: AssessmentScope = { releaseRef: { id: release.ref.id, rev: release.ref.rev }, submissionRef: { id: submission.ref.id, rev: submission.ref.rev }, releaseEpoch: release.accessEpoch, submissionEpoch: submission.accessEpoch };
  await requestCatalogedWork(tx, tick, { slotType: policy.slot.type, slotKey: formalAssessmentSlotKey(policy.slot.type, scope.releaseRef, scope.submissionRef), deriver: policy.deriver }, JSON.stringify(scope));
}
export async function readFormalAssessment(
  tx: ReadTransaction, type: string, releaseRef: AssessmentRevisionRef, submissionRef: AssessmentRevisionRef, purpose: string,
  expectedEpochs?: { readonly releaseEpoch?: string; readonly submissionEpoch?: string },
) {
  const { rows: [slot] } = await tx.query<{ current_id: string | null; last_error: { status: string; reason: string } | null; value: { kind: 'value'; value: FormalAssessmentValue } | null; manifest: unknown }>(
    `SELECT s.current_id, s.last_error, d.value, d.manifest FROM slot_state s
     LEFT JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id AND d.lifecycle='effective' AND d.invalidated_tick IS NULL
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3`,
    [tx.learner, type, formalAssessmentSlotKey(type, releaseRef, submissionRef)],
  );
  const refs = { releaseRef, submissionRef };
  if (slot?.value?.kind === 'value' && slot.current_id) { const manifest = parseManifest(slot.manifest);
    if ((await revalidateManifest(tx, manifest)).kind !== 'valid' ||
        (purpose !== manifest.purpose && (await revalidateManifest(tx, manifest, purpose)).kind !== 'valid') ||
        !manifestEpochsMatch(manifest, releaseRef.id, submissionRef.id, expectedEpochs))
      return { ...refs, state: 'blocked' as const, reason: assessmentInputsBlocked, score: null };
    return { ...refs, ...slot.value.value, state: settledAssessmentState(slot.value.value), derivationId: slot.current_id };
  }
  return projectFormalAssessmentFallback(slot, refs, assessmentExecutionFailed);
}
