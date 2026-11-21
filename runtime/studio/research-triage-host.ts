import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId, type Tick } from '../../kernel/src/declarations/ids.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import type { Json } from '../../kernel/src/declarations/types.ts';
import { canProcessPricedEffect } from '../../kernel/src/work/effects.ts';
import { readTodo, type TodoSpec } from '../../kernel/src/work/todos.ts';
import { goalType } from '../../modules/plan/goal-values.ts';
import { organizerTaskType } from '../../modules/plan/organizer-task-values.ts';
import { independentlyAuthoredPaper, workbookAttempt, workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import {
  researchPurpose, researchSettingsType, researchWorksheetType, retentionReviewPermissionType,
} from '../../modules/companion/research.ts';
import { readLearningOverview } from './learning-overview.ts';
import { readRetentionRadar } from './learner-radar.ts';
import { textSlice } from './reading.ts';
import { readResearchForeground } from './research-foreground.ts';
import { activeRetentionReview, independentScoutSource, reviewMaterialAvailable, readWorksheetById, researchReader, retentionReviewAnchor, whenAvailable, worksheetId } from './research-sources.ts';
import type { TriageSnapshot } from './research-triage/snapshot.ts';
import { coverage, noop, researchTriageRequest, response, reviewAction, reviewGoal } from '../../modules/companion/research-triage-policy.ts';

export { researchDecision, reviewGoal } from '../../modules/companion/research-triage-policy.ts';

export function scoutEffectIdentity(settingsId: FactId, dedupKey: string) {
  return { ownerKind: 'session', ownerId: settingsId, stepKey: dedupKey, label: 'background-research-scout-v1' } as const;
}
const retrySheetLifetimeMs = 24 * 60 * 60 * 1000;
const recentWindow = 8;
const detailLimit = 4;

export function reviewDedupKey({ id, revision, accessEpoch }: TodoSpec['sourceFactRev']) {
  return 'review-attempt:' + id + ':' + revision + ':' + accessEpoch;
}

async function readDeltas(tx: ReadTransaction, reviewed: Tick) {
  const { rows } = await tx.query<{ id: string; type: string; rank: number }>(
    `SELECT id, type, rank::int FROM (
       SELECT id, type, changed_tick, row_number() OVER (PARTITION BY type ORDER BY changed_tick DESC, id) AS rank
       FROM facts WHERE learner_id = $1 AND type IN ($3, $4, $5, $6, $7, $10)
        AND (CASE WHEN type = $5 THEN created_tick ELSE changed_tick END) > $2::bigint
        AND $8 = ANY(purpose) AND retracted_rev IS NULL
     ) changed WHERE rank <= $9 ORDER BY changed_tick, id`,
    [tx.learner, reviewed, researchSettingsType, workbookAttemptType, researchWorksheetType,
      goalType, organizerTaskType, researchPurpose, detailLimit + 1, retentionReviewPermissionType],
  );
  const events: Record<string, Json> = {};
  const read = researchReader(tx);
  let discovery = false;
  let completed = 0;
  for (const row of rows) {
    if (row.rank > detailLimit) continue;
    if (row.type === researchWorksheetType) {
      const opened = await readWorksheetById(tx, factId(row.id));
      if (!opened || !('todoId' in opened.worksheet) || !opened.worksheet.digest) continue;
      const { worksheet, fact } = opened;
      const todo = await readTodo(tx, worksheet.todoId);
      if (todo?.state !== 'completed' || todo.resultId !== worksheet.id) continue;
      events[row.id] = { event_id: row.id, kind: 'work_completed', fact_ref: row.id, fact_rev: fact.ref.rev,
        payload: { todo_id: todo.id, chain_id: todo.chainId, hop_count: todo.hopCount, digest: worksheet.digest,
          source_fact_id: worksheet.source.attemptId, source_fact_rev: worksheet.source.revision,
          source_access_epoch: worksheet.source.accessEpoch } };
      completed++;
      continue;
    }
    const fact = await whenAvailable(() => read.fact(factId(row.id), { mode: 'following' }));
    if (!fact?.purpose.includes(researchPurpose)) continue;
    const add = (kind: string, payload: Json) => {
      events[row.id] = { event_id: row.id, kind, fact_ref: fact.ref.id, fact_rev: fact.ref.rev, payload };
    };
    if (row.type === goalType || row.type === organizerTaskType) {
      add('goal_or_task_changed', { fact_type: row.type });
    } else {
      discovery = true;
      if (row.type === researchSettingsType) add('research_enabled', {});
      else if (row.type === retentionReviewPermissionType) {
        if (await activeRetentionReview(tx, fact)) add('authorized_retention_miss', { status: 'missed' });
      } else add('authorized_attempt_changed', { submitted_at: workbookAttempt(fact.value).submittedAt });
    }
  }
  const completionRows = rows.filter(row => row.type === researchWorksheetType).length;
  return { events, discovery: discovery || completed > 0, coverage: coverage(completed, completionRows, detailLimit) };
}

async function readResearchInventory(tx: ReadTransaction) {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM facts WHERE learner_id = $1 AND type = $2 AND $3 = ANY(purpose)
      AND retracted_rev IS NULL ORDER BY created_tick DESC, id LIMIT $4`,
    [tx.learner, researchWorksheetType, researchPurpose, detailLimit + 1],
  );
  const items: Record<string, Json> = {};
  for (const { id } of rows.slice(0, detailLimit)) {
    const opened = await readWorksheetById(tx, factId(id));
    if (!opened) continue;
    const { worksheet, fact } = opened;
    const source = worksheet.source;
    if ('todoId' in worksheet) {
      const todo = await readTodo(tx, worksheet.todoId);
      if (todo?.state !== 'completed' || todo.resultId !== id) continue;
    }
    items[id] = { inventory_id: id, kind: 'research_worksheet', status: 'ready', usage: 'unknown',
      revision: fact.ref.rev, access_epoch: fact.accessEpoch, title: textSlice(worksheet.title, 0, 80).content,
      source_fact_id: source.attemptId, source_fact_rev: String(source.revision), source_access_epoch: source.accessEpoch,
      href: opened.source ? `/api/papers/${opened.source.paperId}/attempts/${source.attemptId}/research` : source.href };
  }
  return { items, coverage: coverage(Object.keys(items).length, rows.length, detailLimit) };
}

async function readResearchOverview(tx: ReadTransaction) {
  const { goal, tasks } = await readLearningOverview(tx, {
    callerPurpose: researchPurpose,
    maySend: (_projection, fact) => fact.purpose.includes(researchPurpose),
  });
  const goalText = goal.state === 'set' && goal.text !== null ? textSlice(goal.text, 0, 240) : null;
  return {
    goal: goalText ? { ...goal, text: goalText.content, truncated: goalText.nextOffset !== null } : goal,
    tasks: 'items' in tasks ? {
      state: tasks.items.length > detailLimit ? 'partial' : tasks.state,
      items: tasks.items.slice(0, detailLimit).map((task, index) => ({
        ...task, title: textSlice(task.title, 0, 80).content, witness: tasks.witnesses[index],
      })),
    } : { state: tasks.state === 'empty' ? 'unknown' : tasks.state },
  };
}

async function readReviewAttempts(tx: ReadTransaction, discovery: boolean, settingsRevision: number,
  now: number, mode: 'all-local' | 'free' | 'paid', settingsId?: FactId) {
  const { rows } = await tx.query<{ id: string; recent: boolean }>(
    `WITH attempts AS (
       SELECT f.id, f.type, f.created_tick, r.data, row_number() OVER (ORDER BY f.created_tick DESC, f.id) <= $4 AS recent
       FROM facts f JOIN fact_revs r ON (r.learner_id, r.fact_id, r.rev) = (f.learner_id, f.id, f.current_rev)
       WHERE f.learner_id = $1 AND f.type IN ($2, $6) AND $3 = ANY(f.purpose) AND $3 = ANY(r.purpose)
         AND f.retracted_rev IS NULL
     ) SELECT id, recent FROM attempts
     WHERE (type=$2 AND (recent OR ($5 AND data @> '{"feedback":[{"result":"incorrect"}]}')))
        OR (type=$6 AND $5 AND data @> '{"allowed":true}')
     ORDER BY created_tick DESC, id`,
    [tx.learner, workbookAttemptType, researchPurpose, recentWindow, discovery, retentionReviewPermissionType],
  );
  const facts: Record<string, Json> = {};
  let intent: TodoSpec | undefined;
  let olderCandidate: Json | undefined;
  let paidCandidate: Json | undefined;
  const read = researchReader(tx);
  for (const { id: rawId, recent } of rows) {
    if (!recent && intent) break;
    const id = factId(rawId);
    const fact = await whenAvailable(() => read.fact(id, { mode: 'following' }));
    if (!fact) continue;
    const retention = fact.type === retentionReviewPermissionType;
    if (retention && !await activeRetentionReview(tx, fact)) continue;
    const attempt = retention ? undefined : workbookAttempt(fact.value);
    if (attempt?.paper.questions.some(question => question.sourceQuestionRef)) continue;
    const anchor = retention ? retentionReviewAnchor : attempt?.feedback.find(item => item.result === 'incorrect')?.questionId;
    const independent = attempt && independentlyAuthoredPaper(attempt.paper);
    if (discovery && !intent && anchor) {
      const eligibleLane = mode === 'paid' ? independent && await independentScoutSource(tx, fact)
        : (mode === 'all-local' || !independent) && (!attempt || await reviewMaterialAvailable(tx, attempt.paper));
      if (!eligibleLane) continue;
      const sourceFactRev = { id, revision: fact.ref.rev, accessEpoch: fact.accessEpoch, anchor };
      const dedupKey = reviewDedupKey(sourceFactRev);
      const known = await tx.query(
        `SELECT 1 FROM facts WHERE learner_id = $1 AND id = $2
         UNION ALL SELECT 1 FROM work WHERE family='todo' AND learner_id = $1 AND dedup_key = $3
          AND spec->'sourceFactRev' = $4::jsonb AND spec->>'settingsRevision' = $5 LIMIT 1`,
        [tx.learner, worksheetId(id, fact.ref.rev, fact.accessEpoch), dedupKey,
          JSON.stringify(sourceFactRev), String(settingsRevision)],
      );
      if (!known.rowCount && (!settingsId || await canProcessPricedEffect(tx, scoutEffectIdentity(settingsId, dedupKey)))) intent = {
        dedupKey, workerProfile: 'deterministic_compute', trigger: { kind: 'immediate' },
        goal: reviewGoal, refs: [], sourceFactRev, settingsRevision, autonomyTier: 1, budgetCap: 0,
        expiresAtMs: now + retrySheetLifetimeMs,
      };
    }
    const summary = {
      id, rev: fact.ref.rev, fact_type: fact.type, access_epoch: fact.accessEpoch, retracted_rev: 0,
      purpose: researchPurpose, data: attempt
        ? { submitted_at: attempt.submittedAt, title: textSlice(attempt.paper.title, 0, 100).content,
          first_incorrect_question: anchor ? attempt.paper.questions.findIndex(item => item.id === anchor) + 1 : null }
        : { status: 'missed', observation: 'independent' },
    };
    if (mode === 'paid' && intent?.sourceFactRev.id === id) {
      paidCandidate = summary.data;
      facts[id] = summary;
      break;
    }
    if (recent) facts[id] = summary;
    else if (intent?.sourceFactRev.id === id) olderCandidate = summary;
  }
  return { facts, intent, olderCandidate, paidCandidate };
}

export async function prepareResearchTriage(tx: ReadTransaction, reviewed: Tick, settingsRevision: number,
  now: number, paidConfigured: boolean, eligible: (spec: TodoSpec) => Promise<boolean>) {
  const background = await readDeltas(tx, reviewed);
  const foreground = await readResearchForeground(tx, reviewed);
  const { events, discovery } = background;
  for (const event of foreground.events) events[event.event_id] = event;
  if (!Object.keys(events).length) return null;
  const { facts, intent, olderCandidate } = await readReviewAttempts(tx, discovery, settingsRevision, now, paidConfigured ? 'free' : 'all-local');
  const { rows } = await tx.query<{ todo_id: string }>(
    `SELECT slot_key AS todo_id FROM work WHERE family='todo' AND learner_id = $1 AND state IN ('pending','ready','waiting')
     ORDER BY registered_tick DESC, todo_id LIMIT $2`, [tx.learner, recentWindow + 1],
  );
  const todos: Record<string, Json> = {};
  for (const { todo_id } of rows.slice(0, recentWindow)) {
    const todo = await readTodo(tx, todo_id);
    if (!todo || !await eligible(todo.spec)) continue;
    const { spec } = todo;
    todos[todo.id] = { todo_id: todo.id, dedup_key: spec.dedupKey,
      status: spec.trigger.kind === 'scheduled' && todo.state === 'pending' ? 'scheduled' : 'pending',
      dispatch_state: todo.state, trigger: spec.trigger.kind, source_fact_id: spec.sourceFactRev.id,
      source_fact_rev: String(spec.sourceFactRev.revision), autonomy_tier: spec.autonomyTier,
      ...(spec.trigger.kind === 'scheduled' ? { fire_at_ms: spec.trigger.fireAtMs } : {}),
      ...(spec.trigger.kind === 'event' ? { event_type: spec.trigger.event.type } : {}),
      worker_profile: spec.workerProfile, goal: spec.goal };
  }
  const overview = await readResearchOverview(tx);
  const inventory = await readResearchInventory(tx);
  const retention = await readRetentionRadar(tx, {
    callerPurpose: researchPurpose, maySend: fact => fact.purpose.includes(researchPurpose),
  }, { limitPerKind: 1 });
  const prefix = { facts, todos, inventory: inventory.items, forecasts: {}, memos: {}, work: {}, signals: {},
    chain: null, budget: { remaining: 0 } };
  const snapshot: TriageSnapshot = {
    ...prefix, events, facts: intent && olderCandidate ? { ...facts, [intent.sourceFactRev.id]: olderCandidate } : facts,
  };
  const action = intent && reviewAction(intent.sourceFactRev.id);
  const request = researchTriageRequest({ prefix, events, olderCandidate, settingsRevision, overview, retention, recentWindow,
    todoCoverage: coverage(Object.keys(todos).length, rows.length, recentWindow), inventoryCoverage: inventory.coverage,
    foregroundCoverage: foreground.coverage, backgroundCoverage: background.coverage, action });
  return { snapshot, request, intent, action };
}

export async function preparePaidResearchTriage(tx: ReadTransaction, settingsId: FactId, settingsRevision: number, now: number) {
  const { facts, intent, paidCandidate } = await readReviewAttempts(tx, true, settingsRevision, now, 'paid', settingsId);
  if (!intent || !paidCandidate) return null;
  const action = reviewAction(intent.sourceFactRev.id);
  const snapshot: TriageSnapshot = { facts, todos: {}, inventory: {}, forecasts: {}, memos: {}, work: {},
    signals: {}, events: {}, chain: null, budget: { remaining: 0 } };
  const { id, revision: rev, accessEpoch } = intent.sourceFactRev;
  const { rows: [clock] } = await tx.query<{ gather_tick: Tick }>('SELECT clock::text AS gather_tick FROM learners WHERE id=$1', [tx.learner]);
  const manifest = parseManifest({ version: 1, learner: tx.learner, purpose: researchPurpose,
    gatherTick: clock!.gather_tick, inputs: [{ kind: 'fact', id, rev, accessEpoch, mode: 'following' }] });
  return { snapshot, intent, action, manifest,
    paidInput: { candidate: paidCandidate, menu: [noop, action], response_format: response(noop) } };
}
