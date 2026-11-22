import { createCommandReadContext, createPropagationHooks, derivationId, FactNotFoundError, FactReadDeniedError, isJson, parseManifest, revalidateManifest, stableId, storeSettledValue, type CanonicalEvidenceSliceV1, type DbTransaction, type FactChange, type FactId, type FactRef, type FactSnapshot, type DerivationId, type Manifest, type ManifestInput, type ReadContext, type ReadTransaction, type Revision, type Tick } from '@mangekyo/kernel';
import { readActivityHelpEvents as readHelpEvents } from './evidence-read.ts';
import {
  gatherAuthorizedExamTimeValueBundle, revalidateAuthorizedExamTimeValueBundle,
  type AuthorizedExamTimeValueBundle, type ExamTimeValueEstimate, type ExamTimeValueFormalInput, type ExamTimeValueRef,
} from './exam-time-value.ts';
export type { AuthorizedExamTimeValueBundle } from './exam-time-value.ts';
import { storagePurpose } from './library-values.ts';
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
} from './workbook-values.ts';
const teachingPurpose = 'teaching';
type AssessmentRow = { id: string; slot_key: string; value: unknown; manifest: unknown };
type ArchivedAssessment = AssessmentRow & { original_id: string | null };
const rubricPropagation = createPropagationHooks([]);
export { readActivitySubmissionBirth } from './evidence-read.ts';
export function readActivityHelpEvents(
  tx: ReadTransaction, read: ReadContext, query: Parameters<typeof readHelpEvents>[2],
  admit?: Parameters<typeof readHelpEvents>[3],
) {
  return readHelpEvents(tx, read, query, admit,
    error => error instanceof FactReadDeniedError || error instanceof FactNotFoundError);
}
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
    if (!basis?.teaching || !isJson(row.value)) continue;
    const manifest = parseManifest({ version: 1, learner: tx.learner, purpose: storagePurpose, gatherTick: tick, inputs: basis.inputs });
    if ((await revalidateManifest(tx, manifest, teachingPurpose)).kind !== 'valid') continue;
    const { assessment } = basis;
    const id = derivationId(stableId('rubric-purpose-carry', row.id, tick));
    const scope = { paperId: assessment.paperId, attemptId: assessment.attemptId, originalAssessmentId: row.original_id ?? row.id };
    await storeSettledValue(tx, tick, {
      kind: 'carry', id, slotType: workbookRubricAssessmentType, key: row.slot_key,
      deriver: workbookRubricAssessmentVersion, scope, value: row.value, manifest,
    }, rubricPropagation);
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

export type TeachingAttemptAssessment = Pick<WorkbookRubricAssessment, 'rubricVersion' | 'score' | 'errorStage' | 'feedback' | 'evidence'> & {
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
      ...(assessment.score ? { score: assessment.score } : {}), ...(assessment.errorStage ? { errorStage: assessment.errorStage } : {}),
      feedback: assessment.feedback,
      evidence: assessment.evidence,
      ref: { kind: 'slot', slotType: workbookRubricAssessmentType, slotKey: row.slot_key, derivationId: id, mode: 'following' },
    });
  }
  return result;
}

export type WorkbookExamTimeValueAccess = {
  readonly purpose?: string;
  readonly maySend?: (fact: FactSnapshot) => boolean;
  readonly asOfAt?: string;
  readonly estimates?: readonly ExamTimeValueEstimate[];
  readonly errorStages?: Readonly<Record<string, NonNullable<CanonicalEvidenceSliceV1['events'][number]['error_stage']>>>;
};

type WorkbookExamTimeValueFormalReader = Parameters<typeof gatherAuthorizedExamTimeValueBundle>[0]['readFormal'];

const denialReason = (error: unknown) =>
  error instanceof Error && 'reason' in error ? (error as { readonly reason?: unknown }).reason : undefined;
const isReadDenied = (error: unknown) => ['purpose', 'retracted', 'recipient', 'changed'].includes(String(denialReason(error)));
const isPurposeDenied = (error: unknown) => denialReason(error) === 'purpose';
const onlyGrantsChanged = async (tx: ReadTransaction, id: FactId, before: Revision, after: Revision) => {
  const { rows: [proof] } = await tx.query<{ unchanged: boolean }>(
    `SELECT count(*) FILTER (WHERE r.kind='value' AND r.data=base.data AND r.corrects_rev=p.rev
        AND r.purpose IS DISTINCT FROM p.purpose)=($4::int-$3::int) AS unchanged
     FROM fact_revs base JOIN fact_revs r ON (r.learner_id,r.fact_id)=(base.learner_id,base.fact_id)
     JOIN fact_revs p ON (p.learner_id,p.fact_id,p.rev)=(r.learner_id,r.fact_id,r.rev-1)
     WHERE base.learner_id=$1 AND base.fact_id=$2 AND base.rev=$3 AND base.kind='value' AND r.rev>$3 AND r.rev<=$4`,
    [tx.learner, id, before, after],
  );
  return proof?.unchanged === true;
};
const authorizedFactReader = (tx: ReadTransaction, purpose: string, maySend: (fact: FactSnapshot) => boolean) => {
  const read = createCommandReadContext(tx, purpose);
  return {
    fact: async (id: FactId, options: Parameters<ReadContext['fact']>[1]) => {
      const fact = await read.fact(id, options);
      if (!maySend(fact)) throw new FactReadDeniedError('recipient', `Fact ${id} may not be sent to this recipient`);
      return fact;
    },
  };
};

export async function openWorkbookExamTimeValueBundle(
  tx: ReadTransaction,
  paperId: FactId,
  attemptId: FactId,
  readFormal: WorkbookExamTimeValueFormalReader,
  access: WorkbookExamTimeValueAccess = {},
): Promise<AuthorizedExamTimeValueBundle | undefined> {
  const purpose = access.purpose ?? storagePurpose;
  const maySend = access.maySend ?? (() => true);
  return gatherAuthorizedExamTimeValueBundle({
    tx, paperId, attemptId, purpose, readFormal,
    read: authorizedFactReader(tx, purpose, maySend),
    asOfAt: access.asOfAt ?? new Date().toISOString(),
    ...(access.estimates ? { estimates: access.estimates } : {}),
    ...(access.errorStages ? { errorStages: access.errorStages } : {}),
    isUnavailable: isReadDenied, isPurposeDenied,
    onlyGrantsChanged: (id, before, after) => onlyGrantsChanged(tx, id, before, after),
  });
}

export async function verifyWorkbookExamTimeValueBundle(
  tx: ReadTransaction,
  bundle: AuthorizedExamTimeValueBundle,
  readFormal: WorkbookExamTimeValueFormalReader,
  maySend: (fact: FactSnapshot) => boolean = () => true,
): Promise<boolean> {
  return revalidateAuthorizedExamTimeValueBundle({
    bundle, readFormal,
    read: authorizedFactReader(tx, bundle.purpose, maySend),
    isUnavailable: isReadDenied, isPurposeDenied,
    onlyGrantsChanged: (id, before, after) => onlyGrantsChanged(tx, id, before, after),
  });
}
