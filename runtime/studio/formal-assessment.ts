import type { DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import type { CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { requestWork } from '../../kernel/src/work/index.ts';
import {
  readAssessmentScore, type AssessmentCriterion, type AssessmentResult, type AssessmentRevisionRef,
} from '../../modules/activity/assessment-values.ts';
import { stableId } from './identity.ts';

export const assessmentExecutionFailed = '自动评估执行失败。';
export const assessmentInputsBlocked = '冻结依据已变化或不可读取。';

export type AssessmentScope = {
  releaseRef: AssessmentRevisionRef;
  submissionRef: AssessmentRevisionRef;
  releaseEpoch: string;
  submissionEpoch: string;
};

function slotKey(type: string, release: AssessmentRevisionRef, submission: AssessmentRevisionRef) {
  return stableId(type, release.id, String(release.rev), submission.id, String(submission.rev));
}

export async function registerFormalAssessment(
  tx: DbTransaction, tick: Tick, policy: CandidatePolicy, release: FactSnapshot, submission: FactSnapshot,
) {
  const scope: AssessmentScope = {
    releaseRef: { id: release.ref.id, rev: release.ref.rev },
    submissionRef: { id: submission.ref.id, rev: submission.ref.rev },
    releaseEpoch: release.accessEpoch, submissionEpoch: submission.accessEpoch,
  };
  const type = policy.slot.type;
  const key = slotKey(type, scope.releaseRef, scope.submissionRef);
  const inserted = await tx.query(
    `INSERT INTO slot_state (learner_id, slot_type, slot_key, scope_keys, changed_tick)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [tx.learner, type, key, JSON.stringify(scope), tick],
  );
  if (inserted.rowCount) await requestWork(tx, tick, { slotType: type, slotKey: key, deriver: policy.deriver });
}

type FormalAssessmentValue = {
  result: AssessmentResult;
  score: ReturnType<typeof readAssessmentScore>;
  criteria: (Pick<AssessmentCriterion, 'criterionId' | 'evaluator' | 'source' | 'maximum'> & { itemId: string })[];
  receipts: { itemId: string; criterionId: string; effectId: string; routeId: string; reportedModel?: string; quote?: string }[];
};

export async function readFormalAssessment(
  tx: ReadTransaction, type: string, releaseRef: AssessmentRevisionRef, submissionRef: AssessmentRevisionRef, purpose: string,
) {
  const { rows: [slot] } = await tx.query<{
    current_id: string | null; last_error: { status: string; reason: string } | null;
    value: { kind: 'value'; value: FormalAssessmentValue } | null; manifest: unknown;
  }>(
    `SELECT s.current_id, s.last_error, d.value, d.manifest FROM slot_state s
     LEFT JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id
       AND d.lifecycle='effective' AND d.invalidated_tick IS NULL
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3`,
    [tx.learner, type, slotKey(type, releaseRef, submissionRef)],
  );
  const refs = { releaseRef, submissionRef };
  if (slot?.value?.kind === 'value' && slot.current_id) {
    const manifest = parseManifest(slot.manifest);
    if ((await revalidateManifest(tx, manifest)).kind !== 'valid' ||
        (purpose !== manifest.purpose && (await revalidateManifest(tx, manifest, purpose)).kind !== 'valid'))
      return { ...refs, state: 'blocked' as const, reason: assessmentInputsBlocked, score: null };
    const { outcomes } = slot.value.value.result;
    const state = outcomes.some(({ state }) => state === 'failed') ? 'failed'
      : outcomes.some(({ state }) => state === 'blocked') ? 'blocked'
      : outcomes.every(({ state }) => state === 'scored' || state === 'qualitative') ? 'complete' : 'incomplete';
    return { ...refs, ...slot.value.value, state, derivationId: slot.current_id };
  }
  if (slot?.last_error) return {
    ...refs, state: slot.last_error.reason === assessmentExecutionFailed ? 'failed' as const : 'blocked' as const,
    reason: slot.last_error.reason, score: null,
  };
  return slot
    ? { ...refs, state: 'queued' as const, score: null }
    : { ...refs, state: 'blocked' as const, reason: '缺少自动评估工作记录。', score: null };
}
