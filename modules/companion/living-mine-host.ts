import { stableId } from '@mangekyo/kernel';
import type { FactId, Json, ReadTransaction } from '@mangekyo/kernel';
import {
  buildLivingMineRadar, selectWarmBackfillBatch, MAX_MAINTENANCE_BUDGET_RATIO,
  type DerivationWatermarkTarget, type LivingMineExamConceptInput, type LivingMineHighConfMissInput,
  type LivingMineRadarInput, type LivingMineStaleItemInput, type LivingMineSupplyConceptInput,
} from './living-mine-radar.ts';
import { evaluatePlaybookEffectiveness, type PlaybookEffectivenessEntryInput } from '@mangekyo/module-learner/facts/playbook-effectiveness';
import type { Revision } from '@mangekyo/kernel';

/**
 * Studio host assembly for the living-mine radar and playbook effectiveness
 * read surfaces. All inputs are scanned here through injected SQL; the heavy
 * aggregation stays in the domain-pure radar/effectiveness modules. Sources
 * that lack honest kernel evidence stay empty rather than being fabricated.
 */

/** Foreground teaching/class sessions occupy ready/waiting work rows under activity derivers. */
export async function scanForegroundActive(tx: ReadTransaction): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM work WHERE learner_id=$1 AND state IN ('ready','running','waiting') AND deriver LIKE 'activity/%' LIMIT 1`,
    [tx.learner]);
  return rows.length > 0;
}

export async function scanPlaybookEntries(tx: ReadTransaction): Promise<PlaybookEffectivenessEntryInput[]> {
  const { rows } = await tx.query(
    `SELECT f.id, f.current_rev AS rev, f.sticky, r.data FROM facts f
       JOIN fact_revs r ON (r.learner_id, r.fact_id, r.rev) = (f.learner_id, f.id, f.current_rev)
     WHERE f.learner_id=$1 AND f.type='learner.playbook' AND f.retracted_rev IS NULL`,
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
    const version = typeof data.version === 'number' ? data.version : 1;
    const strategyId = typeof data.strategyId === 'string' ? data.strategyId : '';
    const steps = Array.isArray(data.strategy_steps) ? data.strategy_steps : [];
    const title = typeof steps[0] === 'string' && steps[0].trim() ? steps[0].slice(0, 60) : strategyId || row.id;
    // Exact kernel slot key only: a lift targeting another playbook/version is never attributed.
    const lift = liftsByKey.get(JSON.stringify([row.id, version]));
    const outcome = lift?.value as { kind?: string; value?: Record<string, unknown> } | undefined;
    const liftValue = outcome?.kind === 'value' ? outcome.value as Record<string, unknown> : undefined;
    const matchesIdentity = liftValue !== undefined &&
      liftValue.playbookId === row.id && liftValue.version === version && liftValue.strategyId === strategyId;
    const eligible = matchesIdentity && typeof liftValue?.eligible === 'number' ? liftValue.eligible : 0;
    const unresolved = matchesIdentity && typeof liftValue?.unresolved === 'number' ? liftValue.unresolved : 0;
    const pending = matchesIdentity && typeof liftValue?.pending === 'number' ? liftValue.pending : 0;
    entries.push({
      playbookId: row.id as FactId,
      version: version as Revision,
      strategyId,
      title,
      ...(row.sticky ? { sticky: true } : {}),
      ...(lift && outcome ? { precomputedLift: outcome as never } : {}),
      usage: {
        deliveredCount: eligible + unresolved + pending,
        openedCount: eligible + unresolved,
        posttestCompletedCount: eligible,
      },
      expectedRev: row.rev as Revision,
      ...(lift ? { liftId: lift.derivationId } : {}),
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

/** Playbook retirement yellow proposals exposed to the gardening inbox host. */
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
      playbookId: proposal.playbookId,
      expectedRev: proposal.expectedRev,
      version: proposal.version,
      liftId: proposal.liftId,
      sticky: item.stickyProtected,
      title: `退场负向教法：${item.title}`,
      summary: proposal.reason,
    });
  }
  return out;
}

type KbEntropyInput = NonNullable<LivingMineRadarInput['kbEntropyRadar']>;

/** Scan radar inputs that have honest kernel evidence; everything else stays empty. */
export async function scanLivingMineInputs(
  tx: ReadTransaction,
  kbEntropyRadar: KbEntropyInput | undefined,
  { nowMs = Date.now() }: { nowMs?: number } = {},
): Promise<{
  examConcepts: LivingMineExamConceptInput[];
  highConfidenceMisses: LivingMineHighConfMissInput[];
  supplyConcepts: LivingMineSupplyConceptInput[];
  derivationTargets: DerivationWatermarkTarget[];
  staleInventoryItems: LivingMineStaleItemInput[];
}> {
  // High-confidence wrong answers: incorrect items in workbook attempts. The kernel does
  // not yet record per-item confidence or exposure independence, so only rows that carry
  // an explicit incorrect verdict count; sparse is honest.
  const { rows: attemptRows } = await tx.query(
    `SELECT f.id, r.data FROM facts f
       JOIN fact_revs r ON (r.learner_id, r.fact_id, r.rev) = (f.learner_id, f.id, f.current_rev)
     WHERE f.learner_id=$1 AND f.type='activity.workbookAttempt' AND f.retracted_rev IS NULL
     ORDER BY f.changed_tick DESC LIMIT 200`,
    [tx.learner]);
  const highConfidenceMisses: LivingMineHighConfMissInput[] = [];
  for (const row of attemptRows as { id: string; data: Record<string, unknown> }[]) {
    const data = row.data;
    const feedback = data.feedback;
    const items = Array.isArray(feedback) ? feedback : Array.isArray((data as Record<string, unknown>).items) ? data.items as unknown[] : [];
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

  // Variant supply per concept: targets_concept edges link questions to concepts; the
  // exposure set is injected by the caller through exposedQuestionIds when available.
  const { rows: edgeRows } = await tx.query(
    `SELECT r.data FROM facts f
       JOIN fact_revs r ON (r.learner_id, r.fact_id, r.rev) = (f.learner_id, f.id, f.current_rev)
     WHERE f.learner_id=$1 AND f.type='content.knowledgeEdge' AND f.retracted_rev IS NULL`,
    [tx.learner]);
  const totals = new Map<string, { total: number; conceptId: string }>();
  for (const row of edgeRows as { data: Record<string, unknown> }[]) {
    const data = row.data;
    if (data.kind !== 'targets_concept') continue;
    const to = (data.to as Record<string, unknown> | undefined)?.sourceUse as { id?: string } | undefined;
    if (!to?.id) continue;
    const entry = totals.get(to.id) ?? { total: 0, conceptId: to.id };
    entry.total += 1;
    totals.set(to.id, entry);
  }
  const { rows: conceptRows } = await tx.query(
    `SELECT f.id, r.data FROM facts f
       JOIN fact_revs r ON (r.learner_id, r.fact_id, r.rev) = (f.learner_id, f.id, f.current_rev)
     WHERE f.learner_id=$1 AND f.type='content.asset' AND f.retracted_rev IS NULL
       AND r.data->>'kind' = 'concept'`,
    [tx.learner]);
  const supplyConcepts: LivingMineSupplyConceptInput[] = [];
  const examConcepts: LivingMineExamConceptInput[] = [];
  for (const row of conceptRows as { id: string; data: Record<string, unknown> }[]) {
    const title = typeof row.data.title === 'string' ? row.data.title : row.id;
    const total = totals.get(row.id)?.total ?? 0;
    if (total > 0) {
      supplyConcepts.push({ id: row.id, title, totalQuestionCount: total, unexposedVariantCount: total });
      examConcepts.push({ id: row.id, title, attemptCount: 0 });
    }
  }

  // Derivation watermarks: honest evidence would require a registry of target deriver
  // versions; none exists yet, so this stays empty rather than fabricated.
  const derivationTargets: DerivationWatermarkTarget[] = [];

  // Stale inventory: reuse the kb entropy stale drafts (they already encode age/sticky/user-authorship).
  const staleInventoryItems: LivingMineStaleItemInput[] = (kbEntropyRadar?.staleUnusedDrafts ?? []).map(draft => ({
    id: draft.assetId,
    kind: draft.assetKind,
    title: draft.title,
    ageDays: draft.ageDays,
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

/** Compression candidate synthesis for maintenance: the input contract matches ChapterEmergencyCardInput field-for-field. */
export type MaintenanceCompressionCandidate = {
  readonly candidateKey: string; readonly targetKind: 'chapter' | 'concept'; readonly targetId: string;
  readonly targetTitle: string; readonly noteCount: number; readonly noteIds: readonly string[];
  readonly noteSummaries: readonly string[]; readonly recommendedArtifact: 'emergency_card' | 'decision_tree';
  readonly hasUserAuthoredPage: boolean; readonly sticky: boolean;
};
type FlowSnapshotFact = {
  readonly ref: { readonly id: string; readonly rev: number };
  readonly type: string; readonly value: unknown; readonly purpose: readonly string[];
};
/** Gather compression candidates from an authorized flow snapshot: notes >= 3 per target, never sticky/user-authored targets. */
export function gatherCompressionCandidates(
  snapshots: ReadonlyMap<string, FlowSnapshotFact>, purpose: string, minNotes = 3,
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
      sticky: data.sticky === true,
    });
  }
  const candidates: MaintenanceCompressionCandidate[] = [];
  for (const [candidateKey, group] of notesByTarget) {
    if (group.notes.length < minNotes) continue;
    const sorted = [...group.notes].sort((l, r) => l.id < r.id ? -1 : l.id > r.id ? 1 : 0);
    const target = snapshots.get(group.targetId);
    const targetData = (target?.value ?? {}) as Record<string, unknown>;
    const blocks = Array.isArray(targetData.blocks) ? targetData.blocks as Record<string, unknown>[] : [];
    const hasUserAuthoredPage = group.targetKind === 'chapter' && target?.type === 'content.textbookPage' &&
      targetData.creator === 'learner';
    candidates.push({
      candidateKey, targetKind: group.targetKind, targetId: group.targetId,
      targetTitle: String(targetData.title ?? group.targetId), noteCount: sorted.length,
      noteIds: sorted.map(note => note.id), noteSummaries: sorted.map(note => note.summary),
      recommendedArtifact: group.targetKind === 'concept' && sorted.length >= 5 ? 'decision_tree' : 'emergency_card',
      hasUserAuthoredPage: hasUserAuthoredPage === true, sticky: targetData.sticky === true || sorted.some(note => note.sticky),
    });
    void blocks;
  }
  candidates.sort((l, r) => r.noteCount - l.noteCount || (l.candidateKey < r.candidateKey ? -1 : 1));
  return candidates;
}

/** Retroactive reinterpretation evidence: only real frozen attempts sharing one high-frequency error stage. */
export type ReinterpretationEvidence = {
  readonly pattern: { readonly id: string; readonly label: string; readonly errorStage: string; readonly errorStageLabel: string };
  readonly attempts: readonly { readonly attemptId: string; readonly questionId?: string; readonly verdict?: string; readonly errorStage?: string; readonly sticky?: boolean; readonly lockedStickySlots?: readonly string[] }[];
};
export function gatherReinterpretationEvidence(
  snapshots: ReadonlyMap<string, FlowSnapshotFact>, purpose: string, minAttempts = 3,
): ReinterpretationEvidence | null {
  const byStage = new Map<string, { attemptId: string; questionId?: string; verdict?: string; errorStage?: string; sticky?: boolean }[]>();
  for (const fact of snapshots.values()) {
    if (fact.type !== 'activity.workbookAttempt' || !fact.purpose.includes(purpose) && !fact.purpose.includes('all')) continue;
    const data = fact.value as Record<string, unknown>;
    if (data.sticky === true) continue;
    const feedback = data.feedback as Record<string, unknown> | undefined;
    if (feedback?.result !== 'incorrect') continue;
    const stage = typeof feedback.errorStage === 'string' && feedback.errorStage.trim() ? feedback.errorStage : 'unknown';
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
      verdict: 'incorrect',
      errorStage: stage,
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

/** Analyze candidate kind for maintenance without trusting raw model output: sticky/user-authored targets are refused. */
export function compressionCandidateAllowed(candidate: MaintenanceCompressionCandidate): boolean {
  return !candidate.sticky && !candidate.hasUserAuthoredPage;
}

/** Analysis output for maintenance living-mine addons: command specs for compression, recorded-only reinterpretation. */
export type LivingMineMaintenanceAddons = {
  readonly compressedEmergencyCards: number;
  readonly reinterpretedAttempts: number;
  readonly liveOverlayProposals: readonly Record<string, unknown>[];
};
export type LivingMineAddonExecutor<Cmd> = (command: Cmd) => Promise<{ readonly state: string }>;
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

/**
 * Run living-mine maintenance addons under the maintenance triple gate: budget already reserved by pricedCall,
 * care-pause and dispatch authorization already verified in the caller. Compression writes append-only companion
 * pages through buildAuthoredTextbookCommands; reinterpretation proposals are recorded metadata only — no kernel
 * live-overlay write channel exists yet, and frozen attempts are never touched.
 */
export async function runLivingMineMaintenanceAddons(input: {
  readonly snapshots: ReadonlyMap<string, FlowSnapshotFact>;
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
  const candidates = gatherCompressionCandidates(input.snapshots, input.purpose).filter(compressionCandidateAllowed).slice(0, 1);
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
          context: { witnesses: witnesses as never, ...(candidate.targetKind === 'concept' ? { conceptId: candidate.targetId } : {}) },
          draft: card.draft as never, purpose: input.compressionPurpose,
        });
        for (const cmd of built.commands) {
          const result = await input.executeCommand(stableId(key, cmd.key), cmd.type, cmd.input as Json);
          if (cmd.type === 'content.createTextbookPage' && result.state === 'done') compressedEmergencyCards += 1;
        }
      } catch { /* Single-card compression failure skips safely: companion pages are append-only drafts. */ }
    }
  }
  const evidence = gatherReinterpretationEvidence(input.snapshots, input.purpose);
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
