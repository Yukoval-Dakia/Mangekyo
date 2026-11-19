import type { FactChange } from '../../kernel/src/commands/contracts.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { derivationId, type DerivationId, type Revision, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactRef, FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { parseManifest, type Manifest, type ManifestInput } from '../../kernel/src/derivations/manifest.ts';
import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import {
  sameWorkbookJson,
  workbookAttempt,
  workbookAttemptType,
  workbookPaperType,
  workbookRubricAssessment,
  workbookRubricAssessmentType,
  workbookRubricAssessmentVersion,
  type WorkbookAttempt,
  type WorkbookRubricAssessment,
  type WorkbookRubricAssessmentView,
} from '../../modules/activity/workbook-values.ts';
import { purpose as teachingPurpose, stableId } from './identity.ts';

type AssessmentRow = { id: string; slot_key: string; value: unknown; manifest: unknown };
type ArchivedAssessment = AssessmentRow & { original_id: string | null };
const rubricPropagation = createPropagationHooks([]);

const currentAssessmentsSql = `SELECT d.id, d.slot_key, d.value, d.manifest, d.scope_keys->>'originalAssessmentId' AS original_id
       FROM derivations d JOIN slot_state s
         ON s.learner_id=d.learner_id AND s.slot_type=d.slot_type AND s.current_id=d.id
       WHERE d.learner_id=$1 AND d.slot_type=$2`;

const archivedAssessmentsSql = `SELECT d.id, d.slot_key, d.value, d.manifest, d.scope_keys->>'originalAssessmentId' AS original_id
       FROM slot_state s JOIN derivations d
         ON (d.learner_id,d.slot_type,d.slot_key,d.id)=(s.learner_id,s.slot_type,s.slot_key,s.last_id)
       WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.current_id IS NULL
         AND d.lifecycle='stale' AND NOT d.is_shadow AND d.effective_tick >= d.gather_tick
         AND d.selection_ended_tick IS NULL AND d.invalidated_tick IS NOT NULL`;

/** Read both historical and current inputs under storage, and prove every intervening revision preserved the data. */
async function unchangedAssessmentBasis(tx: ReadTransaction, row: ArchivedAssessment) {
  const prior = parseManifest(row.manifest);
  const assessment = workbookRubricAssessment(row.value);
  if (prior.learner !== tx.learner || prior.purpose !== storagePurpose || prior.inputs.length !== 2 ||
      assessment.assessmentVersion !== workbookRubricAssessmentVersion || assessment.verdict === 'pending') return;

  const read = createCommandReadContext(tx, storagePurpose);
  const inputs: Extract<ManifestInput, { kind: 'fact' }>[] = [];
  const seen = new Set<string>();
  let teaching = true;
  let purposeChanged = false;
  for (const input of prior.inputs) {
    if (input.kind !== 'fact' || input.mode !== 'following' || seen.has(input.id)) return;
    seen.add(input.id);
    const expectedType = input.id === assessment.attemptId ? workbookAttemptType
      : input.id === assessment.paperId ? workbookPaperType : undefined;
    if (!expectedType) return;
    try {
      const current = await read.fact(input.id, { mode: 'following' });
      const historical = await read.fact(input.id, { mode: 'pinned', rev: input.rev as Revision });
      const revisions = current.ref.rev - input.rev;
      // Data equality alone cannot distinguish an edit followed by a revert.
      if (current.type !== expectedType || revisions < 0 ||
          BigInt(current.accessEpoch) - BigInt(input.accessEpoch) !== BigInt(revisions) ||
          !sameWorkbookJson(historical.value, current.value)) return;
      if (revisions > 0) {
        const { rows: [proof] } = await tx.query<{ unchanged: boolean }>(
          `SELECT count(*) FILTER (WHERE kind='value' AND data=$5::jsonb AND corrects_rev=rev-1
             AND purpose && ARRAY['storage','all']::text[])=($4::int-$3::int) AS unchanged
           FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev>$3 AND rev<=$4`,
          [tx.learner, input.id, input.rev, current.ref.rev, JSON.stringify(historical.value)],
        );
        if (!proof?.unchanged) return;
        purposeChanged = true;
      }
      if (expectedType === workbookAttemptType) {
        const attempt = workbookAttempt(current.value);
        const question = attempt.paper.questions.find(({ id }) => id === assessment.questionId);
        const answer = attempt.answers[assessment.questionId];
        if (attempt.paperId !== assessment.paperId || question?.kind !== 'rubric' ||
            question.rubricVersion !== assessment.rubricVersion || question.rubric !== assessment.rubric ||
            typeof answer !== 'string' || !assessment.evidence.length ||
            !assessment.evidence.every(quote => answer.includes(quote))) return;
      }
      teaching &&= current.purpose.includes(teachingPurpose) || current.purpose.includes('all');
      inputs.push({ ...input, rev: current.ref.rev, accessEpoch: current.accessEpoch });
    } catch (error) {
      if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return;
      throw error;
    }
  }
  return purposeChanged ? { assessment, inputs, teaching } : undefined;
}

/** Called after propagation invalidates the old selection, within the teaching grant transaction. */
export async function carryRubricAssessments(
  tx: DbTransaction,
  tick: Tick,
  changes: readonly FactChange[],
) {
  const ids = changes.filter(change => change.kind === 'set_purpose' &&
    (change.factType === workbookAttemptType || change.factType === workbookPaperType)).map(change => change.ref.id);
  if (!ids.length) return;
  const { rows } = await tx.query<ArchivedAssessment>(
    `${archivedAssessmentsSql} AND (d.scope_keys->>'paperId'=ANY($3::text[]) OR d.scope_keys->>'attemptId'=ANY($3::text[]))`,
    [tx.learner, workbookRubricAssessmentType, ids],
  );
  for (const row of rows) {
    const basis = await unchangedAssessmentBasis(tx, row);
    if (!basis?.teaching) continue;
    const manifest = parseManifest({ version: 1, learner: tx.learner, purpose: storagePurpose, gatherTick: tick, inputs: basis.inputs });
    if ((await revalidateManifest(tx, manifest, teachingPurpose)).kind !== 'valid') continue;
    const { assessment } = basis;
    const id = derivationId(stableId('rubric-purpose-carry', row.id, tick));
    const scope = { paperId: assessment.paperId, attemptId: assessment.attemptId, originalAssessmentId: row.original_id ?? row.id };
    await tx.insert('derivations', {
      learner_id: tx.learner, id, slot_type: workbookRubricAssessmentType, slot_key: row.slot_key,
      deriver: workbookRubricAssessmentVersion, scope_keys: JSON.stringify(scope), value: JSON.stringify(row.value),
      lifecycle: 'effective', freshness: 'current', is_shadow: false,
      gather_tick: tick, effective_tick: tick, manifest: JSON.stringify(manifest),
    });
    await tx.query(
      `UPDATE slot_state SET current_id=$4,last_id=$4,changed_tick=$5,last_error=NULL
       WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3`,
      [tx.learner, workbookRubricAssessmentType, row.slot_key, id, tick],
    );
    await rubricPropagation.onSlotChanged(tx, tick, {
      kind: 'effective', slot: { learner: tx.learner, type: workbookRubricAssessmentType, key: row.slot_key },
      id, previousCurrent: null, freshness: 'current',
    });
  }
}

export async function allAssessments(tx: ReadTransaction, paperId?: string, key?: string) {
  const { rows } = await tx.query<ArchivedAssessment>(
    `${currentAssessmentsSql} AND ($3::text IS NULL OR d.scope_keys->>'paperId'=$3)
       AND ($4::text IS NULL OR s.slot_key=$4)`,
    [tx.learner, workbookRubricAssessmentType, paperId ?? null, key ?? null]);
  const result = new Map<string, WorkbookRubricAssessmentView[]>();
  const append = (id: string, assessment: WorkbookRubricAssessment) => {
    const current = result.get(assessment.attemptId) ?? [];
    current.push({ id, ...assessment });
    result.set(assessment.attemptId, current);
  };
  for (const row of rows) {
    if ((await revalidateManifest(tx, parseManifest(row.manifest))).kind !== 'valid') continue;
    append(row.original_id ?? row.id, workbookRubricAssessment(row.value));
  }
  const archived = await tx.query<ArchivedAssessment>(
    `${archivedAssessmentsSql} AND ($3::text IS NULL OR d.scope_keys->>'paperId'=$3)
       AND ($4::text IS NULL OR s.slot_key=$4)`,
    [tx.learner, workbookRubricAssessmentType, paperId ?? null, key ?? null]);
  for (const row of archived.rows) {
    const basis = await unchangedAssessmentBasis(tx, row);
    if (basis) append(row.original_id ?? row.id, basis.assessment);
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
