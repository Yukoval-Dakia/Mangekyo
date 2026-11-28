import { FactNotFoundError, factId, parseManifest, type CriterionObservationV2, type EvidenceEventV1, type FactId, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import type { QuestionConceptLink } from '@mangekyo/module-content/facts/knowledge-graph-overview';
import { eventAttributedKcIds, eventKcOutcome, formalItemCriteriaV2 } from '@mangekyo/module-learner/facts/evidence-slice-v2';
import { widenedRevOr } from '@mangekyo/module-learner/facts/widened-rev';
import type { FormalAssessmentValue } from './assessment-values.ts';
import {
  factBirthTick, mountedWorkbookItemProcess, readActivityHelpEvents, readActivitySubmissionBirth,
  readEarlierControlledPosttests, readWorkbookPreSubmitObservation,
  workbookItemHistory, type ActivityEvidenceReadScope, type WorkbookItemHelpProcess,
} from './evidence-read.ts';
import { controlledWorkbookHelp, type ActivityEvidenceObservation } from './evidence-slice.ts';
import { reopenControlledHelpBasis, type HelpTarget } from './help-exposure-values.ts';
import {
  issuedPosttestPaper, posttestIssuance, posttestIssuanceType, posttestSubmissionType,
  retentionPaperType, workbookRetentionTarget,
} from './retention-posttest.ts';
import {
  sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookFormalAssessmentType, workbookPaper, workbookPaperType,
  workbookRubricAssessment, workbookRubricAssessmentType, type WorkbookQuestion,
} from './workbook-values.ts';
import { matchingRubricAssessment, sameAssessmentRef } from './workbook-assessment-values.ts';

export type ConceptEvidenceRow = {
  readonly conceptId: FactId;
  readonly submission: { readonly id: FactId; readonly rev: Revision; readonly type: string };
  readonly questionId: FactId; readonly questionRev: Revision; readonly itemId?: string;
  readonly occurredAt: string; readonly recordedTick: Tick;
  readonly outcome: 'correct' | 'incorrect' | 'partial' | 'unknown'; readonly exposure: 'independent' | 'exposed' | 'unknown';
  readonly helpLevel: ActivityEvidenceObservation['helpLevel'];
  readonly scoreNorm?: number; readonly errorStage?: EvidenceEventV1['error_stage'];
  readonly criteria?: readonly CriterionObservationV2[];
  readonly basisRefs: readonly { readonly id: FactId; readonly rev: Revision; readonly type: string }[];
};

/** Gather verified controlled-posttest attempt evidence linked to authorized concepts.
 * Ordinary workbook attempts without complete pre-submission help coverage never fabricate
 * independence; only controlled posttest submissions checked via `controlledWorkbookHelp`
 * can establish `exposure: 'independent'`.
 */
export async function readConceptAttemptEvidence(
  tx: ActivityEvidenceReadScope, read: ReadContext, links: readonly QuestionConceptLink[],
  isUnavailable: (error: unknown) => boolean,
): Promise<{ readonly attempts: readonly ConceptEvidenceRow[]; readonly incompleteConceptIds: ReadonlySet<string> }> {
  const unavailable = (error: unknown) => error instanceof FactNotFoundError || isUnavailable(error) ||
    (error instanceof Error && (error.name === 'FactReadDeniedError' ||
      ['purpose','retracted','recipient','changed'].includes(String((error as {reason?:unknown}).reason))));
  const incompleteConceptIds = new Set<string>();
  if (!links.length) return { attempts: [], incompleteConceptIds };

  const linksByQuestion = new Map<FactId, Map<Revision, QuestionConceptLink[]>>();
  for (const link of links) {
    const byRev = linksByQuestion.get(link.questionId) ?? linksByQuestion.set(link.questionId, new Map()).get(link.questionId)!;
    (byRev.get(link.questionRev) ?? byRev.set(link.questionRev, []).get(link.questionRev)!).push(link);
  }

  const { rows: submissionRows } = await tx.query<{ id: string; type: string }>(`
    SELECT f.id, f.type FROM facts f
    WHERE f.learner_id=$1 AND f.type=ANY($2::text[]) AND f.retracted_rev IS NULL
      AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
    ORDER BY f.created_tick DESC, f.id LIMIT 256`, [tx.learner, [posttestSubmissionType, workbookAttemptType]]);

  const attempts: ConceptEvidenceRow[] = [];
  for (const row of submissionRows) {
    const id = factId(row.id);
    let submission: FactSnapshot;
    try {
      submission = await read.fact(id, { mode: 'following' });
    } catch (error) {
      if (unavailable(error)) continue;
      throw error;
    }
    if (submission.type !== posttestSubmissionType && submission.type !== workbookAttemptType) continue;
    let attempt;
    try { attempt = workbookAttempt(submission.value); } catch { continue; }

    const matchedQuestions: { question: WorkbookQuestion; matched: QuestionConceptLink[] }[] = [];
    for (const question of attempt.paper.questions) {
      const ref = question.sourceQuestionRef;
      if (!ref) continue;
      const byRev = linksByQuestion.get(factId(ref.id));
      let matched = byRev?.get(ref.rev) ?? [];
      for (const rev of byRev?.keys() ?? []) if (!matched.length && rev > ref.rev &&
          await widenedRevOr(read, factId(ref.id), ref.rev, rev, unavailable)) matched = byRev!.get(rev)!;
      if (matched.length) matchedQuestions.push({ question, matched });
    }
    if (!matchedQuestions.length) continue;

    const birth = await readActivitySubmissionBirth(tx, submission.ref, submission.type);
    if (!birth || !birth.unchanged || birth.submittedAt !== attempt.submittedAt) {
      if (submission.type === posttestSubmissionType) {
        for (const { matched } of matchedQuestions) for (const link of matched) incompleteConceptIds.add(link.conceptId);
      }
      continue;
    }
    const pushRows = (matched: QuestionConceptLink[], process: WorkbookItemHelpProcess,
        outcome: ConceptEvidenceRow['outcome'],
        extra: Pick<ConceptEvidenceRow, 'itemId' | 'scoreNorm' | 'errorStage' | 'criteria'>,
        ...prefix: ConceptEvidenceRow['basisRefs']) => {
      const exposure = process.exposure.kind === 'independent' ? 'independent'
        : process.exposure.kind === 'exposed' ? 'exposed' : 'unknown';
      const attributed = extra.criteria?.length ? eventAttributedKcIds({ criteria: extra.criteria }) : null;
      for (const link of matched) {
        const linkOutcome = attributed !== null ? eventKcOutcome({ criteria: extra.criteria }, link.conceptId) : outcome;
        if (attributed !== null && linkOutcome === 'unknown') continue;
        attempts.push({
          conceptId: link.conceptId, questionId: link.questionId, questionRev: link.questionRev,
          submission: { id: submission.ref.id, rev: submission.ref.rev, type: submission.type },
          occurredAt: attempt.submittedAt, recordedTick: birth.tick, outcome: linkOutcome, exposure,
          helpLevel: process.helpLevel, basisRefs: [...prefix, link.edgeRef],
          ...(extra.itemId !== undefined ? { itemId: extra.itemId } : {}),
          ...(extra.scoreNorm !== undefined ? { scoreNorm: extra.scoreNorm } : {}),
          ...(extra.errorStage !== undefined ? { errorStage: extra.errorStage } : {}),
          ...(extra.criteria?.length ? { criteria: extra.criteria } : {}),
        });
      }
    };

    if (submission.type === posttestSubmissionType) {
      let issuanceFact: FactSnapshot;
      let issuance: ReturnType<typeof posttestIssuance>;
      let paperFact: FactSnapshot;
      let paper: ReturnType<typeof workbookPaper>;
      try {
        issuanceFact = await read.fact(factId(attempt.paperId), { mode: 'following' });
        if (issuanceFact.type !== posttestIssuanceType) continue;
        issuance = posttestIssuance(issuanceFact.value);
        paperFact = await read.fact(issuance.paper.id, { mode: 'following' });
        if (paperFact.type !== retentionPaperType || paperFact.ref.rev !== issuance.paper.rev || paperFact.accessEpoch !== issuance.paperEpoch) {
          for (const { matched } of matchedQuestions) for (const link of matched) incompleteConceptIds.add(link.conceptId);
          continue;
        }
        paper = await issuedPosttestPaper(read, issuance);
      } catch (error) {
        if (unavailable(error)) {
          for (const { matched } of matchedQuestions) for (const link of matched) incompleteConceptIds.add(link.conceptId);
          continue;
        }
        throw error;
      }

      const targetMatch = matchedQuestions.find(({ question }) => question.id === issuance.itemId);
      if (!targetMatch) continue;
      const { question, matched } = targetMatch;
      const target = workbookRetentionTarget(paper, { id: paperFact.ref.id, rev: issuance.paper.rev }, issuance.itemId);
      const issuedBirth = await factBirthTick(tx, issuanceFact.ref.id);
      if (!issuedBirth) {
        for (const link of matched) incompleteConceptIds.add(link.conceptId);
        continue;
      }

      const releases = await readEarlierControlledPosttests(tx, target.paper.id, issuedBirth, birth.tick);
      const visible: { id: FactId; rev: Revision }[] = [];
      for (const releaseRow of releases) {
        try {
          const earlier = await read.fact(factId(releaseRow.id), { mode: 'following' });
          visible.push({ id: earlier.ref.id, rev: earlier.ref.rev });
        } catch (error) {
          if (!unavailable(error)) throw error;
        }
      }
      const mounts: HelpTarget[] = [target.paper, ...visible].map(({ id: activityId, rev }) => ({
        activityId, issuance: { id: activityId, rev }, item: { itemId: target.itemId },
      }));
      const { events, omitted } = await readActivityHelpEvents(tx, read, {
        activities: mounts.map(mount => mount.activityId), cutoff: birth.tick, mode: 'pinned', includeOpens: true,
      }, async (_, presentation) => {
        if (presentation.controlledBasis) {
          return reopenControlledHelpBasis(read, tx.learner, presentation.controlledBasis);
        }
        await read.fact(presentation.content.id, { mode: 'pinned', rev: presentation.content.rev });
        return true;
      }, unavailable);

      let process = controlledWorkbookHelp(
        submission.ref, birth.tick, mounts, events, omitted || visible.length !== releases.length,
        releases.some(release => release.competing_submission),
      );
      if (process.helpLevel === 'independent' &&
          (await workbookItemHistory(tx, target, birth.tick, issuanceFact.ref.id, issuedBirth)).cross_help) {
        process = { ...process, exposure: { kind: 'unknown', reason: 'incomplete-observation' }, helpLevel: 'unknown' };
      }

      const rawResult = attempt.feedback.find(item => item.questionId === question.id)?.result;
      const outcome = rawResult === 'correct' || rawResult === 'incorrect' ? rawResult : 'unknown';
      pushRows(matched, process, outcome, { itemId: question.id }, { id: issuanceFact.ref.id, rev: issuanceFact.ref.rev, type: issuanceFact.type },
        { id: paperFact.ref.id, rev: paperFact.ref.rev, type: paperFact.type });
      continue;
    }

    let paperFact: FactSnapshot;
    try {
      paperFact = await read.fact(factId(attempt.paperId), { mode: 'following' });
      if (paperFact.type !== workbookPaperType || !sameWorkbookJson(workbookPaper(paperFact.value), attempt.paper)) continue;
    } catch (error) {
      if (unavailable(error)) continue;
      throw error;
    }

    const paperBirth = await factBirthTick(tx, paperFact.ref.id);
    if (!paperBirth) continue;

    const { rows: formalRows } = await tx.query<{ value: unknown; manifest: unknown }>(
      `SELECT d.value, d.manifest FROM derivations d JOIN slot_state s ON (s.learner_id,s.slot_type,s.current_id)=(d.learner_id,d.slot_type,d.id)
       WHERE d.learner_id=$1 AND d.slot_type=$2 AND (
           d.scope_keys->>'attemptId'=$3 OR d.scope_keys->'submissionRef'->>'id'=$3
           OR d.value->'result'->'submissionRef'->>'id'=$3
           OR (d.value->>'kind'='value' AND d.value->'value'->'result'->'submissionRef'->>'id'=$3)
         )
         AND d.lifecycle='effective' AND NOT d.is_shadow AND d.invalidated_tick IS NULL AND d.selection_ended_tick IS NULL
         AND d.effective_tick >= d.gather_tick ORDER BY d.effective_tick DESC, d.slot_key`,
      [tx.learner, workbookFormalAssessmentType, submission.ref.id]);
    let formal: FormalAssessmentValue | undefined;
    for (const formalRow of formalRows) {
      const raw = formalRow.value as ({ kind?: unknown; value?: unknown } & Partial<FormalAssessmentValue>) | null;
      if (raw && typeof raw === 'object' && ['unknown', 'error', 'failed', 'rejected'].includes(String(raw.kind ?? ''))) continue;
      const val = (raw?.kind === 'value' && raw.value && typeof raw.value === 'object' && !Array.isArray(raw.value)
        ? raw.value : raw) as Partial<FormalAssessmentValue> | null;
      if (!val?.result || !Array.isArray(val.result.outcomes) ||
          !sameAssessmentRef(val.result.submissionRef, { id: submission.ref.id, rev: submission.ref.rev }) ||
          (attempt.paper.assessmentRelease?.releaseRef && !sameAssessmentRef(val.result.releaseRef, attempt.paper.assessmentRelease.releaseRef))) continue;
      let manifest;
      try { manifest = parseManifest(formalRow.manifest); } catch { continue; }
      const factInputs = manifest.inputs.filter((input): input is Extract<typeof input, { kind: 'fact' }> => input.kind === 'fact');
      if (!factInputs.length) continue;
      let authorized = true;
      for (const input of factInputs) {
        try {
          if ((await read.fact(input.id, { mode: 'pinned', rev: input.rev as Revision })).accessEpoch !== input.accessEpoch) authorized = false;
        } catch (error) {
          if (unavailable(error)) authorized = false;
          else throw error;
        }
      }
      if (!authorized) continue;
      formal = val as FormalAssessmentValue;
      break;
    }

    for (const { question, matched } of matchedQuestions) {
      const target = { paper: { id: paperFact.ref.id, rev: paperFact.ref.rev }, itemId: question.id };
      const observed = await readWorkbookPreSubmitObservation(tx, target.paper, question.id, birth.tick);
      const { process } = await mountedWorkbookItemProcess(
        tx, read, submission.ref, target.paper, question.id, birth.tick, observed, unavailable, undefined, paperBirth);
      if (process.exposure.kind === 'unknown') continue;
      const rawResult = attempt.feedback.find(item => item.questionId === question.id)?.result;
      let outcome: ConceptEvidenceRow['outcome'] = rawResult === 'correct' || rawResult === 'incorrect' ? rawResult : 'unknown';
      let scoreNorm: number | undefined;
      let errorStage: EvidenceEventV1['error_stage'] | undefined;
      let criteria: readonly CriterionObservationV2[] | undefined;
      const itemOutcomes = formal?.result.outcomes.filter(entry => entry.itemId === question.id) ?? [];
      if (itemOutcomes.length) {
        const releaseCriteria = attempt.paper.assessmentRelease?.items.find(item => item.itemId === question.id)?.criteria;
        const critMeta = new Map((formal!.criteria ?? []).filter(c => c.itemId === question.id).map(c => [c.criterionId, c]));
        const projected = formalItemCriteriaV2(itemOutcomes.map(entry => {
          const meta = critMeta.get(entry.criterionId);
          return {
            criterionId: entry.criterionId, state: entry.state,
            ...(entry.state === 'scored' ? { earned: entry.earned } : {}),
            ...('errorStage' in entry && entry.errorStage !== undefined ? { errorStage: entry.errorStage } : {}),
            ...(meta ? { maximum: meta.maximum, inputs: meta.inputs, evaluator: meta.evaluator } : {}),
          };
        }), releaseCriteria);
        outcome = projected.outcome;
        scoreNorm = projected.scoreNorm ?? undefined;
        errorStage = projected.errorStage;
        criteria = projected.criteria.length ? projected.criteria : undefined;
      }
      if (outcome === 'unknown' && !itemOutcomes.length && question.kind === 'rubric') {
        const { rows } = await tx.query<{ value: unknown; manifest: unknown }>(
          `SELECT d.value, d.manifest FROM derivations d JOIN slot_state s
             ON (s.learner_id,s.slot_type,s.current_id)=(d.learner_id,d.slot_type,d.id)
           WHERE d.learner_id=$1 AND d.slot_type=$2 AND d.scope_keys->>'attemptId'=$3
             AND d.scope_keys->>'paperId'=$4 AND d.lifecycle='effective' AND NOT d.is_shadow
             AND d.invalidated_tick IS NULL AND d.selection_ended_tick IS NULL
             AND d.effective_tick >= d.gather_tick ORDER BY d.slot_key`, [tx.learner, workbookRubricAssessmentType, submission.ref.id, attempt.paperId]);
        for (const row of rows) {
          let assessment;
          try {
            assessment = workbookRubricAssessment(row.value);
          } catch {
            continue;
          }
          if (!matchingRubricAssessment(attempt, question, assessment, submission.ref.id)) continue;
          let manifest;
          try {
            manifest = parseManifest(row.manifest);
          } catch {
            continue;
          }
          const inputs = manifest.inputs.filter((input): input is Extract<typeof input, { kind: 'fact' }> => input.kind === 'fact');
          if (inputs.length !== 2) continue;
          let authorized = true;
          for (const input of inputs) {
            try {
              const fact = await read.fact(input.id, { mode: 'pinned', rev: input.rev as Revision });
              if (fact.accessEpoch !== input.accessEpoch) authorized = false;
            } catch (error) {
              if (unavailable(error)) authorized = false;
              else throw error;
            }
          }
          if (!authorized) continue;
          outcome = assessment.verdict === 'correct' ? 'correct' as const : 'incorrect' as const;
          break;
        }
      }
      if (outcome === 'unknown' && !(criteria?.length && eventAttributedKcIds({ criteria }) !== null)) continue;
      pushRows(matched, process, outcome, {
        itemId: question.id,
        ...(scoreNorm !== undefined ? { scoreNorm } : {}),
        ...(errorStage !== undefined ? { errorStage } : {}),
        ...(criteria?.length ? { criteria } : {}),
      }, { id: paperFact.ref.id, rev: paperFact.ref.rev, type: paperFact.type });
    }
  }
  return { attempts, incompleteConceptIds };
}

export function mapConceptForecastInputs(
  forecasts: readonly {
    readonly effectiveTick: Tick; readonly observedThrough: Tick;
    readonly probability: number; readonly crossingAt?: string;
    readonly kcId?: string; readonly paperId: FactId; readonly itemId: string;
    readonly facts: readonly { readonly fact: FactSnapshot }[];
  }[],
  links: readonly QuestionConceptLink[],
) {
  const conceptsByQuestion = new Map<string, FactId[]>();
  for (const link of links) {
    const key = `${link.questionId}:${link.questionRev}`;
    const list = conceptsByQuestion.get(key) ?? [];
    list.push(link.conceptId);
    conceptsByQuestion.set(key, list);
  }
  const rows = forecasts.map(entry => {
    const paperFact = entry.facts.find(({ fact }) => (fact.type === workbookPaperType || fact.type === retentionPaperType) && fact.ref.id === entry.paperId)?.fact;
    const question = paperFact ? workbookPaper(paperFact.value).questions.find(q => q.id === entry.itemId) : undefined;
    const paperQuestionIds = question?.sourceQuestionRef ? [`${question.sourceQuestionRef.id}:${question.sourceQuestionRef.rev}`] : [];
    return {
      effectiveTick: entry.effectiveTick, observedThrough: entry.observedThrough,
      probability: entry.probability,
      ...(entry.crossingAt ? { crossingAt: entry.crossingAt } : {}),
      ...(entry.kcId ? { kcId: entry.kcId } : {}),
      paperQuestionIds,
      basisRefs: entry.facts.map(({ fact }) => ({ id: fact.ref.id, rev: fact.ref.rev, type: fact.type })),
    };
  });
  return { rows, conceptsByQuestion };
}
