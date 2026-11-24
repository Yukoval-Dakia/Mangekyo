import type {ReadTransaction} from '@mangekyo/kernel';
import {parseManifest} from '@mangekyo/kernel';
import { factId, type FactId, type Tick } from '@mangekyo/kernel';
import type { Json } from '@mangekyo/kernel';


import { researchPurpose, researchSettingsType, researchWorksheetType, retentionReviewPermissionType } from './research.ts';
import { isWorksheetProfile, type WorkerConsent } from './worker-consent.ts';
import { completedWorksheetEvent, reviewDedupKey, summarizeReviewAttempt, worksheetInventoryItem } from './worksheet-policy.ts';

import type { TriageSnapshot } from './research-triage-snapshot.ts';
import { coverage, noop, projectResearchOverview, projectReviewTodo, researchTriageRequest, response, reviewAction, reviewGoal } from './research-triage-policy.ts';

export { researchDecision, reviewGoal } from './research-triage-policy.ts';

export type StudioResearchTriageDeps = Record<string, any> & { goalType: string; organizerTaskType: string; independentlyAuthoredPaper: any; workbookAttempt: any; workbookAttemptType: string; readLearningOverview: any; };

export function scoutEffectIdentity(settingsId: FactId, dedupKey: string) {
  return { ownerKind: 'session', ownerId: settingsId, stepKey: dedupKey, label: 'background-research-scout-v1' } as const;
}
const retrySheetLifetimeMs = 24 * 60 * 60 * 1000;
const recentWindow = 8;
const detailLimit = 4;

async function readDeltas(deps: StudioResearchTriageDeps, tx: ReadTransaction, reviewed: Tick) {
  const { rows } = await tx.query<{ id: string; type: string; rank: number }>(
    `SELECT id, type, rank::int FROM (
       SELECT id, type, changed_tick, row_number() OVER (PARTITION BY type ORDER BY changed_tick DESC, id) AS rank
       FROM facts WHERE learner_id = $1 AND type IN ($3, $4, $5, $6, $7, $10)
        AND (CASE WHEN type = $5 THEN created_tick ELSE changed_tick END) > $2::bigint
        AND $8 = ANY(purpose) AND retracted_rev IS NULL
     ) changed WHERE rank <= $9 ORDER BY changed_tick, id`,
    [tx.learner, reviewed, researchSettingsType, deps.workbookAttemptType, researchWorksheetType,
      deps.goalType, deps.organizerTaskType, researchPurpose, detailLimit + 1, retentionReviewPermissionType],
  );
  const events: Record<string, Json> = {};
  const read = deps.researchReader(tx);
  let discovery = false;
  let completed = 0;
  for (const row of rows) {
    if (row.rank > detailLimit) continue;
    if (row.type === researchWorksheetType) {
      const opened = await deps.readWorksheetById(tx, factId(row.id));
      if (!opened || !('todoId' in opened.worksheet) || !opened.worksheet.digest) continue;
      const { worksheet, fact } = opened;
      const todo = await deps.readTodo(tx, worksheet.todoId);
      if (todo?.state !== 'completed' || todo.resultId !== worksheet.id) continue;
      events[row.id] = completedWorksheetEvent(fact, worksheet, worksheet.digest, todo);
      completed++;
      continue;
    }
    const fact = await deps.whenAvailable(() => read.fact(factId(row.id), { mode: 'following' }));
    if (!fact?.purpose.includes(researchPurpose)) continue;
    const add = (kind: string, payload: Json) => {
      events[row.id] = { event_id: row.id, kind, fact_ref: fact.ref.id, fact_rev: fact.ref.rev, payload };
    };
    if (row.type === deps.goalType || row.type === deps.organizerTaskType) {
      add('goal_or_task_changed', { fact_type: row.type });
    } else {
      discovery = true;
      if (row.type === researchSettingsType) add('research_enabled', {});
      else if (row.type === retentionReviewPermissionType) {
        if (await deps.activeRetentionReview(tx, fact)) add('authorized_retention_miss', { status: 'missed' });
      } else add('authorized_attempt_changed', { submitted_at: deps.workbookAttempt(fact.value).submittedAt });
    }
  }
  const completionRows = rows.filter(row => row.type === researchWorksheetType).length;
  return { events, discovery: discovery || completed > 0, coverage: coverage(completed, completionRows, detailLimit) };
}

async function readResearchInventory(deps: StudioResearchTriageDeps, tx: ReadTransaction) {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM facts WHERE learner_id = $1 AND type = $2 AND $3 = ANY(purpose)
      AND retracted_rev IS NULL ORDER BY created_tick DESC, id LIMIT $4`,
    [tx.learner, researchWorksheetType, researchPurpose, detailLimit + 1],
  );
  const items: Record<string, Json> = {};
  for (const { id } of rows.slice(0, detailLimit)) {
    const opened = await deps.readWorksheetById(tx, factId(id));
    if (!opened) continue;
    const { worksheet } = opened;
    if ('todoId' in worksheet) {
      const todo = await deps.readTodo(tx, worksheet.todoId);
      if (todo?.state !== 'completed' || todo.resultId !== id) continue;
    }
    items[id] = worksheetInventoryItem(opened, deps.textSlice(worksheet.title, 0, 80).content);
  }
  return { items, coverage: coverage(Object.keys(items).length, rows.length, detailLimit) };
}

async function readReviewAttempts(deps: StudioResearchTriageDeps, tx: ReadTransaction, discovery: boolean, settingsRevision: number,
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
    [tx.learner, deps.workbookAttemptType, researchPurpose, recentWindow, discovery, retentionReviewPermissionType],
  );
  const facts: Record<string, Json> = {};
  let intent: any | undefined;
  let olderCandidate: Json | undefined;
  let paidCandidate: Json | undefined;
  const read = deps.researchReader(tx);
  for (const { id: rawId, recent } of rows) {
    if (!recent && intent) break;
    const id = factId(rawId);
    const fact = await deps.whenAvailable(() => read.fact(id, { mode: 'following' }));
    if (!fact) continue;
    const retention = fact.type === retentionReviewPermissionType;
    if (retention && !await deps.activeRetentionReview(tx, fact)) continue;
    const attempt = retention ? undefined : deps.workbookAttempt(fact.value);
    if (attempt?.paper.questions.some((question: any) => question.sourceQuestionRef)) continue;
    const anchor = retention ? deps.retentionReviewAnchor : attempt?.feedback.find((item: any) => item.result === 'incorrect')?.questionId;
    const independent = attempt && deps.independentlyAuthoredPaper(attempt.paper);
    if (discovery && !intent && anchor) {
      const eligibleLane = mode === 'paid' ? independent && await deps.independentScoutSource(tx, fact)
        : (mode === 'all-local' || !independent) && (!attempt || await deps.reviewMaterialAvailable(tx, attempt.paper));
      if (!eligibleLane) continue;
      const sourceFactRev = { id, revision: fact.ref.rev, accessEpoch: fact.accessEpoch, anchor };
      const dedupKey = reviewDedupKey(sourceFactRev);
      const known = await tx.query(
        `SELECT 1 FROM facts WHERE learner_id = $1 AND id = $2
         UNION ALL SELECT 1 FROM work WHERE family='todo' AND learner_id = $1 AND dedup_key = $3
          AND spec->'sourceFactRev' = $4::jsonb AND spec->>'settingsRevision' = $5 LIMIT 1`,
        [tx.learner, (await deps.worksheetPublication(tx, id, fact.ref.rev, fact.accessEpoch)).factId, dedupKey,
          JSON.stringify(sourceFactRev), String(settingsRevision)],
      );
      if (!known.rowCount && (!settingsId || await deps.canProcessPricedEffect(tx, scoutEffectIdentity(settingsId, dedupKey)))) intent = {
        dedupKey, workerProfile: 'deterministic_compute', trigger: { kind: 'immediate' },
        goal: reviewGoal, refs: [], sourceFactRev, settingsRevision, autonomyTier: 1, budgetCap: 0,
        expiresAtMs: now + retrySheetLifetimeMs,
      };
    }
    const summary = summarizeReviewAttempt(fact, attempt, anchor,
      attempt && deps.textSlice(attempt.paper.title, 0, 100).content);
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

export async function prepareResearchTriage(deps: StudioResearchTriageDeps, tx: ReadTransaction, reviewed: Tick, settingsRevision: number,
  now: number, paidConfigured: boolean, eligible: (spec: any) => Promise<boolean>) {
  const background = await readDeltas(deps, tx, reviewed);
  const foreground = await deps.readResearchForeground(tx, reviewed);
  const { events, discovery } = background;
  for (const event of foreground.events) events[event.event_id] = event;
  if (!Object.keys(events).length) return null;
  const { facts, intent, olderCandidate } = await readReviewAttempts(deps, tx, discovery, settingsRevision, now, paidConfigured ? 'free' : 'all-local');
  const { rows } = await tx.query<{ todo_id: string }>(
    `SELECT slot_key AS todo_id FROM work WHERE family='todo' AND learner_id = $1 AND state IN ('pending','ready','waiting')
     ORDER BY registered_tick DESC, todo_id LIMIT $2`, [tx.learner, recentWindow + 1],
  );
  const todos: Record<string, Json> = {};
  for (const { todo_id } of rows.slice(0, recentWindow)) {
    const todo = await deps.readTodo(tx, todo_id);
    if (!todo || !await eligible(todo.spec)) continue;
    todos[todo.id] = projectReviewTodo(todo);
  }
  const overview = projectResearchOverview(await deps.readLearningOverview(tx, {
    callerPurpose: researchPurpose, maySend: (_projection: any, fact: any) => fact.purpose.includes(researchPurpose),
  }), detailLimit, deps.textSlice);
  const inventory = await readResearchInventory(deps, tx);
  const retention = await deps.readRetentionRadar(tx, {
    callerPurpose: researchPurpose, maySend: (fact: any) => fact.purpose.includes(researchPurpose),
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

export async function preparePaidResearchTriage(deps: StudioResearchTriageDeps, tx: ReadTransaction, settingsId: FactId, settingsRevision: number, now: number, grant: WorkerConsent | null) {
  const { facts, intent, paidCandidate } = await readReviewAttempts(deps, tx, true, settingsRevision, now, 'paid', settingsId);
  if (!intent || !paidCandidate) return null;
  const action = reviewAction(intent.sourceFactRev.id, grant && isWorksheetProfile(grant.profile) ? grant.profile : undefined);
  const snapshot: TriageSnapshot = { facts, todos: {}, inventory: {}, forecasts: {}, memos: {}, work: {},
    signals: {}, events: {}, chain: null, budget: { remaining: 0 } };
  const { id, revision: rev, accessEpoch } = intent.sourceFactRev;
  const { rows: [clock] } = await tx.query<{ gather_tick: Tick }>('SELECT clock::text AS gather_tick FROM learners WHERE id=$1', [tx.learner]);
  const manifest = parseManifest({ version: 1, learner: tx.learner, purpose: researchPurpose,
    gatherTick: clock!.gather_tick, inputs: [{ kind: 'fact', id, rev, accessEpoch, mode: 'following' }] });
  return { snapshot, intent, action, manifest,
    paidInput: { candidate: paidCandidate, menu: [noop, action], response_format: response(noop) } };
}
