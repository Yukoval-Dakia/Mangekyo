import { factId, type DerivationId, type FactId, type FactRef, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import type { AssessmentResult, AssessmentRevisionRef } from './assessment-values.ts';
import { formalItemOutcome } from './workbook-assessment-values.ts';
import { activityHelpProcess, controlledWorkbookHelp } from './evidence-slice.ts';
import {
  readActivityHelpEvents, readActivitySubmissionBirth, readEarlierControlledPosttests, workbookItemHistory,
  workbookLinkCandidates, workbookWitnessesBy, type ActivityEvidenceReadScope,
} from './evidence-read.ts';
import { helpAppliesTo, type HelpPresentation, type HelpTarget } from './help-exposure-values.ts';
import { projectHelpExposure } from './help-exposure.ts';
import { sourceReference, type SourceRefV1 } from './source-values.ts';
import {
  matchesControlledSubmission, posttestIssuance, posttestSubmissionType, retentionPaperType,
  workbookRetentionTarget, workbookVariantItem,
} from './retention-posttest.ts';
import {
  sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType,
  type WorkbookAttempt, type WorkbookSourceQuestionRef,
} from './workbook-values.ts';

type FactReader = {fact(...args: Parameters<ReadContext['fact']>): Promise<FactSnapshot>};
type Edge = Parameters<typeof workbookVariantItem>[2][number];
export function workbookEvidenceReader<Tx extends ActivityEvidenceReadScope>({
  trackSource, reopenCapsule, openEdge, readPosttestIssuance, readFormalAssessment, createRead, unavailable, unavailableRelease, reject, edgeType, questionType,
}: {
  trackSource(tx: Tx, read: FactReader, ref: string | SourceRefV1): Promise<{content: unknown}>;
  reopenCapsule(tx: Tx, read: FactReader, basis: NonNullable<HelpPresentation['controlledBasis']>): Promise<void>;
  openEdge(tx: Tx, id: FactId): Promise<{
    value: Edge; opened: readonly (readonly [FactSnapshot, ('pinned' | 'following' | undefined)?])[];
  } | undefined>;
  readPosttestIssuance(tx: Tx, read: FactReader, id: FactId):
    Promise<{fact: FactSnapshot; issuance: ReturnType<typeof posttestIssuance>; tick: Tick}>;
  readFormalAssessment?(tx: Tx, releaseRef: AssessmentRevisionRef, submission: FactSnapshot,
    paper: FactSnapshot, cutoff?: Tick): Promise<{ state: string; releaseRef: AssessmentRevisionRef; result?: AssessmentResult } | undefined>;
  createRead(tx: Tx): ReadContext;
  unavailable(error: unknown): boolean;
  unavailableRelease(error: unknown): boolean;
  reject(status: number, message: string): Error;
  edgeType: string;
  questionType: string | readonly string[];
}) {
  async function openRetentionTarget(tx: Tx, read: FactReader, paperId: FactId, itemId: string) {
    const source = await read.fact(paperId, { mode: 'following' });
    if (source.type !== workbookPaperType && source.type !== retentionPaperType) throw reject(404, '找不到冻结试卷。');
    const paper = workbookPaper(source.value);
    const question = paper.questions.find(question => question.id === itemId);
    const formalScored = paper.assessmentRelease?.items.some(entry =>
      entry.itemId === itemId && entry.criteria.some(criterion => criterion.maximum !== null)) ?? false;
    if (!question || (question.kind === 'rubric' && !formalScored) || (question.kind === 'exact' && question.selfCheck)) {
      throw reject(422, '保持预测需要可确定性正式判分的题项。');
    }
    if (question.sourceQuestionRef) {
      const allowed = Array.isArray(questionType) ? questionType : [questionType];
      const sourceType = allowed.length === 1 ? allowed[0]!
        : (await read.fact(factId(question.sourceQuestionRef.id), { mode: 'pinned', rev: question.sourceQuestionRef.rev })).type;
      if (!allowed.includes(sourceType)) throw reject(422, '来源题面与冻结题项不匹配。');
      const resolved = await trackSource(tx, read, {
        v: 1, fact: { ...question.sourceQuestionRef, type: sourceType },
        anchor: { kind: 'question', itemId: 'question' },
      });
      if (resolved.content !== question.prompt) throw reject(422, '来源题面与冻结题项不匹配。');
    }
    if (paper.materialId) await trackSource(tx, read, paper.materialId);
    const target = workbookRetentionTarget(paper, { id: paperId, rev: source.ref.rev }, itemId);
    return { target, paper, question, source, accessEpoch: source.accessEpoch, sealed: source.type === retentionPaperType };
  }

  /** SQL discovers IDs. Each available edge carries its authorized, cutoff-checked witnesses. */
  async function* openedItemEdges(
    tx: Tx, source: WorkbookSourceQuestionRef | undefined, cutoff: Tick,
    kinds: readonly ('targets_concept' | 'variant_of')[], open = (id: FactId) => openEdge(tx,id),
  ) {
    if (!source) return;
    for (const { id } of await workbookLinkCandidates(tx, edgeType, source, cutoff, kinds)) {
      const edge = await open(id);
      if (edge && await workbookWitnessesBy(tx,edge.opened.map(([fact])=>fact.ref),cutoff)) yield edge;
    }
  }

  async function readItemEdges(tx: Tx, read: FactReader, source: WorkbookSourceQuestionRef | undefined,
    cutoff: Tick, kinds: readonly ('targets_concept' | 'variant_of')[], open?: (id: FactId) => ReturnType<typeof openEdge>) {
    const edges = [];
    for await (const edge of openedItemEdges(tx,source,cutoff,kinds,open)) {
      for (const [fact,mode] of edge.opened)
        await read.fact(fact.ref.id,mode === 'following' ? {mode} : {mode:'pinned',rev:fact.ref.rev});
      edges.push(edge.value);
    }
    return edges;
  }

  async function readItemDimensions(tx: Tx, read: FactReader, source: WorkbookSourceQuestionRef | undefined,
    cutoff: Tick, open?: (id: FactId) => ReturnType<typeof openEdge>) {
    const edges = await readItemEdges(tx,read,source,cutoff,['targets_concept'],open);
    return [...new Set(edges.map(edge=>edge.to.fact.id))].sort();
  }

  async function readItemConceptLinks(tx: Tx, source: WorkbookSourceQuestionRef | undefined, cutoff: Tick,
    open: (id: FactId) => ReturnType<typeof openEdge>) {
    const links = [];
    for await (const {value,opened} of openedItemEdges(tx,source,cutoff,['targets_concept'],open))
      links.push({conceptId:value.to.fact.id,opened});
    return links;
  }

  async function openControlledSubmission(
    tx: Tx, read: FactReader, attempt: WorkbookAttempt, admittedAt: Tick,
    opened?: Awaited<ReturnType<typeof openRetentionTarget>>, expectedForecast?: DerivationId,
  ) {
    const issued = await readPosttestIssuance(tx, read, factId(attempt.paperId));
    const release = issued.issuance;
    const root = opened ?? await openRetentionTarget(tx, read, release.paper.id, release.itemId);
    if (!matchesControlledSubmission(attempt, admittedAt, issued, root, expectedForecast)) {
      throw reject(422, '后测交卷与原预测或发放不匹配。');
    }
    return { issued, source: root.source };
  }

  async function readWorkbookObservation(
    tx: Tx, read: FactReader, opened: Awaited<ReturnType<typeof openRetentionTarget>>, id: FactId,
    expectedForecast?: DerivationId,
  ) {
    return (await readWorkbookEvidence(tx, read, opened, id, expectedForecast)).observation;
  }

  async function readWorkbookEvidence(
    tx: Tx, read: FactReader, opened: Awaited<ReturnType<typeof openRetentionTarget>>, id: FactId,
    expectedForecast?: DerivationId, cutoff?: Tick,
  ) {
    const { target, paper } = opened;
    const submission = await read.fact(id, { mode: 'following' });
    const controlled = submission.type === posttestSubmissionType;
    if (!controlled && submission.type !== workbookAttemptType) throw reject(422, '需要正式交卷记录。');
    const attempt = workbookAttempt(submission.value);
    const birth = await readActivitySubmissionBirth(tx, submission.ref, submission.type);
    if (!birth || !birth.unchanged || birth.submittedAt !== attempt.submittedAt || controlled !== opened.sealed) {
      throw reject(422, '交卷和冻结卷面的题项或判分条件不一致。');
    }
    const release = controlled
      ? await openControlledSubmission(tx, read, attempt, birth.tick, opened, expectedForecast)
      : undefined;
    let process: ReturnType<typeof activityHelpProcess>;
    if (release) {
      const { issued } = release;
      process = await readControlledExposure(tx, read, target, issued.tick, submission.ref, birth.tick);
    } else {
      if (attempt.paperId !== target.paper.id) throw reject(422, '交卷不属于此试卷。');
      if (attempt.gradingVersion !== target.gradingVersion || !sameWorkbookJson(attempt.paper, paper)) {
        throw reject(422, '交卷和冻结卷面的题项或判分条件不一致。');
      }
      process = await readExposure(tx, read, target, submission.ref, birth.tick);
    }
    if (controlled && process.helpLevel === 'independent' && (await workbookItemHistory(tx, target, birth.tick)).cross_help) {
      process = activityHelpProcess({ kind: 'unknown', reason: 'incomplete-observation', evidenceRefs: [] }, []);
    }
    let formal: ReturnType<typeof formalItemOutcome>;
    if (!controlled && paper.assessmentRelease && readFormalAssessment) {
      const saved = await readFormalAssessment(tx, paper.assessmentRelease.releaseRef, submission, opened.source, cutoff).catch(error => {
        if (unavailable(error) || unavailableRelease(error)) return undefined;
        throw error;
      });
      formal = formalItemOutcome(paper, target.itemId, saved);
    }
    const rawResult = attempt.feedback.find(item => item.questionId === target.itemId)?.result;
    const result = formal ? formal.result : rawResult === 'correct' || rawResult === 'incorrect' ? rawResult : 'unknown' as const;
    const observation = {
      submission: { id, rev: submission.ref.rev }, admittedAt: birth.tick, submittedAt: attempt.submittedAt,
      result, exposure: process.exposure,
      ...(formal?.scoreNorm === undefined ? {} : { scoreNorm: formal.scoreNorm }),
      ...(result === 'incorrect' && formal?.errorStage !== undefined ? { errorStage: formal.errorStage } : {}),
    };
    return {
      observation, process, issuance: release?.issued, recordedAt: birth.recordedAt, duration: attempt.effectiveDurationMs,
    };
  }

  async function readComparableWorkbookEvidence(
    tx: Tx, read: FactReader, target: Awaited<ReturnType<typeof openRetentionTarget>>,
    id: FactId, cutoff: Tick,
  ) {
    const fact = await read.fact(id, { mode: 'following' });
    if (fact.type !== workbookAttemptType && fact.type !== posttestSubmissionType)
      throw reject(422, '需要正式交卷记录。');
    const attempt = workbookAttempt(fact.value);
    const paperId = fact.type === posttestSubmissionType
      ? (await readPosttestIssuance(tx, read, factId(attempt.paperId))).issuance.paper.id : factId(attempt.paperId);
    if (paperId === target.target.paper.id) {
      const evidence = await readWorkbookEvidence(tx, read, target, id, undefined, cutoff);
      return { evidence, opened: target, novelty: 'same' as const };
    }
    const candidates = await readItemEdges(tx, read, target.question.sourceQuestionRef, cutoff, ['variant_of']);
    const match = workbookVariantItem(attempt.paper, target.question.sourceQuestionRef, candidates);
    if (!match) throw reject(422, '交卷与预测题项缺少可核对的无剧透变式关系。');
    const opened = await openRetentionTarget(tx, read, paperId, match.id);
    const evidence = await readWorkbookEvidence(tx, read, opened, id, undefined, cutoff);
    return { evidence, opened, novelty: 'isomorphic' as const };
  }

  async function readControlledExposure(
    tx: Tx, read: FactReader, target: ReturnType<typeof workbookRetentionTarget>, started: Tick, ref: FactRef, cutoff: Tick,
  ) {
    const releases = await readEarlierControlledPosttests(tx, target.paper.id, started, cutoff);
    const visible = [];
    for (const row of releases) {
      try {
        const { fact } = await readPosttestIssuance(tx, read, factId(row.id));
        visible.push(fact.ref);
      } catch (error) {
        if (!unavailableRelease(error)) throw error;
      }
    }
    const mounts: HelpTarget[] = [target.paper, ...visible].map(({ id, rev }) => ({
      activityId: id, issuance: { id, rev }, item: { itemId: target.itemId },
    }));
    const { events, omitted } = await readActivityHelpEvents(tx, read, {
      activities: mounts.map(mount => mount.activityId), cutoff, mode: 'pinned', includeOpens: true,
    }, async (_, presentation) => {
      if (presentation.controlledBasis) await reopenCapsule(tx, read, presentation.controlledBasis);
      else {
        const { id, rev } = presentation.content;
        const content = await read.fact(id, { mode: 'pinned', rev });
        await trackSource(tx, read, sourceReference(content, { kind: 'whole' }));
      }
      return true;
    }, unavailable);
    return controlledWorkbookHelp(ref, cutoff, mounts, events, omitted || visible.length !== releases.length,
      releases.some(release => release.competing_submission));
  }

  async function readExposure(
    tx: Tx, read: FactReader, target: ReturnType<typeof workbookRetentionTarget>,
    ref: Parameters<typeof projectHelpExposure>[0]['submission']['ref'], cutoff: Tick,
  ) {
    // Workbook creates the original release at revision 1. Teaching grants create revisions carrying its unchanged content.
    const mount = {
      activityId: target.paper.id, issuance: { id: target.paper.id, rev: 1 as Revision },
      item: { itemId: target.itemId },
    };
    const { events } = await readActivityHelpEvents(tx, createRead(tx), {
      activities: [target.paper.id], cutoff, mode: 'following',
    }, async (fact, value) => {
      if (!helpAppliesTo(value, mount)) return false;
      const { id, rev } = value.content;
      const content = await read.fact(id, { mode: 'pinned', rev });
      await trackSource(tx, read, sourceReference(content, { kind: 'whole' }));
      await read.fact(fact.ref.id, { mode: 'following' });
      return true;
    }, unavailable);
    // The ordinary workbook host has no complete observation of pre-submission help.
    return activityHelpProcess(projectHelpExposure({ submission: { ref, target: mount, cutoff }, events, coverage: null }), events);
  }

  return {
    openRetentionTarget, openControlledSubmission, readWorkbookObservation, readWorkbookEvidence,
    readComparableWorkbookEvidence, readItemDimensions, readItemConceptLinks,
  };
}
