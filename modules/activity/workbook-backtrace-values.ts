import { factId, type BusWitness, type FactRef, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import { posttestIssuanceType, posttestSubmissionType, type posttestIssuance, type RetentionWindow } from './retention-posttest.ts';

import { reopenControlledHelpBasis } from './help-exposure-values.ts';
import { readActivitySubmissionBirth, type ActivityEvidenceReadScope } from './evidence-read.ts';
import { sameWorkbookJson, workbookAttempt, workbookAttemptType, type WorkbookPaper } from './workbook-values.ts';

type Attempt = {
  submission: FactRef; item: { paper: FactRef; itemId: string }; occurredAt: string; admittedAt: Tick;
};
type FollowupInput = {
  window: RetentionWindow;
  target: { condition: string; paper: Pick<FactRef, 'id' | 'rev'>; itemId: string };
  observedThrough: Tick;
  observations: readonly {
    submission: Pick<FactRef, 'id' | 'rev'>; exposure: { kind: string }; result: string;
  }[];
};

/** The second sitting has to be a prospective follow-up of the first correct attempt. */
export function isFrozenWorkbookFollowup(input: FollowupInput, release: ReturnType<typeof posttestIssuance>,
  earlier: Attempt, later: Attempt,
) {
  const { scheduledAt, through, requestedAt } = input.window;
  return Boolean(scheduledAt && scheduledAt > requestedAt && scheduledAt > earlier.occurredAt &&
    scheduledAt <= release.startedAt && through === release.through &&
    BigInt(earlier.admittedAt) <= BigInt(input.observedThrough) && BigInt(later.admittedAt) > BigInt(release.effectiveTick) &&
    input.target.condition === 'same-item' && input.target.paper.id === later.item.paper.id &&
    input.target.paper.rev === later.item.paper.rev && input.target.itemId === later.item.itemId &&
    input.observations.some(o => o.submission.id === earlier.submission.id && o.submission.rev === earlier.submission.rev &&
      o.exposure.kind === 'independent' && o.result === 'correct'));
}

type Ref = {id: string; rev: number};
type Reader = Pick<ReadContext,'fact'>;
export class WorkbookTraceReadError extends Error {}

export function workbookWitnessReader(read: Reader, tx: ActivityEvidenceReadScope, basis: readonly BusWitness[] = []) {
  const witnesses = new Map(basis.map(w => [JSON.stringify(w), w]));
  const traced: ReadContext = {
    async fact<Value>(id: Parameters<Reader['fact']>[0], options: Parameters<Reader['fact']>[1]) {
      const fact = await read.fact<Value>(id, options);
      if (fact.ref.learner !== tx.learner) throw new WorkbookTraceReadError();
      const witness = { ...fact.ref, type: fact.type, accessEpoch: fact.accessEpoch, mode: options.mode };
      witnesses.set(JSON.stringify(witness), witness);
      return fact;
    },
    async slot() { throw new WorkbookTraceReadError(); },
    async range() { throw new WorkbookTraceReadError(); },
  };
  return { read: traced, witnesses: () => [...witnesses.values()] };
}

export async function confirmWorkbookTraceBasis(read: Reader, tx: ActivityEvidenceReadScope,
  root: readonly BusWitness[], candidate: readonly BusWitness[]) {
  const witnesses = workbookWitnessReader(read,tx,[...root,...candidate]).witnesses();
  return await reopenControlledHelpBasis(read,tx.learner,witnesses.filter(witness=>witness.type==='capture.source'))
    ? witnesses : null;
}

type TraceRoot = { target: {paper: Ref}; paper: WorkbookPaper };
export async function workbookTraceCutoff(tx: ActivityEvidenceReadScope, root: TraceRoot, ref: Ref | undefined, read: Reader) {
  if (!ref) {
    const { rows: [row] } = await tx.query<{ tick: Tick }>(
      `SELECT born.tick::text FROM fact_revs born JOIN fact_revs frozen
         ON (frozen.learner_id,frozen.fact_id,frozen.rev)=(born.learner_id,born.fact_id,$3)
       WHERE born.learner_id=$1 AND born.fact_id=$2 AND born.rev=1 AND born.kind='value' AND born.data=frozen.data`,
      [tx.learner, root.target.paper.id, root.target.paper.rev],
    );
    return row && { observedThrough: row.tick, asOfAt: root.paper.savedAt };
  }
  const fact = await read.fact(factId(ref.id), { mode: 'pinned', rev: ref.rev as Revision });
  if (fact.type !== workbookAttemptType) return;
  const attempt = workbookAttempt(fact.value);
  const birth = await readActivitySubmissionBirth(tx, fact.ref, fact.type);
  if (attempt.paperId !== root.target.paper.id || !sameWorkbookJson(attempt.paper, root.paper) ||
      !birth?.unchanged || birth.submittedAt !== attempt.submittedAt) return;
  return { observedThrough: birth.tick, asOfAt: attempt.submittedAt, submissionId: fact.ref.id };
}


export async function earlierWorkbookTraceAttempts(tx: ActivityEvidenceReadScope, oldQuestion: Ref, through: Tick) {
  const { rows } = await tx.query<{ paper: string; item: string; attempts: string[] }>(
    `SELECT i.data#>>'{paper,id}' AS paper,i.data->>'itemId' AS item,
        (array_agg(r.fact_id ORDER BY r.tick DESC,r.fact_id))[1:2] AS attempts
       FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,1)
       JOIN fact_revs i ON (i.learner_id,i.fact_id,i.rev)=(r.learner_id,r.data->>'paperId',1)
       JOIN facts issued ON (issued.learner_id,issued.id)=(i.learner_id,i.fact_id)
       WHERE f.learner_id=$1 AND f.type=$2 AND issued.type=$3 AND r.tick<$4
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.data#>'{paper,questions}') q
           WHERE q->>'id'=i.data->>'itemId' AND q->'sourceQuestionRef' @> $5::jsonb)
       GROUP BY 1,2 HAVING count(*)>=2 ORDER BY max(r.tick) DESC LIMIT 12`,
    [tx.learner, posttestSubmissionType, posttestIssuanceType, through,
      JSON.stringify({ id: oldQuestion.id, rev: oldQuestion.rev })],
  );
  return rows;
}

export async function readWorkbookFollowupForecast<Input, Method>(tx: ActivityEvidenceReadScope,
  issuance: ReturnType<typeof posttestIssuance>, slotType: string) {
  const { rows: [row] } = await tx.query<{ input: Input; method: Method; manifest: unknown }>(
    `SELECT value#>'{value,input}' AS input,value#>'{value,method}' AS method,manifest
       FROM derivations WHERE learner_id=$1 AND id=$2 AND slot_type=$3 AND slot_key=$4
       AND effective_tick=$5 AND NOT is_shadow AND invalidated_tick IS NULL AND lifecycle='effective'
       AND scope_keys ? 'sourceReconciliationKey'`,
    [tx.learner, issuance.forecastId, slotType, issuance.forecastKey, issuance.effectiveTick],
  );
  return row;
}
