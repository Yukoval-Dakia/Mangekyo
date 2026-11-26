import {
  factId, isFactNotFound, isFactReadDenied,
  type FactId, type FactSnapshot, type ReadContext, type Revision, type Tick,
} from '@mangekyo/kernel';
import { RequestError } from '@mangekyo/module-capture/facts/request';
import { buildDualBacktrace, type DualBacktraceAttemptInput, type DualBacktraceEdgeInput, type DualBacktraceHelpExposure, type DualBacktraceResult } from '@mangekyo/module-content/facts/dual-backtrace';
import { parseKnowledgeEdge } from '@mangekyo/module-content/facts/knowledge-edge';
import type { FlowGraphSnapshot } from '@mangekyo/module-learner/facts/record-flow';
import {
  factBirthTick, mountedWorkbookItemProcess, readActivitySubmissionBirth, readWorkbookPreSubmitObservation,
  type ActivityEvidenceReadScope,
} from './evidence-read.ts';
import { helpExposure, helpExposureType } from './help-exposure-values.ts';
import {
  sameWorkbookJson, workbookAttempt, workbookPaper, workbookAttemptType, workbookPaperType,
} from './workbook-values.ts';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clip = (text: string, limit: number) => text.replace(/\s+/g, ' ').trim().slice(0, limit) || undefined;
const bigTick = (tick: string) => { try { return BigInt(tick); } catch { return 0n; } };

export type BacktraceItemRow = {
  readonly attemptId: FactId; readonly attemptRev: Revision; readonly paperId: FactId; readonly paperRev: Revision;
  readonly itemId: string; readonly cutoffTick: string;
  readonly questionId: FactId; readonly questionRev: Revision; readonly questionTitle?: string;
  readonly learnerAnswer?: string; readonly durationMs?: number;
  readonly verdict: 'correct' | 'partial' | 'incorrect'; readonly errorStage?: string | null;
  readonly submittedAt?: string; readonly purpose?: readonly string[];
};

const verdictOf = (value: unknown): BacktraceItemRow['verdict'] | undefined =>
  value === 'correct' || value === 'partial' || value === 'incorrect' ? value : undefined;

/** One row per attempted bank item in the authorized snapshot, newest first, capped for latency. */
export function collectBacktraceRows(snap: FlowGraphSnapshot, limit = 60): readonly BacktraceItemRow[] {
  const rows: BacktraceItemRow[] = [];
  for (const fact of snap.factsById.values()) {
    if (fact.type !== workbookAttemptType) continue;
    let attempt: ReturnType<typeof workbookAttempt>;
    try { attempt = workbookAttempt(fact.data); } catch { continue; }
    const paperFact = snap.factsById.get(attempt.paperId);
    const paperRev = paperFact && typeof paperFact.rev === 'number' && Number.isSafeInteger(paperFact.rev) && paperFact.rev >= 1 ? paperFact.rev as Revision : undefined;
    if (paperRev === undefined) continue;
    let paperId: FactId;
    try { paperId = factId(attempt.paperId); } catch { continue; }
    for (const feedback of attempt.feedback) {
      const question = attempt.paper.questions.find(item => item.id === feedback.questionId);
      const source = question?.sourceQuestionRef;
      if (!question || !source) continue;
      let sourceId: FactId;
      try { sourceId = factId(source.id); } catch { continue; }
      const assessment = snap.assessmentsByKey.get(`${fact.id}:${question.id}`);
      const verdict = verdictOf(assessment?.verdict) ?? verdictOf(feedback.result);
      if (!verdict) continue;
      const errorStage = typeof assessment?.errorStage === 'string' ? assessment.errorStage
        : typeof feedback.errorStage === 'string' ? feedback.errorStage : undefined;
      const embedded = record(question);
      const duration = embedded.effectiveDurationMs;
      const title = clip(question.prompt, 120);
      const answer = typeof feedback.answer === 'string' ? clip(feedback.answer, 240) : undefined;
      rows.push({
        attemptId: fact.id as FactId, attemptRev: fact.rev as Revision, paperId, paperRev,
        itemId: question.id, cutoffTick: fact.createdTick,
        questionId: sourceId, questionRev: source.rev,
        ...(title !== undefined ? { questionTitle: title } : {}),
        ...(answer !== undefined ? { learnerAnswer: answer } : {}),
        ...(typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? { durationMs: duration } : {}),
        verdict, ...(errorStage !== undefined ? { errorStage } : {}),
        ...(attempt.submittedAt ? { submittedAt: attempt.submittedAt } : {}),
        ...(((fact as { purpose?: readonly string[] }).purpose ?? null) !== null ? { purpose: (fact as { purpose?: readonly string[] }).purpose } : {}),
      });
    }
  }
  rows.sort((left, right) => (right.submittedAt ?? '').localeCompare(left.submittedAt ?? '') ||
    left.attemptId.localeCompare(right.attemptId) || left.itemId.localeCompare(right.itemId));
  return rows.slice(0, limit);
}

/** Knowledge-edge inputs for the dual backtrace, restricted to the authorized snapshot boundary. */
export function snapBacktraceEdges(snap: FlowGraphSnapshot): readonly DualBacktraceEdgeInput[] {
  const edges: DualBacktraceEdgeInput[] = [];
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'content.knowledgeEdge') continue;
    try {
      const edge = parseKnowledgeEdge(fact.data);
      // 'canonical_archetype' does not exist in today's edge vocabulary but stays wired for forward compatibility.
      const kind = edge.kind as string;
      if (!['targets_concept', 'variant_of', 'instance_of', 'canonical_archetype', 'maps_to_chapter', 'explains'].includes(kind)) continue;
      try {
        edges.push({ kind: kind as DualBacktraceEdgeInput['kind'], fromId: factId(edge.from.sourceUse.id), toId: factId(edge.to.sourceUse.id) });
      } catch { continue; }
    } catch { continue; }
  }
  return edges;
}

const exposureRank: Readonly<Record<DualBacktraceHelpExposure, number>> = {
  none: 0, unexposed: 0, unknown: 1, hint: 2, worked_example: 3, assisted: 4, solution_seen: 5,
};

function exposureEventLevel(data: unknown): { readonly activityId?: string; readonly itemId?: string; readonly level: DualBacktraceHelpExposure } | undefined {
  let event: ReturnType<typeof helpExposure>;
  try { event = helpExposure(data); } catch { return undefined; }
  const mountOf = (target: { activityId: string; item: { itemId: string } }) => ({ activityId: target.activityId, itemId: target.item.itemId });
  switch (event.kind) {
    case 'opened':
    case 'displayed': {
      const mount = mountOf(event.mount);
      const step = event.step.kind;
      const level: DualBacktraceHelpExposure = step === 'solution' ? 'solution_seen'
        : step === 'worked-example' ? 'worked_example' : 'hint';
      return { ...mount, level };
    }
    case 'used':
      return { ...mountOf(event.target), level: 'hint' };
    case 'assisted-completion':
    case 'follow-up':
      return { ...mountOf(event.answer.target), level: 'assisted' };
    default:
      return undefined;
  }
}

/** Scan exposure events and the witness pipeline; never claim independence without witnessed coverage. */
export async function scanBacktraceHelpLevels(
  tx: ActivityEvidenceReadScope,
  read: Pick<ReadContext, 'fact'>,
  rows: readonly BacktraceItemRow[],
  snapshots: ReadonlyMap<string, FactSnapshot>,
  unavailable: (error: unknown) => boolean,
): Promise<ReadonlyMap<string, DualBacktraceHelpExposure>> {
  const cutoff = rows.reduce((max, row) => bigTick(row.cutoffTick) > max ? bigTick(row.cutoffTick) : max, 0n) + 1n;
  const { rows: exposureRows } = await tx.query<{ id: string; tick: string; data: unknown }>(
    `SELECT r.fact_id AS id, r.tick::text AS tick, r.data FROM fact_revs r
     JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
     WHERE r.learner_id=$1 AND f.type=$2 AND r.rev=f.current_rev AND f.retracted_rev IS NULL
       AND r.kind='value' AND r.tick<$3::bigint
       AND f.purpose && ARRAY['storage','all']::text[]`,
    [tx.learner, helpExposureType, cutoff.toString()],
  );
  const events = exposureRows.flatMap(row => {
    const parsed = exposureEventLevel(row.data);
    return parsed?.activityId !== undefined && parsed.itemId !== undefined
      ? [{ activityId: parsed.activityId, itemId: parsed.itemId, tick: bigTick(row.tick), level: parsed.level }] : [];
  });
  const levels = new Map<string, DualBacktraceHelpExposure>();
  const pending: { row: BacktraceItemRow; key: string }[] = [];
  for (const row of rows) {
    const key = `${row.attemptId}:${row.itemId}`;
    const rowCutoff = bigTick(row.cutoffTick);
    let hit: DualBacktraceHelpExposure | undefined;
    for (const event of events) {
      if (event.activityId !== row.paperId || event.itemId !== row.itemId || event.tick >= rowCutoff) continue;
      if (hit === undefined || exposureRank[event.level] > exposureRank[hit]) hit = event.level;
    }
    if (hit !== undefined) levels.set(key, hit);
    else pending.push({ row, key });
  }
  let witnessed = 0;
  for (const { row, key } of pending) {
    if (row.verdict !== 'correct' || witnessed >= 40) { levels.set(key, 'unknown'); continue; }
    witnessed += 1;
    let level: DualBacktraceHelpExposure = 'unknown';
    try {
      const attemptSnap = snapshots.get(row.attemptId);
      const paperSnap = snapshots.get(row.paperId);
      if (attemptSnap?.type === workbookAttemptType && paperSnap?.type === workbookPaperType) {
        const attempt = workbookAttempt(attemptSnap.value);
        if (sameWorkbookJson(workbookPaper(paperSnap.value), attempt.paper) && paperSnap.ref.rev === row.paperRev) {
          const birth = await readActivitySubmissionBirth(tx, attemptSnap.ref, attemptSnap.type);
          if (birth && birth.unchanged && birth.submittedAt === attempt.submittedAt) {
            const paperBirth = await factBirthTick(tx, row.paperId);
            if (paperBirth) {
              const paper = { id: row.paperId, rev: row.paperRev };
              const observed = await readWorkbookPreSubmitObservation(tx, paper, row.itemId, birth.tick);
              const { process } = await mountedWorkbookItemProcess(
                tx, read, attemptSnap.ref, paper, row.itemId, birth.tick, observed, unavailable, undefined, paperBirth as Tick);
              if (process.helpLevel === 'independent') level = 'none';
              else if (process.helpLevel === 'solution_seen') level = 'solution_seen';
              else if (process.helpLevel === 'hint_l1' || process.helpLevel === 'hint_l2' || process.helpLevel === 'hinted') level = 'hint';
              else level = 'unknown';
            }
          }
        }
      }
    } catch (error) {
      if (!unavailable(error)) throw error;
      level = 'unknown';
    }
    levels.set(key, level);
  }
  return levels;
}

/** Shape snapshot rows plus scanned help levels into dual-backtrace attempt inputs. */
export function assembleBacktraceAttempts(
  rows: readonly BacktraceItemRow[], levels: ReadonlyMap<string, DualBacktraceHelpExposure>,
): readonly DualBacktraceAttemptInput[] {
  return rows.map(row => ({
    attemptId: row.attemptId, attemptRev: row.attemptRev,
    questionId: row.questionId, questionRev: row.questionRev,
    ...(row.questionTitle !== undefined ? { questionTitle: row.questionTitle } : {}),
    ...(row.learnerAnswer !== undefined ? { learnerAnswer: row.learnerAnswer } : {}),
    ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
    ...(row.submittedAt !== undefined ? { submittedAt: row.submittedAt } : {}),
    verdict: row.verdict, helpExposure: levels.get(`${row.attemptId}:${row.itemId}`) ?? 'unknown',
    ...(row.purpose !== undefined ? { purpose: row.purpose } : {}),
    ...(row.errorStage !== undefined ? { errorStage: row.errorStage } : {}),
  }));
}

/** Latest formal error stage for one paper item across attempts in the authorized snapshot. */
export function latestItemErrorStage(snap: FlowGraphSnapshot, paperId: string, itemId: string): string | undefined {
  let found: { submittedAt: string; errorStage: string } | undefined;
  for (const fact of snap.factsById.values()) {
    if (fact.type !== workbookAttemptType) continue;
    let attempt: ReturnType<typeof workbookAttempt>;
    try { attempt = workbookAttempt(fact.data); } catch { continue; }
    if (attempt.paperId !== paperId) continue;
    const assessed = snap.assessmentsByKey.get(`${fact.id}:${itemId}`)?.errorStage;
    const feedbackStage = attempt.feedback.find(item => item.questionId === itemId)?.errorStage;
    const stage = typeof assessed === 'string' ? assessed : typeof feedbackStage === 'string' ? feedbackStage : undefined;
    if (stage !== undefined && (!found || attempt.submittedAt > found.submittedAt))
      found = { submittedAt: attempt.submittedAt, errorStage: stage };
  }
  return found?.errorStage;
}

export type BacktraceLoad =
  | { readonly kind: 'practice'; readonly result: DualBacktraceResult }
  | { readonly kind: 'ok'; readonly result: DualBacktraceResult };

/** Optional ULID-typed attempt exclusion for the backtrace target. */
export function excludeAttemptIdOf(raw: string | null): FactId | undefined {
  if (raw === null) return undefined;
  try { return factId(raw); } catch { throw new RequestError(400, '排除作答标识无效。'); }
}

/** Paper item lookup against the host read context; missing is 404 and denied is 403. */
export async function readPaperItem(
  read: Pick<ReadContext, 'fact'>, paperId: FactId, itemId: string,
): Promise<ReturnType<typeof workbookPaper>['questions'][number]> {
  let snapshot: FactSnapshot;
  try {
    snapshot = await read.fact(paperId, { mode: 'following' });
  } catch (error) {
    throw isFactReadDenied(error) && !isFactNotFound(error)
      ? new RequestError(403, '这份试卷当前不可读取。')
      : new RequestError(404, '这份试卷不存在。');
  }
  if (snapshot.type !== workbookPaperType) throw new RequestError(404, '这份试卷不存在。');
  const question = workbookPaper(snapshot.value).questions.find(item => item.id === itemId);
  if (!question) throw new RequestError(404, '这道题目不在该试卷中。');
  return question;
}

/** Load the dual backtrace for one paper item inside the authorized snapshot boundary. */
export async function loadPaperItemBacktrace(input: {
  readonly tx: ActivityEvidenceReadScope;
  readonly read: Pick<ReadContext, 'fact'>;
  readonly paperId: FactId;
  readonly itemId: string;
  readonly snap: FlowGraphSnapshot;
  readonly snapshots: ReadonlyMap<string, FactSnapshot>;
  readonly excludeAttemptId?: FactId;
  readonly unavailable: (error: unknown) => boolean;
  readonly practice: boolean;
}): Promise<BacktraceLoad> {
  const opened = await readPaperItem(input.read, input.paperId, input.itemId);
  const source = opened.sourceQuestionRef;
  const questionId = source ? (() => { try { return factId(source.id); } catch { return undefined; } })() : undefined;
  if (input.practice)
    return {
      kind: 'practice',
      result: {
        target: { ...(questionId !== undefined ? { questionId } : {}) },
        similarMistakes: [], independentSuccesses: [], excludedRevokedCount: 0,
      },
    };
  const rows = collectBacktraceRows(input.snap);
  const levels = await scanBacktraceHelpLevels(input.tx, input.read, rows, input.snapshots, input.unavailable);
  const errorStage = latestItemErrorStage(input.snap, input.paperId, input.itemId);
  return {
    kind: 'ok',
    result: buildDualBacktrace({
      target: {
        ...(questionId !== undefined ? { questionId } : {}),
        ...(errorStage !== undefined ? { errorStage } : {}),
        ...(input.excludeAttemptId !== undefined ? { excludeAttemptId: input.excludeAttemptId } : {}),
      },
      attempts: assembleBacktraceAttempts(rows, levels),
      edges: snapBacktraceEdges(input.snap), requiredPurpose: 'storage',
    }),
  };
}
