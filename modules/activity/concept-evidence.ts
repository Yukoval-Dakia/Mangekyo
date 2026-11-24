import { FactNotFoundError, factId, parseManifest, type FactId, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import type { QuestionConceptLink } from '@mangekyo/module-content/facts/knowledge-graph-overview';
import { widenedRevOr } from '@mangekyo/module-learner/facts/widened-rev';
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
  sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType,
  workbookRubricAssessment, workbookRubricAssessmentType, type WorkbookQuestion,
} from './workbook-values.ts';
import { matchingRubricAssessment } from './workbook-assessment-values.ts';

export type ConceptEvidenceRow = {
  readonly conceptId: FactId;
  readonly submission: { readonly id: FactId; readonly rev: Revision; readonly type: string };
  readonly questionId: FactId; readonly questionRev: Revision; readonly occurredAt: string; readonly recordedTick: Tick;
  readonly outcome: 'correct' | 'incorrect' | 'unknown'; readonly exposure: 'independent' | 'exposed' | 'unknown';
  readonly helpLevel: ActivityEvidenceObservation['helpLevel'];
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
        outcome: ConceptEvidenceRow['outcome'], ...prefix: ConceptEvidenceRow['basisRefs']) => {
      const exposure = process.exposure.kind === 'independent' ? 'independent'
        : process.exposure.kind === 'exposed' ? 'exposed' : 'unknown';
      for (const link of matched) attempts.push({
        conceptId: link.conceptId, questionId: link.questionId, questionRev: link.questionRev,
        submission: { id: submission.ref.id, rev: submission.ref.rev, type: submission.type },
        occurredAt: attempt.submittedAt, recordedTick: birth.tick, outcome, exposure,
        helpLevel: process.helpLevel, basisRefs: [...prefix, link.edgeRef],
      });
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
      pushRows(matched, process, outcome, { id: issuanceFact.ref.id, rev: issuanceFact.ref.rev, type: issuanceFact.type },
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

    for (const { question, matched } of matchedQuestions) {
      const target = { paper: { id: paperFact.ref.id, rev: paperFact.ref.rev }, itemId: question.id };
      const observed = await readWorkbookPreSubmitObservation(tx, target.paper, question.id, birth.tick);
      const { process } = await mountedWorkbookItemProcess(
        tx, read, submission.ref, target.paper, question.id, birth.tick, observed, unavailable, undefined, paperBirth);
      if (process.exposure.kind === 'unknown') continue;
      const rawResult = attempt.feedback.find(item => item.questionId === question.id)?.result;
      let outcome: 'correct' | 'incorrect' | 'unknown' = rawResult === 'correct' || rawResult === 'incorrect' ? rawResult : 'unknown';
      if (outcome === 'unknown' && question.kind === 'rubric') {
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
      if (outcome === 'unknown') continue;
      pushRows(matched, process, outcome, { id: paperFact.ref.id, rev: paperFact.ref.rev, type: paperFact.type });
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
