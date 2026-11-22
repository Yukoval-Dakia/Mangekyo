import { FactNotFoundError, factId, type FactId, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import type { QuestionConceptLink } from '@mangekyo/module-content/facts/knowledge-graph-overview';
import {
  readActivityHelpEvents, readActivitySubmissionBirth, readEarlierControlledPosttests, workbookItemHistory,
  type ActivityEvidenceReadScope,
} from './evidence-read.ts';
import { controlledWorkbookHelp } from './evidence-slice.ts';
import { reopenControlledHelpBasis, type HelpTarget } from './help-exposure-values.ts';
import {
  issuedPosttestPaper, posttestIssuance, posttestIssuanceType, posttestSubmissionType,
  retentionPaperType, workbookRetentionTarget,
} from './retention-posttest.ts';
import { workbookAttempt, workbookPaper, workbookPaperType } from './workbook-values.ts';

export type ConceptEvidenceRow = {
  readonly conceptId: FactId;
  readonly submission: { readonly id: FactId; readonly rev: Revision; readonly type: string };
  readonly questionId: FactId;
  readonly questionRev: Revision;
  readonly occurredAt: string;
  readonly recordedTick: Tick;
  readonly outcome: 'correct' | 'incorrect' | 'unknown';
  readonly exposure: 'independent' | 'exposed' | 'unknown';
  readonly basisRefs: readonly { readonly id: FactId; readonly rev: Revision; readonly type: string }[];
};

/** Gather verified controlled-posttest attempt evidence linked to authorized concepts.
 * Ordinary workbook attempts without complete pre-submission help coverage never fabricate
 * independence; only controlled posttest submissions checked via `controlledWorkbookHelp`
 * can establish `exposure: 'independent'`.
 */
export async function readConceptAttemptEvidence(
  tx: ActivityEvidenceReadScope,
  read: ReadContext,
  links: readonly QuestionConceptLink[],
  isUnavailable: (error: unknown) => boolean,
): Promise<{ readonly attempts: readonly ConceptEvidenceRow[]; readonly incompleteConceptIds: ReadonlySet<string> }> {
  const unavailable = (error: unknown) => error instanceof FactNotFoundError || isUnavailable(error);
  const incompleteConceptIds = new Set<string>();
  if (!links.length) return { attempts: [], incompleteConceptIds };

  const linksByQuestion = new Map<string, QuestionConceptLink[]>();
  for (const link of links) {
    const key = `${link.questionId}:${link.questionRev}`;
    const list = linksByQuestion.get(key) ?? [];
    list.push(link);
    linksByQuestion.set(key, list);
  }

  const { rows: submissionRows } = await tx.query<{ id: string }>(`
    SELECT f.id FROM facts f
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
      AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
    ORDER BY f.created_tick DESC, f.id LIMIT 256`, [tx.learner, posttestSubmissionType]);

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
    if (submission.type !== posttestSubmissionType) continue;
    let attempt;
    try { attempt = workbookAttempt(submission.value); } catch { continue; }

    const matchedQuestions = attempt.paper.questions.flatMap(question => {
      const ref = question.sourceQuestionRef;
      if (!ref) return [];
      const matched = linksByQuestion.get(`${ref.id}:${ref.rev}`);
      return matched?.length ? [{ question, matched }] : [];
    });
    if (!matchedQuestions.length) continue;

    const birth = await readActivitySubmissionBirth(tx, submission.ref, posttestSubmissionType);
    if (!birth || !birth.unchanged || birth.submittedAt !== attempt.submittedAt) {
      for (const { matched } of matchedQuestions) for (const link of matched) incompleteConceptIds.add(link.conceptId);
      continue;
    }

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
    const { rows: [issuedBirth] } = await tx.query<{ tick: Tick }>(
      `SELECT tick::text FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=1`,
      [tx.learner, issuanceFact.ref.id],
    );
    if (!issuedBirth) {
      for (const link of matched) incompleteConceptIds.add(link.conceptId);
      continue;
    }

    const releases = await readEarlierControlledPosttests(tx, target.paper.id, issuedBirth.tick, birth.tick);
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
        (await workbookItemHistory(tx, target, birth.tick, issuanceFact.ref.id, issuedBirth.tick)).cross_help) {
      process = { ...process, exposure: { kind: 'unknown', reason: 'incomplete-observation' }, helpLevel: 'unknown' };
    }

    const rawResult = attempt.feedback.find(item => item.questionId === question.id)?.result;
    const outcome = rawResult === 'correct' || rawResult === 'incorrect' ? rawResult : 'unknown';
    const exposure = process.exposure.kind === 'independent' ? 'independent'
      : process.exposure.kind === 'exposed' ? 'exposed' : 'unknown';

    for (const link of matched) {
      attempts.push({
        conceptId: link.conceptId,
        submission: { id: submission.ref.id, rev: submission.ref.rev, type: submission.type },
        questionId: link.questionId,
        questionRev: link.questionRev,
        occurredAt: attempt.submittedAt,
        recordedTick: birth.tick,
        outcome,
        exposure,
        basisRefs: [
          { id: issuanceFact.ref.id, rev: issuanceFact.ref.rev, type: issuanceFact.type },
          { id: paperFact.ref.id, rev: paperFact.ref.rev, type: paperFact.type },
          link.edgeRef,
        ],
      });
    }
  }
  return { attempts, incompleteConceptIds };
}

export function mapConceptForecastInputs(
  forecasts: readonly {
    readonly effectiveTick: Tick;
    readonly observedThrough: Tick;
    readonly probability: number;
    readonly crossingAt?: string;
    readonly kcId?: string;
    readonly paperId: FactId;
    readonly itemId: string;
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
      effectiveTick: entry.effectiveTick,
      observedThrough: entry.observedThrough,
      probability: entry.probability,
      ...(entry.crossingAt ? { crossingAt: entry.crossingAt } : {}),
      ...(entry.kcId ? { kcId: entry.kcId } : {}),
      paperQuestionIds,
      basisRefs: entry.facts.map(({ fact }) => ({ id: fact.ref.id, rev: fact.ref.rev, type: fact.type })),
    };
  });
  return { rows, conceptsByQuestion };
}
