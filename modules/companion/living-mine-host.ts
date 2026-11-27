import { stableId } from '@mangekyo/kernel';
import type { FactId, Json, ReadTransaction, Revision } from '@mangekyo/kernel';
import {
  buildLivingMineRadar, selectWarmBackfillBatch, MAX_MAINTENANCE_BUDGET_RATIO,
  type DerivationWatermarkTarget, type LivingMineExamConceptInput, type LivingMineHighConfMissInput,
  type LivingMineRadarInput, type LivingMineStaleItemInput, type LivingMineSupplyConceptInput,
} from './living-mine-radar.ts';
import { evaluatePlaybookEffectiveness, type PlaybookEffectivenessEntryInput } from '@mangekyo/module-learner/facts/playbook-effectiveness';

/** Foreground teaching/class sessions occupy pending/ready/waiting work rows under teaching slots or activity derivers. */
export async function scanForegroundActive(tx: ReadTransaction): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM work WHERE learner_id=$1 AND state IN ('pending','ready','waiting')
       AND (slot_type IN ('activity.teachingFeedback','activity.studyFeedback') OR deriver LIKE 'activity/%') LIMIT 1`,
    [tx.learner]);
  return rows.length > 0;
}

/** Query all active sticky-protected fact ids for the current learner. */
export async function scanStickyFactIds(tx: ReadTransaction): Promise<Set<string>> {
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM facts WHERE learner_id=$1 AND sticky=TRUE AND retracted_rev IS NULL',
    [tx.learner]);
  return new Set(rows.map(row => row.id));
}

type SourceUseRef = { id: string; rev: number; accessEpoch?: string | number };
type VerifySourceUse = (use: SourceUseRef, type: string) => Promise<boolean>;

function collectUses(data: unknown, out: SourceUseRef[] = []): SourceUseRef[] {
  if (Array.isArray(data)) { for (const item of data) collectUses(item, out); return out; }
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    const epoch = typeof rec.accessEpoch === 'string' || typeof rec.accessEpoch === 'number' ? rec.accessEpoch : rec.epoch;
    if (typeof rec.id === 'string' && typeof rec.rev === 'number' && (typeof epoch === 'string' || typeof epoch === 'number')) {
      out.push({ id: rec.id, rev: rec.rev, accessEpoch: epoch });
    }
    for (const value of Object.values(rec)) collectUses(value, out);
  }
  return out;
}

/**
 * Verify every witness reference both locally (not retracted, not tombstoned, storage/all purpose,
 * matching access_epoch, rev exists) and transitively through upstream capture/Notion authorization.
 */
async function allWitnessesAuthorized(
  tx: ReadTransaction,
  data: unknown,
  factType: string,
  verify?: VerifySourceUse,
  visited = new Set<string>(),
): Promise<boolean> {
  for (const use of collectUses(data)) {
    const visitKey = `${use.id}:${use.rev}:${use.accessEpoch ?? ''}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    if (verify && !(await verify(use, factType))) return false;
    const { rows: [row] } = await tx.query<{
      type: string; accessEpoch: string; purpose: string[]; retracted: boolean; data: unknown;
    }>(
      `SELECT f.type, f.access_epoch::text AS "accessEpoch", f.purpose,
         (f.retracted_rev IS NOT NULL OR EXISTS(SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)) AS retracted,
         r.data
       FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,$3)
       WHERE f.learner_id=$1 AND f.id=$2`,
      [tx.learner, use.id, use.rev]);
    if (!row || row.retracted || !(row.purpose.includes('storage') || row.purpose.includes('all'))) return false;
    if (use.accessEpoch !== undefined && row.accessEpoch !== String(use.accessEpoch)) return false;
    if (!(await allWitnessesAuthorized(tx, row.data, row.type, verify, visited))) return false;
  }
  return true;
}

export async function scanPlaybookEntries(
  tx: ReadTransaction,
  verifyContent?: VerifySourceUse,
): Promise<PlaybookEffectivenessEntryInput[]> {
  const { rows } = await tx.query(
    `SELECT f.id, f.current_rev AS rev, f.sticky, r.data FROM facts f
       JOIN fact_revs r ON (r.learner_id, r.fact_id, r.rev) = (f.learner_id, f.id, f.current_rev)
     WHERE f.learner_id=$1 AND f.type='learner.playbook' AND f.retracted_rev IS NULL
       AND ('storage' = ANY(f.purpose) OR 'all' = ANY(f.purpose))
       AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)`,
    [tx.learner]);
  const { rows: liftRows } = await tx.query(
    `SELECT d.slot_key, d.value, d.id AS derivation_id FROM derivations d
       JOIN slot_state s ON (s.learner_id, s.slot_type, s.slot_key, s.current_id) = (d.learner_id, d.slot_type, d.slot_key, d.id)
     WHERE d.learner_id=$1 AND d.slot_type='learner.interventionLift' AND d.lifecycle='effective'`,
    [tx.learner]);
  const liftsByKey = new Map<string, { value: unknown; derivationId: string }>();
  for (const row of liftRows as { slot_key: string; value: unknown; derivation_id: string }[]) {
    const value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    liftsByKey.set(row.slot_key, { value, derivationId: row.derivation_id });
  }
  const entries: PlaybookEffectivenessEntryInput[] = [];
  for (const row of rows as { id: string; rev: number; sticky: boolean; data: Record<string, unknown> }[]) {
    const data = row.data;
    if (!(await allWitnessesAuthorized(tx, data, 'learner.playbook', verifyContent))) continue;
    const version = typeof data.version === 'number' ? data.version : 1;
    const strategyId = typeof data.strategyId === 'string' ? data.strategyId : '';
    const steps = Array.isArray(data.strategy_steps) ? data.strategy_steps : [];
    const title = typeof steps[0] === 'string' && steps[0].trim() ? steps[0].slice(0, 60) : strategyId || row.id;
    const lift = liftsByKey.get(JSON.stringify([row.id, version]));
    const outcome = lift?.value as { kind?: string; value?: Record<string, unknown> } | undefined;
    const rawLiftValue = outcome?.kind === 'value' ? outcome.value as Record<string, unknown> : undefined;
    const liftAuthorized = rawLiftValue === undefined ||
      await allWitnessesAuthorized(tx, rawLiftValue, 'learner.interventionLift', verifyContent);
    const liftValue = liftAuthorized ? rawLiftValue : undefined;
    const matchesIdentity = liftValue !== undefined &&
      liftValue.playbookId === row.id && liftValue.version === version && liftValue.strategyId === strategyId;
    const eligible = matchesIdentity && typeof liftValue?.eligible === 'number' ? liftValue.eligible : 0;
    const unresolved = matchesIdentity && typeof liftValue?.unresolved === 'number' ? liftValue.unresolved : 0;
    const pending = matchesIdentity && typeof liftValue?.pending === 'number' ? liftValue.pending : 0;
    entries.push({
      playbookId: row.id as FactId, version: version as Revision, strategyId, title,
      ...(row.sticky ? { sticky: true } : {}),
      ...(lift && outcome && liftAuthorized ? { precomputedLift: outcome as never } : {}),
      usage: { deliveredCount: eligible + unresolved + pending, openedCount: eligible + unresolved, posttestCompletedCount: eligible },
      expectedRev: row.rev as Revision,
      ...(lift && liftAuthorized ? { liftId: lift.derivationId } : {}),
    });
  }
  return entries;
}

export function evaluatePlaybookHost(entries: readonly PlaybookEffectivenessEntryInput[], carePaused: boolean) {
  if (carePaused) {
    return {
      carePaused: true,
      verifiedPlaybooks: [], demotedStrategies: [], inconclusive: [],
      summary: { totalCount: entries.length, verifiedCount: 0, demotedCount: 0, inconclusiveCount: 0 },
      honestyNote: '关怀熔断期间不产出任何教法推荐或退场建议。',
    };
  }
  return { carePaused: false, ...evaluatePlaybookEffectiveness(entries) };
}

export function playbookRetireProposals(report: ReturnType<typeof evaluatePlaybookEffectiveness>) {
  const out: {
    proposalId: string; playbookId: string; expectedRev: number; version: number; liftId: string;
    sticky: boolean; title: string; summary: string;
  }[] = [];
  for (const item of report.demotedStrategies) {
    const proposal = item.gardeningProposal;
    if (!proposal) continue;
    out.push({
      proposalId: `yellow:retire_playbook:${proposal.dedupKey}`,
      playbookId: proposal.playbookId, expectedRev: proposal.expectedRev,
      version: proposal.version, liftId: proposal.liftId,
      sticky: item.stickyProtected,
      title: `退场负向教法：${item.title}`, summary: proposal.reason,
    });
  }
  return out;
}

/** Load active playbook retire proposals and sticky-protected playbook ids in one pass. */
export async function loadPlaybookRetireContext(tx: ReadTransaction, verify: VerifySourceUse, carePaused: boolean) {
  const entries = await scanPlaybookEntries(tx, verify);
  return {
    proposals: playbookRetireProposals(evaluatePlaybookHost(entries, carePaused)),
    stickyIds: new Set(entries.filter(entry => entry.sticky === true).map(entry => entry.playbookId as string)),
  };
}

type KbEntropyInput = NonNullable<LivingMineRadarInput['kbEntropyRadar']>;

function extractQuestionRefIds(data: Record<string, unknown>): string[] {
  const paper = (data.paper && typeof data.paper === 'object' ? data.paper : data) as Record<string, unknown>;
  const qs = Array.isArray(paper.questions) ? paper.questions : [];
  const ids: string[] = [];
  for (const item of qs) {
    if (!item || typeof item !== 'object') continue;
    const ref = (item as Record<string, unknown>).sourceQuestionRef as { id?: unknown } | undefined;
    if (typeof ref?.id === 'string' && ref.id.length === 26) ids.push(ref.id);
  }
  return ids;
}

/** Scan radar inputs with honest kernel evidence and full authorization + exposure tracking. */
export async function scanLivingMineInputs(
  tx: ReadTransaction,
  kbEntropyRadar: KbEntropyInput | undefined,
  verifyContent?: VerifySourceUse,
  { nowMs = Date.now() }: { nowMs?: number } = {},
): Promise<{
  examConcepts: LivingMineExamConceptInput[];
  highConfidenceMisses: LivingMineHighConfMissInput[];
  supplyConcepts: LivingMineSupplyConceptInput[];
  derivationTargets: DerivationWatermarkTarget[];
  staleInventoryItems: LivingMineStaleItemInput[];
}> {
  const [{ rows: attemptRows }, { rows: paperRows }, { rows: edgeRows }, { rows: conceptRows }] = await Promise.all([
    tx.query(
      `SELECT f.id, r.data FROM facts f
         JOIN fact_revs r ON (r.learner_id, r.fact_id, r.rev) = (f.learner_id, f.id, f.current_rev)
       WHERE f.learner_id=$1 AND f.type='activity.workbookAttempt' AND f.retracted_rev IS NULL
         AND ('storage' = ANY(f.purpose) OR 'all' = ANY(f.purpose))
         AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
       ORDER BY f.changed_tick DESC LIMIT 200`,
      [tx.learner]),
    tx.query(
      `SELECT r.data FROM facts f
         JOIN fact_revs r ON (r.learner_id, r.fact_id, r.rev) = (f.learner_id, f.id, f.current_rev)
       WHERE f.learner_id=$1 AND f.type='activity.workbookPaper' AND f.retracted_rev IS NULL
         AND ('storage' = ANY(f.purpose) OR 'all' = ANY(f.purpose))
         AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)`,
      [tx.learner]),
    tx.query(
      `SELECT r.data FROM facts f
         JOIN fact_revs r ON (r.learner_id, r.fact_id, r.rev) = (f.learner_id, f.id, f.current_rev)
       WHERE f.learner_id=$1 AND f.type='content.knowledgeEdge' AND f.retracted_rev IS NULL
         AND ('storage' = ANY(f.purpose) OR 'all' = ANY(f.purpose))
         AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)`,
      [tx.learner]),
    tx.query(
      `SELECT f.id, r.data FROM facts f
         JOIN fact_revs r ON (r.learner_id, r.fact_id, r.rev) = (f.learner_id, f.id, f.current_rev)
       WHERE f.learner_id=$1 AND f.type='content.asset' AND f.retracted_rev IS NULL
         AND ('storage' = ANY(f.purpose) OR 'all' = ANY(f.purpose))
         AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
         AND r.data->>'kind' = 'concept'`,
      [tx.learner]),
  ]);

  const exposedQuestionIds = new Set<string>();
  for (const row of paperRows as { data: Record<string, unknown> }[]) {
    if (!(await allWitnessesAuthorized(tx, row.data, 'activity.workbookPaper', verifyContent))) continue;
    for (const qId of extractQuestionRefIds(row.data ?? {})) exposedQuestionIds.add(qId);
  }
  const highConfidenceMisses: LivingMineHighConfMissInput[] = [];
  for (const row of attemptRows as { id: string; data: Record<string, unknown> }[]) {
    if (!(await allWitnessesAuthorized(tx, row.data, 'activity.workbookAttempt', verifyContent))) continue;
    for (const qId of extractQuestionRefIds(row.data ?? {})) exposedQuestionIds.add(qId);
    const data = row.data;
    const feedback = data.feedback;
    const items = Array.isArray(feedback) ? feedback : Array.isArray(data.items) ? data.items as unknown[] : [];
    for (const item of items as Record<string, unknown>[]) {
      if (item?.result !== 'incorrect') continue;
      highConfidenceMisses.push({
        attemptId: row.id,
        ...(typeof item.questionId === 'string' ? { itemId: item.questionId } : {}),
        ...(typeof item.errorStage === 'string' ? { reasonLabel: item.errorStage } : {}),
      });
    }
    if (!items.length && (data.verdict === 'incorrect' || data.result === 'incorrect'))
      highConfidenceMisses.push({ attemptId: row.id });
  }

  const questionsByConcept = new Map<string, Set<string>>();
  for (const row of edgeRows as { data: Record<string, unknown> }[]) {
    if (!(await allWitnessesAuthorized(tx, row.data, 'content.knowledgeEdge', verifyContent))) continue;
    const data = row.data;
    if (data.kind !== 'targets_concept') continue;
    const fromId = ((data.from as Record<string, unknown> | undefined)?.sourceUse as { id?: string } | undefined)?.id;
    const toId = ((data.to as Record<string, unknown> | undefined)?.sourceUse as { id?: string } | undefined)?.id;
    if (!fromId || !toId) continue;
    let set = questionsByConcept.get(toId);
    if (!set) questionsByConcept.set(toId, set = new Set());
    set.add(fromId);
  }

  const supplyConcepts: LivingMineSupplyConceptInput[] = [];
  const examConcepts: LivingMineExamConceptInput[] = [];
  for (const row of conceptRows as { id: string; data: Record<string, unknown> }[]) {
    if (!(await allWitnessesAuthorized(tx, row.data, 'content.asset', verifyContent))) continue;
    if (typeof row.data.merged_into === 'string') continue;
    const title = typeof row.data.title === 'string' ? row.data.title : row.id;
    const qIds = questionsByConcept.get(row.id);
    const total = qIds?.size ?? 0;
    let exposed = 0;
    if (qIds) for (const qId of qIds) if (exposedQuestionIds.has(qId)) exposed += 1;
    supplyConcepts.push({ id: row.id, title, totalQuestionCount: total, unexposedVariantCount: Math.max(0, total - exposed) });
    // Omit attemptCount so buildLivingMineRadar reads real flow.attempts.length instead of masking mastered concepts.
    examConcepts.push({ id: row.id, title });
  }

  const derivationTargets: DerivationWatermarkTarget[] = [];
  const staleInventoryItems: LivingMineStaleItemInput[] = (kbEntropyRadar?.staleUnusedDrafts ?? []).map(draft => ({
    id: draft.assetId, kind: draft.assetKind, title: draft.title, ageDays: draft.ageDays,
    ...(draft.sticky !== undefined ? { sticky: draft.sticky } : {}),
    ...(draft.hasUserAuthoredContent !== undefined ? { hasUserAuthoredContent: draft.hasUserAuthoredContent } : {}),
  }));
  void nowMs;
  return { examConcepts, highConfidenceMisses, supplyConcepts, derivationTargets, staleInventoryItems };
}

export function buildLivingMineRadarHost(
  input: Omit<LivingMineRadarInput, 'kbEntropyRadar'> & { kbEntropyRadar?: KbEntropyInput },
  foregroundActive: boolean,
) {
  const radar = buildLivingMineRadar(input);
  const warmBackfillBatch = selectWarmBackfillBatch(radar.metrics.warm_backfill_queue.candidates, {
    foregroundActive, budgetShare: MAX_MAINTENANCE_BUDGET_RATIO,
  });
  return { radar, warmBackfillBatch, foregroundActive, maintenanceBudgetCapRatio: MAX_MAINTENANCE_BUDGET_RATIO };
}

export function createNotionFlowInclude<Fact>(
  verifyFact: (fact: Fact) => Promise<unknown>,
  checks: { readonly isUnavailable: (e: unknown) => boolean; readonly isNotionUnconfirmed: (e: unknown) => boolean },
) {
  let unconfirmed: unknown;
  const include = async (_tx: ReadTransaction, fact: Fact): Promise<boolean> => {
    try {
      await verifyFact(fact);
      return true;
    } catch (error) {
      if (checks.isNotionUnconfirmed(error)) unconfirmed = error;
      else if (!checks.isUnavailable(error)) throw error;
      return false;
    }
  };
  return {
    include,
    assertConfirmed() { if (unconfirmed) throw unconfirmed; },
  };
}

export async function readLivingMineRadarHost(
  tx: ReadTransaction,
  input: {
    readonly snap: LivingMineRadarInput['snap'];
    readonly carePaused: boolean;
    readonly kbEntropyRadar: KbEntropyInput;
    readonly verifyContent?: VerifySourceUse;
  },
) {
  const [scanned, foregroundActive] = await Promise.all([
    scanLivingMineInputs(tx, input.kbEntropyRadar, input.verifyContent),
    scanForegroundActive(tx),
  ]);
  return buildLivingMineRadarHost({
    snap: input.snap, generatedAt: new Date().toISOString(), carePaused: input.carePaused,
    ...scanned, kbEntropyRadar: input.kbEntropyRadar,
  }, foregroundActive);
}

export type MaintenanceCompressionCandidate = {
  readonly candidateKey: string; readonly targetKind: 'chapter' | 'concept'; readonly targetId: string;
  readonly targetTitle: string; readonly noteCount: number; readonly noteIds: readonly string[];
  readonly noteSummaries: readonly string[]; readonly recommendedArtifact: 'emergency_card' | 'decision_tree';
  readonly hasUserAuthoredPage: boolean; readonly sticky: boolean;
};
type FlowSnapshotFact = {
  readonly ref: { readonly id: string; readonly rev: number };
  readonly type: string; readonly value: unknown; readonly purpose: readonly string[];
  readonly sticky?: boolean;
};

/** Gather compression candidates from an authorized flow snapshot with real sticky fact ids. */
export function gatherCompressionCandidates(
  snapshots: ReadonlyMap<string, FlowSnapshotFact>, purpose: string,
  stickyIds: ReadonlySet<string> = new Set(), minNotes = 3,
): MaintenanceCompressionCandidate[] {
  const notesByTarget = new Map<string, {
    targetKind: 'chapter' | 'concept'; targetId: string; notes: { id: string; summary: string; sticky: boolean }[];
  }>();
  for (const fact of snapshots.values()) {
    if (fact.type !== 'activity.organizerNote' || !fact.purpose.includes(purpose) && !fact.purpose.includes('all')) continue;
    const data = fact.value as Record<string, unknown>;
    const source = data.source as { id?: string } | null | undefined;
    if (!source?.id) continue;
    const target = snapshots.get(source.id);
    const targetKind: 'chapter' | 'concept' = target?.type === 'content.textbookPage' ? 'chapter' : 'concept';
    const key = `${targetKind}:${source.id}`;
    let group = notesByTarget.get(key);
    if (!group) notesByTarget.set(key, group = { targetKind, targetId: source.id, notes: [] });
    group.notes.push({
      id: fact.ref.id,
      summary: String(data.markdown ?? data.title ?? fact.ref.id).slice(0, 240),
      sticky: stickyIds.has(fact.ref.id) || fact.sticky === true,
    });
  }
  const candidates: MaintenanceCompressionCandidate[] = [];
  for (const [candidateKey, group] of notesByTarget) {
    if (group.notes.length < minNotes) continue;
    const sorted = [...group.notes].sort((l, r) => l.id < r.id ? -1 : l.id > r.id ? 1 : 0);
    const target = snapshots.get(group.targetId);
    const targetData = (target?.value ?? {}) as Record<string, unknown>;
    const tags = Array.isArray(targetData.tags) ? targetData.tags : [];
    const hasUserAuthoredPage = group.targetKind === 'chapter' && target?.type === 'content.textbookPage' &&
      !tags.includes('studio:companion-generated');
    candidates.push({
      candidateKey, targetKind: group.targetKind, targetId: group.targetId,
      targetTitle: String(targetData.title ?? group.targetId), noteCount: sorted.length,
      noteIds: sorted.map(note => note.id), noteSummaries: sorted.map(note => note.summary),
      recommendedArtifact: group.targetKind === 'concept' && sorted.length >= 5 ? 'decision_tree' : 'emergency_card',
      hasUserAuthoredPage: hasUserAuthoredPage === true,
      sticky: stickyIds.has(group.targetId) || target?.sticky === true || sorted.some(note => note.sticky),
    });
  }
  candidates.sort((l, r) => r.noteCount - l.noteCount || (l.candidateKey < r.candidateKey ? -1 : 1));
  return candidates;
}

export type ReinterpretationEvidence = {
  readonly pattern: { readonly id: string; readonly label: string; readonly errorStage: string; readonly errorStageLabel: string };
  readonly attempts: readonly { readonly attemptId: string; readonly questionId?: string; readonly verdict?: string; readonly errorStage?: string; readonly sticky?: boolean; readonly lockedStickySlots?: readonly string[] }[];
};
export function gatherReinterpretationEvidence(
  snapshots: ReadonlyMap<string, FlowSnapshotFact>, purpose: string,
  stickyIds: ReadonlySet<string> = new Set(), minAttempts = 3,
): ReinterpretationEvidence | null {
  const byStage = new Map<string, { attemptId: string; questionId?: string; verdict?: string; errorStage?: string }[]>();
  for (const fact of snapshots.values()) {
    if (fact.type !== 'activity.workbookAttempt' || !fact.purpose.includes(purpose) && !fact.purpose.includes('all')) continue;
    if (stickyIds.has(fact.ref.id) || fact.sticky === true) continue;
    const data = fact.value as Record<string, unknown>;
    const rawFeedback = data.feedback;
    const feedbackItems = Array.isArray(rawFeedback) ? rawFeedback as Record<string, unknown>[]
      : rawFeedback && typeof rawFeedback === 'object' ? [rawFeedback as Record<string, unknown>] : [];
    const wrong = feedbackItems.find(item => item?.result === 'incorrect');
    if (!wrong) continue;
    const stage = typeof wrong.errorStage === 'string' && wrong.errorStage.trim() ? wrong.errorStage : 'unknown';
    let list = byStage.get(stage);
    if (!list) byStage.set(stage, list = []);
    if (list.length >= 12) continue;
    const paper = data.paper as Record<string, unknown> | undefined;
    const firstQuestion = Array.isArray(paper?.questions) ? paper?.questions[0] as Record<string, unknown> | undefined : undefined;
    list.push({
      attemptId: fact.ref.id,
      ...(typeof firstQuestion?.sourceQuestionRef === 'object' && firstQuestion.sourceQuestionRef !== null
        && typeof (firstQuestion.sourceQuestionRef as { id?: unknown }).id === 'string'
        ? { questionId: (firstQuestion.sourceQuestionRef as { id: string }).id } : {}),
      verdict: 'incorrect', errorStage: stage,
    });
  }
  const [stage, attempts] = [...byStage.entries()].filter(([, list]) => list.length >= minAttempts)
    .sort((l, r) => r[1].length - l[1].length || (l[0] < r[0] ? -1 : 1))[0] ?? [];
  if (!stage || !attempts) return null;
  return {
    pattern: { id: `error-stage:${stage}`, label: `高频错因阶段：${stage}`, errorStage: stage, errorStageLabel: stage },
    attempts: attempts.map(attempt => ({ ...attempt, errorStage: stage })),
  };
}

export function compressionCandidateAllowed(candidate: MaintenanceCompressionCandidate): boolean {
  return !candidate.sticky && !candidate.hasUserAuthoredPage;
}

export type LivingMineMaintenanceAddons = {
  readonly compressedEmergencyCards: number;
  readonly reinterpretedAttempts: number;
  readonly liveOverlayProposals: readonly Record<string, unknown>[];
};
type CompressLike = (input: MaintenanceCompressionCandidate, options: { readonly requestId: string }) => Promise<{
  readonly draft: unknown; readonly undo_token?: string; readonly usage?: unknown;
}>;
type ReinterpretLike = (input: ReinterpretationEvidence, options: { readonly requestId: string }) => Promise<{
  readonly proposals: readonly {
    readonly targetLayer: string; readonly mutatesFrozenAttempt: boolean; readonly preservesSticky: boolean;
  }[];
}>;
type PricedInvoke = (step: string, input: Json, invoke: (providerEffectId: string) => Promise<Json>)
  => Promise<{ readonly outcome: string; readonly value?: Json } | undefined>;

export async function runLivingMineMaintenanceAddons(input: {
  readonly snapshots: ReadonlyMap<string, FlowSnapshotFact>;
  readonly stickyIds: ReadonlySet<string>;
  readonly purpose: string;
  readonly teachingIds: ReadonlySet<string>;
  readonly witnesses: (ids: Iterable<string>) => readonly Record<string, unknown>[];
  readonly executeCommand: (key: string, type: string, commandInput: Json) => Promise<{ readonly state: string }>;
  readonly pricedCall: PricedInvoke;
  readonly compress?: CompressLike | undefined;
  readonly reinterpret?: ReinterpretLike | undefined;
  readonly nowMs: number;
  readonly compressionPurpose: 'storage' | 'teaching';
  readonly buildCommands: (options: {
    readonly requestId: string; readonly context: Record<string, unknown>; readonly draft: unknown;
    readonly purpose: 'storage' | 'teaching';
  }) => Promise<{ readonly commands: readonly { readonly key: string; readonly type: string; readonly input: Json }[] }>;
}): Promise<LivingMineMaintenanceAddons> {
  let compressedEmergencyCards = 0, reinterpretedAttempts = 0;
  const liveOverlayProposals: Record<string, unknown>[] = [];
  const candidates = gatherCompressionCandidates(input.snapshots, input.purpose, input.stickyIds)
    .filter(compressionCandidateAllowed).slice(0, 1);
  if (input.compress) {
    for (const candidate of candidates) {
      try {
        const key = stableId('knowledge-maintenance-compress', candidate.candidateKey, String(input.nowMs));
        const effect = await input.pricedCall(`compress:${key}`, { candidate: candidate.candidateKey },
          providerEffectId => input.compress!(candidate, { requestId: providerEffectId }) as Promise<Json>);
        if (effect?.outcome !== 'ok') continue;
        const card = effect.value as { draft: unknown };
        const witnesses = input.witnesses([...candidate.noteIds, candidate.targetId]);
        if (!witnesses.length) continue;
        const built = await input.buildCommands({
          requestId: key,
          context: {
            hasSufficientBasis: true, topic: candidate.targetTitle, witnesses: witnesses as never,
            ...(candidate.targetKind === 'concept' ? { conceptId: candidate.targetId } : {}),
          },
          draft: card.draft as never, purpose: input.compressionPurpose,
        });
        for (const cmd of built.commands) {
          const result = await input.executeCommand(stableId(key, cmd.key), cmd.type, cmd.input as Json);
          if (cmd.type === 'content.createTextbookPage' && result.state === 'done') compressedEmergencyCards += 1;
        }
      } catch { /* Single-card compression failure skips safely: companion pages are append-only drafts. */ }
    }
  }
  const evidence = gatherReinterpretationEvidence(input.snapshots, input.purpose, input.stickyIds);
  if (evidence && input.reinterpret) {
    try {
      const key = stableId('knowledge-maintenance-reinterpret', evidence.pattern.id, String(input.nowMs));
      const effect = await input.pricedCall(`reinterpret:${key}`, { pattern: evidence.pattern.id },
        providerEffectId => input.reinterpret!(evidence, { requestId: providerEffectId }) as Promise<Json>);
      if (effect?.outcome === 'ok') {
        const retro = effect.value as { proposals: readonly Record<string, unknown>[] };
        for (const proposal of retro.proposals) {
          if (proposal.targetLayer !== 'live_overlay' || proposal.mutatesFrozenAttempt !== false
            || proposal.preservesSticky !== true) continue;
          reinterpretedAttempts += 1;
          liveOverlayProposals.push(proposal);
        }
      }
    } catch { /* Retroactive reinterpretation failure skips safely: frozen attempts are never touched. */ }
  }
  return { compressedEmergencyCards, reinterpretedAttempts, liveOverlayProposals };
}
