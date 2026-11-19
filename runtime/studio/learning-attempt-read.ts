import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { derivationId, type DerivationId } from '../../kernel/src/declarations/ids.ts';
import type { FactRef, FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { parseManifest, type Manifest, type ManifestInput } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import {
  workbookAttempt,
  workbookAttemptType,
  workbookRubricAssessment,
  workbookRubricAssessmentType,
  type WorkbookAttempt,
  type WorkbookRubricAssessment,
  type WorkbookRubricAssessmentView,
} from '../../modules/activity/workbook-values.ts';
import { purpose as teachingPurpose } from './identity.ts';

type AssessmentRow = { id: string; slot_key: string; value: unknown; manifest: unknown };

const currentAssessmentsSql = `SELECT d.id, d.slot_key, d.value, d.manifest
       FROM derivations d JOIN slot_state s
         ON s.learner_id=d.learner_id AND s.slot_type=d.slot_type AND s.current_id=d.id
       WHERE d.learner_id=$1 AND d.slot_type=$2`;

export async function allAssessments(tx: ReadTransaction, paperId?: string, key?: string) {
  const { rows } = await tx.query<AssessmentRow>(
    `${currentAssessmentsSql} AND ($3::text IS NULL OR d.scope_keys->>'paperId'=$3)
       AND ($4::text IS NULL OR s.slot_key=$4)`,
    [tx.learner, workbookRubricAssessmentType, paperId ?? null, key ?? null]);
  const result = new Map<string, WorkbookRubricAssessmentView[]>();
  for (const row of rows) {
    if ((await revalidateManifest(tx, parseManifest(row.manifest))).kind !== 'valid') continue;
    const assessment = workbookRubricAssessment(row.value);
    const current = result.get(assessment.attemptId) ?? [];
    current.push({id: row.id, ...assessment});
    result.set(assessment.attemptId, current);
  }
  return result;
}

export type TeachingAttemptAssessmentAuthorization = {
  readonly purpose: typeof teachingPurpose;
  readonly recipientEligible: boolean;
};

export type TeachingAttemptAssessment = Pick<WorkbookRubricAssessment, 'rubricVersion' | 'score' | 'feedback' | 'evidence'> & {
  /** The frozen question is identified by the attempt revision and its local question ID. */
  attempt: FactRef;
  questionId: string;
  verdict: Exclude<WorkbookRubricAssessment['verdict'], 'pending'>;
  ref: Extract<ManifestInput, { kind: 'slot' }>;
};

/** The host opens the attempt for this purpose in tx and determines this recipient's eligibility. */
export async function readTeachingAttemptAssessments(
  tx: ReadTransaction,
  attemptSnapshot: FactSnapshot<unknown>,
  authorization: TeachingAttemptAssessmentAuthorization,
): Promise<TeachingAttemptAssessment[]> {
  if (authorization?.purpose !== teachingPurpose || authorization.recipientEligible !== true
      || attemptSnapshot.type !== workbookAttemptType || attemptSnapshot.ref.learner !== tx.learner) return [];

  let attempt: WorkbookAttempt;
  try {
    attempt = workbookAttempt(attemptSnapshot.value);
  } catch {
    return [];
  }
  const { ref, accessEpoch } = attemptSnapshot;
  const { rows } = await tx.query<AssessmentRow>(
    `${currentAssessmentsSql} AND d.scope_keys->>'attemptId'=$3 AND d.scope_keys->>'paperId'=$4
       AND s.slot_key=d.slot_key AND d.lifecycle='effective' AND NOT d.is_shadow
       AND d.invalidated_tick IS NULL AND d.selection_ended_tick IS NULL
       AND d.effective_tick >= d.gather_tick
     ORDER BY d.slot_key`,
    [tx.learner, workbookRubricAssessmentType, ref.id, attempt.paperId]);
  const result: TeachingAttemptAssessment[] = [];
  for (const row of rows) {
    let manifest: Manifest;
    let assessment: WorkbookRubricAssessment;
    let id: DerivationId;
    try {
      manifest = parseManifest(row.manifest);
      assessment = workbookRubricAssessment(row.value);
      id = derivationId(row.id);
    } catch {
      continue;
    }
    if (assessment.attemptId !== ref.id || assessment.paperId !== attempt.paperId
        || assessment.verdict === 'pending') continue;
    const question = attempt.paper.questions.find(({ id }) => id === assessment.questionId);
    if (question?.kind !== 'rubric' || question.rubricVersion !== assessment.rubricVersion
        || question.rubric !== assessment.rubric) continue;
    const answer = attempt.answers[question.id];
    if (typeof answer !== 'string' || !assessment.evidence.length
        || !assessment.evidence.every(quote => answer.includes(quote))) continue;
    const attemptInputs = manifest.inputs.filter(input => input.kind === 'fact' && input.id === ref.id);
    const [input] = attemptInputs;
    if (attemptInputs.length !== 1 || input?.kind !== 'fact' || input.rev !== ref.rev || input.accessEpoch !== accessEpoch
        || !manifest.inputs.some(input => input.kind === 'fact' && input.id === attempt.paperId)) continue;
    if ((await revalidateManifest(tx, manifest, authorization.purpose)).kind !== 'valid') continue;

    result.push({
      attempt: { learner: ref.learner, id: ref.id, rev: ref.rev },
      questionId: question.id,
      rubricVersion: question.rubricVersion,
      verdict: assessment.verdict,
      ...(assessment.score ? { score: assessment.score } : {}),
      feedback: assessment.feedback,
      evidence: assessment.evidence,
      ref: { kind: 'slot', slotType: workbookRubricAssessmentType, slotKey: row.slot_key, derivationId: id, mode: 'following' },
    });
  }
  return result;
}
