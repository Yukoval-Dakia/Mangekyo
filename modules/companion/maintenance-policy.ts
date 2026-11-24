import {
  projectRecordFlow,
  type FlowGraphSnapshot,
  type RecordFlowMasteryLevel,
} from '@mangekyo/module-learner/facts/record-flow';

export const DEFAULT_MAINTENANCE_MIN_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_MAINTENANCE_IDLE_COOLDOWN_MS = 30 * 60_000;
export const DEFAULT_MAINTENANCE_MAX_CONCEPTS = 16;
export const DEFAULT_MAINTENANCE_MAX_SIGNALS = 10;
export const MAX_MAINTENANCE_EDGE_PROPOSALS = 3;

export type MaintenanceMasteryLevel = RecordFlowMasteryLevel;
export type MaintenanceSignalKind = 'attempt' | 'misconception' | 'discussion' | 'concept';
export type MaintenanceEdgeKind = 'prereq_of' | 'related_to';
export type MaintenanceTrigger = 'new_signal' | 'idle_cruise';

export type MaintenanceConceptUse = {
  readonly id: string;
  readonly rev: number;
  readonly accessEpoch: string;
};

export type MaintenanceConceptInput = {
  readonly id: string;
  readonly rev?: number;
  readonly accessEpoch?: string;
  readonly title: string;
  readonly summary?: string;
  readonly masteryLevel: MaintenanceMasteryLevel;
  readonly attemptCount: number;
  readonly errorStages: readonly string[];
  readonly updatedTick?: string;
};

export type MaintenanceEdgeInput = {
  readonly fromId: string;
  readonly toId: string;
  readonly kind: string;
};

export type MaintenanceSignalInput = {
  readonly id: string;
  readonly kind: MaintenanceSignalKind;
  readonly title: string;
  readonly excerpt: string;
  readonly tick?: string;
};

export type MaintenanceBuildInput = {
  readonly currentDate: string;
  readonly nowMs: number;
  readonly carePaused?: boolean;
  readonly lastRunAtMs?: number | null;
  readonly lastRunTick?: string | bigint | null;
  readonly latestSignalTick?: string | bigint | null;
  readonly concepts: readonly MaintenanceConceptInput[];
  readonly edges: readonly MaintenanceEdgeInput[];
  readonly recentSignals: readonly MaintenanceSignalInput[];
};

export type MaintenanceContextOptions = {
  readonly minIntervalMs?: number;
  readonly idleCooldownMs?: number;
  readonly maxConcepts?: number;
  readonly maxSignals?: number;
};

export type MaintenanceContextConcept = {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly masteryLevel: MaintenanceMasteryLevel;
  readonly attemptCount: number;
  readonly errorStages: readonly string[];
};

export type MaintenanceContext = {
  readonly currentDate: string;
  readonly trigger: MaintenanceTrigger;
  readonly concepts: readonly MaintenanceContextConcept[];
  readonly edges: readonly MaintenanceEdgeInput[];
  readonly recentSignals: readonly MaintenanceSignalInput[];
};

export type SuggestedMaintenanceEdge = {
  readonly fromId: string;
  readonly toId: string;
  readonly kind: MaintenanceEdgeKind;
  readonly rationale: string;
};

export type SuggestedPrepNote = {
  readonly title: string;
  readonly focusConceptIds: readonly string[];
  readonly summary: string;
  readonly actionSteps: readonly string[];
};

export type MaintenanceProposal = {
  readonly shouldAct: boolean;
  readonly rationale: string;
  readonly suggestedEdges: readonly SuggestedMaintenanceEdge[];
  readonly suggestedPrepNote?: SuggestedPrepNote;
};

export type PlannedKnowledgeEdgeProposal = {
  readonly commandType: 'content.createKnowledgeEdge';
  readonly dedupKey: string;
  readonly fromId: string;
  readonly toId: string;
  readonly kind: MaintenanceEdgeKind;
  readonly rationale: string;
  readonly payload: {
    readonly purpose: 'storage' | 'teaching';
    readonly edge: {
      readonly kind: MaintenanceEdgeKind;
      readonly scope: string;
      readonly from: { readonly kind: 'concept'; readonly sourceUse: MaintenanceConceptUse };
      readonly to: { readonly kind: 'concept'; readonly sourceUse: MaintenanceConceptUse };
      readonly sourceUses: readonly [MaintenanceConceptUse, MaintenanceConceptUse];
    };
  };
};

export type PlannedPrepNote = {
  readonly dedupKey: string;
  readonly title: string;
  readonly focusConceptIds: readonly string[];
  readonly basis: readonly MaintenanceConceptUse[];
  readonly summary: string;
  readonly actionSteps: readonly string[];
};

export type MaintenanceActionPlan = {
  readonly shouldAct: boolean;
  readonly rationale: string;
  readonly edgeProposals: readonly PlannedKnowledgeEdgeProposal[];
  readonly prepNote: PlannedPrepNote | null;
  readonly rejectedCount: number;
};

export type PlanMaintenanceOptions = {
  readonly conceptUses?: ReadonlyMap<string, MaintenanceConceptUse>;
  readonly purpose?: 'storage' | 'teaching';
  /** 命令载荷用途（边/备忘写入），与授权读取用途解耦。 */
  readonly writePurpose?: 'storage' | 'teaching';
  readonly maxEdges?: number;
};

const VALID_EDGE_KINDS = new Set<MaintenanceEdgeKind>(['prereq_of', 'related_to']);
const SIGNAL_PRIORITY: Readonly<Record<MaintenanceSignalKind, number>> = {
  misconception: 4,
  attempt: 3,
  discussion: 2,
  concept: 1,
};

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const noNull = value.replaceAll('\0', '');
  const wellFormed = typeof noNull.toWellFormed === 'function' ? noNull.toWellFormed() : noNull;
  const trimmed = wellFormed.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxLength) return trimmed;
  let end = maxLength;
  const code = trimmed.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return trimmed.slice(0, end).trimEnd();
}

function toBigIntTick(value: string | bigint | null | undefined): bigint {
  if (typeof value === 'bigint') return value >= 0n ? value : 0n;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return 0n;
}

function dedupeStrings(values: readonly string[], maxItems: number, maxLen: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const cleaned = cleanText(raw, maxLen);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function extractConceptSummary(data: unknown): string | undefined {
  const obj = rec(data);
  const direct = cleanText(obj.summary, 600);
  if (direct) return direct;
  if (Array.isArray(obj.blocks)) {
    for (const block of obj.blocks) {
      const b = rec(block);
      const body = rec(b.body);
      const text = cleanText(body.text, 600);
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * Zero-glue adapter from `FlowGraphSnapshot` (`modules/learner/record-flow.ts`)
 * into `MaintenanceBuildInput` so background maintenance runners need no ad-hoc glue.
 */
export function extractMaintenanceInputFromFlow(
  snap: FlowGraphSnapshot,
  meta: {
    readonly currentDate: string;
    readonly nowMs: number;
    readonly carePaused?: boolean;
    readonly lastRunAtMs?: number | null;
    readonly lastRunTick?: string | bigint | null;
    readonly accessEpochs?: ReadonlyMap<string, string>;
  },
): MaintenanceBuildInput {
  const concepts: MaintenanceConceptInput[] = [];
  const edges: MaintenanceEdgeInput[] = [];
  const recentSignals: MaintenanceSignalInput[] = [];
  let maxTick = 0n;

  const trackTick = (rawTick: string | undefined) => {
    const t = toBigIntTick(rawTick);
    if (t > maxTick) maxTick = t;
  };

  for (const fact of snap.factsById.values()) {
    const data = rec(fact.data);
    if (fact.type === 'content.knowledgeEdge') {
      const fromId = str(rec(rec(data.from).sourceUse).id);
      const toId = str(rec(rec(data.to).sourceUse).id);
      const kind = str(data.kind) || 'related_to';
      if (fromId && toId && fromId !== toId) {
        edges.push({ fromId, toId, kind });
      }
      continue;
    }

    if (
      (fact.type === 'content.asset' || fact.type === 'activity.workspaceEntry') &&
      str(data.kind) === 'concept'
    ) {
      const flow = projectRecordFlow(fact.id, snap);
      if (!flow) continue;
      trackTick(fact.createdTick);
      const summary = extractConceptSummary(fact.data);
      const errorStages = dedupeStrings(
        [
          ...flow.misconceptions.map((m) => m.errorStage ?? '').filter(Boolean),
          ...flow.attempts.map((a) => a.errorStage ?? '').filter(Boolean),
        ],
        8,
        48,
      );
      const accessEpoch = meta.accessEpochs?.get(fact.id);
      concepts.push({
        id: fact.id,
        rev: fact.rev,
        ...(accessEpoch ? { accessEpoch } : {}),
        title: flow.identity.title,
        ...(summary ? { summary } : {}),
        masteryLevel: flow.mastery.level,
        attemptCount: flow.attempts.length,
        errorStages,
        updatedTick: fact.createdTick,
      });
      if (flow.graphNeighbors.length === 0) {
        recentSignals.push({
          id: fact.id,
          kind: 'concept',
          title: flow.identity.title,
          excerpt: summary ? `孤立概念：${summary}` : '尚未建立知识关系边的孤立概念',
          tick: fact.createdTick,
        });
      }
      continue;
    }

    if (fact.type === 'activity.workbookAttempt') {
      trackTick(fact.createdTick);
      const paperId = str(data.paperId);
      const paper = paperId ? snap.factsById.get(paperId) : undefined;
      const paperTitle = paper ? cleanText(rec(paper.data).title, 80) || '练习卷' : '练习卷';
      const feedback = Array.isArray(data.feedback) ? data.feedback : [];
      const wrongCount = feedback.filter((item) => {
        const result = str(rec(item).result);
        return result === 'incorrect' || result === 'partial';
      }).length;
      recentSignals.push({
        id: fact.id,
        kind: 'attempt',
        title: paperTitle,
        excerpt: wrongCount > 0 ? `近期提交作答，发现 ${wrongCount} 道待复盘/错题` : '近期提交作答记录',
        tick: fact.createdTick,
      });
      continue;
    }

    if (fact.type === 'companion.memoryAssertion') {
      trackTick(fact.createdTick);
      const text = cleanText(data.text, 200);
      if (text) {
        recentSignals.push({
          id: fact.id,
          kind: 'misconception',
          title: '错因断言',
          excerpt: text,
          tick: fact.createdTick,
        });
      }
      continue;
    }

    if (fact.type === 'activity.studyTurn') {
      trackTick(fact.createdTick);
      const answer = cleanText(data.answer, 160);
      const fb = snap.feedbackByTurnId.get(fact.id);
      const excerpt = cleanText(fb?.message || answer, 200);
      if (excerpt) {
        recentSignals.push({
          id: fact.id,
          kind: 'discussion',
          title: answer || '同伴对话',
          excerpt,
          tick: fact.createdTick,
        });
      }
    }
  }

  return {
    currentDate: meta.currentDate,
    nowMs: meta.nowMs,
    ...(meta.carePaused !== undefined ? { carePaused: meta.carePaused } : {}),
    ...(meta.lastRunAtMs !== undefined ? { lastRunAtMs: meta.lastRunAtMs } : {}),
    ...(meta.lastRunTick !== undefined ? { lastRunTick: meta.lastRunTick } : {}),
    latestSignalTick: maxTick.toString(),
    concepts,
    edges,
    recentSignals,
  };
}

/**
 * Decide whether idle autonomous knowledge maintenance should trigger and assemble
 * a bounded, deterministic context for `proposeKnowledgeMaintenanceWithAgent`.
 * Returns `null` when paused, uninitialized, cooled down, or no actionable backlog exists.
 */
export function buildMaintenanceContext(
  input: MaintenanceBuildInput,
  options: MaintenanceContextOptions = {},
): MaintenanceContext | null {
  if (input.carePaused === true) return null;

  // Normalize & dedupe concepts by id.
  const conceptMap = new Map<string, MaintenanceConceptInput>();
  for (const raw of input.concepts) {
    const id = cleanText(raw.id, 128);
    const title = cleanText(raw.title, 160);
    if (!id || !title || conceptMap.has(id)) continue;
    const summary = cleanText(raw.summary, 600);
    conceptMap.set(id, {
      ...raw,
      id,
      title,
      ...(summary ? { summary } : {}),
      attemptCount: Math.max(0, Math.floor(Number.isFinite(raw.attemptCount) ? raw.attemptCount : 0)),
      errorStages: dedupeStrings(raw.errorStages ?? [], 8, 48),
    });
  }
  const allConcepts = [...conceptMap.values()];
  if (allConcepts.length === 0) return null;

  // Degree count across valid concepts (undirected for isolation check).
  const degree = new Map<string, number>();
  const validEdges: MaintenanceEdgeInput[] = [];
  const seenEdgeSigs = new Set<string>();
  for (const raw of input.edges) {
    const fromId = cleanText(raw.fromId, 128);
    const toId = cleanText(raw.toId, 128);
    const kind = cleanText(raw.kind, 64);
    if (!fromId || !toId || fromId === toId || !kind) continue;
    if (!conceptMap.has(fromId) || !conceptMap.has(toId)) continue;
    const sig = `${fromId}\0${toId}\0${kind}`;
    if (seenEdgeSigs.has(sig)) continue;
    seenEdgeSigs.add(sig);
    validEdges.push({ fromId, toId, kind });
    degree.set(fromId, (degree.get(fromId) ?? 0) + 1);
    degree.set(toId, (degree.get(toId) ?? 0) + 1);
  }

  let isolatedCount = 0;
  let weakOrErrorCount = 0;
  for (const concept of allConcepts) {
    if ((degree.get(concept.id) ?? 0) === 0) isolatedCount += 1;
    if (concept.masteryLevel === 'fragile' || concept.errorStages.length > 0) weakOrErrorCount += 1;
  }

  const minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MAINTENANCE_MIN_INTERVAL_MS);
  const idleCooldownMs = Math.max(minIntervalMs, options.idleCooldownMs ?? DEFAULT_MAINTENANCE_IDLE_COOLDOWN_MS);
  const elapsedMs =
    input.lastRunAtMs === undefined || input.lastRunAtMs === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, input.nowMs - input.lastRunAtMs);

  const lastRunTick = toBigIntTick(input.lastRunTick);
  let latestSignalTick = toBigIntTick(input.latestSignalTick);
  for (const signal of input.recentSignals) {
    const t = toBigIntTick(signal.tick);
    if (t > latestSignalTick) latestSignalTick = t;
  }
  const hasNewHighSignal =
    latestSignalTick > lastRunTick &&
    (input.recentSignals.some((s) => s.tick === undefined || toBigIntTick(s.tick) > lastRunTick) ||
      isolatedCount > 0 ||
      weakOrErrorCount > 0);
  const hasMaintenanceBacklog = isolatedCount >= 2 || weakOrErrorCount >= 1;

  let trigger: MaintenanceTrigger | null = null;
  if (hasNewHighSignal && elapsedMs >= minIntervalMs) {
    trigger = 'new_signal';
  } else if (elapsedMs >= idleCooldownMs && hasMaintenanceBacklog) {
    trigger = 'idle_cruise';
  }
  if (!trigger) return null;

  const maxConcepts = Math.max(1, Math.min(32, options.maxConcepts ?? DEFAULT_MAINTENANCE_MAX_CONCEPTS));
  const maxSignals = Math.max(1, Math.min(20, options.maxSignals ?? DEFAULT_MAINTENANCE_MAX_SIGNALS));

  // Deterministic ranking: errorStages > fragile > isolated > missing summary > recent attempts > tick > id.
  const rankedConcepts = [...allConcepts].sort((a, b) => {
    const errDiff = (b.errorStages.length > 0 ? 1 : 0) - (a.errorStages.length > 0 ? 1 : 0);
    if (errDiff !== 0) return errDiff;
    const errCountDiff = b.errorStages.length - a.errorStages.length;
    if (errCountDiff !== 0) return errCountDiff;
    const fragileDiff = (b.masteryLevel === 'fragile' ? 1 : 0) - (a.masteryLevel === 'fragile' ? 1 : 0);
    if (fragileDiff !== 0) return fragileDiff;
    const isoDiff = ((degree.get(b.id) ?? 0) === 0 ? 1 : 0) - ((degree.get(a.id) ?? 0) === 0 ? 1 : 0);
    if (isoDiff !== 0) return isoDiff;
    const sumDiff = (!b.summary ? 1 : 0) - (!a.summary ? 1 : 0);
    if (sumDiff !== 0) return sumDiff;
    const attemptDiff = b.attemptCount - a.attemptCount;
    if (attemptDiff !== 0) return attemptDiff;
    const tickA = toBigIntTick(a.updatedTick);
    const tickB = toBigIntTick(b.updatedTick);
    if (tickB !== tickA) return tickB > tickA ? 1 : -1;
    return a.id.localeCompare(b.id);
  });

  const selectedConcepts: MaintenanceContextConcept[] = rankedConcepts.slice(0, maxConcepts).map((c) => ({
    id: c.id,
    title: c.title,
    ...(c.summary ? { summary: c.summary } : {}),
    masteryLevel: c.masteryLevel,
    attemptCount: c.attemptCount,
    errorStages: c.errorStages,
  }));
  const selectedIds = new Set(selectedConcepts.map((c) => c.id));

  const selectedEdges = validEdges
    .filter((e) => selectedIds.has(e.fromId) && selectedIds.has(e.toId))
    .sort((a, b) => a.fromId.localeCompare(b.fromId) || a.toId.localeCompare(b.toId) || a.kind.localeCompare(b.kind))
    .slice(0, 64);

  const seenSignals = new Set<string>();
  const normalizedSignals: MaintenanceSignalInput[] = [];
  for (const raw of input.recentSignals) {
    const id = cleanText(raw.id, 128);
    const title = cleanText(raw.title, 120);
    const excerpt = cleanText(raw.excerpt, 240);
    if (!id || (!title && !excerpt) || seenSignals.has(`${raw.kind}:${id}`)) continue;
    seenSignals.add(`${raw.kind}:${id}`);
    normalizedSignals.push({
      id,
      kind: raw.kind,
      title: title || excerpt.slice(0, 48),
      excerpt: excerpt || title,
      ...(raw.tick ? { tick: raw.tick } : {}),
    });
  }
  const selectedSignals = normalizedSignals
    .sort((a, b) => {
      const tickA = toBigIntTick(a.tick);
      const tickB = toBigIntTick(b.tick);
      if (tickB !== tickA) return tickB > tickA ? 1 : -1;
      const prioDiff = (SIGNAL_PRIORITY[b.kind] ?? 0) - (SIGNAL_PRIORITY[a.kind] ?? 0);
      if (prioDiff !== 0) return prioDiff;
      return a.id.localeCompare(b.id);
    })
    .slice(0, maxSignals)
    .map(({ id, kind, title, excerpt }) => ({ id, kind, title, excerpt }));

  return {
    currentDate: cleanText(input.currentDate, 32) || '1970-01-01',
    trigger,
    concepts: selectedConcepts,
    edges: selectedEdges,
    recentSignals: selectedSignals,
  };
}

/**
 * Translate a maintenance agent proposal into bounded, anti-hallucination, traceable
 * kernel command plans:
 * - Drops any ID not present in `context.concepts`
 * - Drops self-loops and duplicate edges already in `context.edges`
 * - Caps edge proposals at <= 3 using standard `content.createKnowledgeEdge` payloads
 * - Produces <= 1 traceable, idempotent prepNote with verified `focusConceptIds` basis
 */
export function planMaintenanceActions(
  proposal: MaintenanceProposal,
  context: MaintenanceContext,
  options: PlanMaintenanceOptions = {},
): MaintenanceActionPlan {
  const rationale = cleanText(proposal.rationale, 500);
  if (!proposal.shouldAct) {
    return {
      shouldAct: false,
      rationale,
      edgeProposals: [],
      prepNote: null,
      rejectedCount: 0,
    };
  }

  const validConceptIds = new Set(context.concepts.map((c) => c.id));
  const existingEdgeSigs = new Set(context.edges.map((e) => `${e.fromId}\0${e.toId}\0${e.kind}`));
  const purpose = options.writePurpose ?? options.purpose ?? 'teaching';
  const maxEdges = Math.max(0, Math.min(MAX_MAINTENANCE_EDGE_PROPOSALS, options.maxEdges ?? MAX_MAINTENANCE_EDGE_PROPOSALS));
  const useOf = (id: string): MaintenanceConceptUse =>
    options.conceptUses?.get(id) ?? { id, rev: 1, accessEpoch: '0' };

  let rejectedCount = 0;

  // 1. Validate & cap knowledge edge proposals (<= 3).
  const edgeProposals: PlannedKnowledgeEdgeProposal[] = [];
  const plannedEdgeSigs = new Set<string>();
  for (const raw of proposal.suggestedEdges ?? []) {
    const fromId = cleanText(raw.fromId, 128);
    const toId = cleanText(raw.toId, 128);
    const kind = raw.kind;
    if (
      !fromId ||
      !toId ||
      fromId === toId ||
      !validConceptIds.has(fromId) ||
      !validConceptIds.has(toId) ||
      !VALID_EDGE_KINDS.has(kind)
    ) {
      rejectedCount += 1;
      continue;
    }
    const sig = `${fromId}\0${toId}\0${kind}`;
    if (existingEdgeSigs.has(sig) || plannedEdgeSigs.has(sig)) {
      rejectedCount += 1;
      continue;
    }
    if (edgeProposals.length >= maxEdges) {
      rejectedCount += 1;
      continue;
    }
    plannedEdgeSigs.add(sig);
    const fromUse = useOf(fromId);
    const toUse = useOf(toId);
    const edgeRationale = cleanText(raw.rationale, 320) || '后台知识图谱巡航建议关系';
    edgeProposals.push({
      commandType: 'content.createKnowledgeEdge',
      dedupKey: `maintenance-edge:${fromId}:${toId}:${kind}`,
      fromId,
      toId,
      kind,
      rationale: edgeRationale,
      payload: {
        purpose,
        edge: {
          kind,
          scope: edgeRationale,
          from: { kind: 'concept', sourceUse: fromUse },
          to: { kind: 'concept', sourceUse: toUse },
          sourceUses: [fromUse, toUse],
        },
      },
    });
  }

  // 2. Validate <= 1 traceable, idempotent prepNote with verified focusConceptIds basis.
  let prepNote: PlannedPrepNote | null = null;
  if (proposal.suggestedPrepNote) {
    const rawNote = proposal.suggestedPrepNote;
    const validFocus: string[] = [];
    const seenFocus = new Set<string>();
    for (const rawId of rawNote.focusConceptIds ?? []) {
      const id = cleanText(rawId, 128);
      if (!id || !validConceptIds.has(id)) {
        rejectedCount += 1;
        continue;
      }
      if (seenFocus.has(id)) continue;
      seenFocus.add(id);
      validFocus.push(id);
      if (validFocus.length >= 6) break;
    }
    const title = cleanText(rawNote.title, 120);
    const summary = cleanText(rawNote.summary, 600);
    const actionSteps = dedupeStrings(rawNote.actionSteps ?? [], 6, 200);
    if (validFocus.length > 0 && title && summary) {
      const sortedFocus = [...validFocus].sort((a, b) => a.localeCompare(b));
      prepNote = {
        dedupKey: `maintenance-prep:${context.currentDate}:${sortedFocus.join(',')}`,
        title,
        focusConceptIds: sortedFocus,
        basis: sortedFocus.map(useOf),
        summary,
        actionSteps,
      };
    } else {
      rejectedCount += 1;
    }
  }

  const hasActions = edgeProposals.length > 0 || prepNote !== null;
  return {
    shouldAct: hasActions,
    rationale,
    edgeProposals,
    prepNote,
    rejectedCount,
  };
}
