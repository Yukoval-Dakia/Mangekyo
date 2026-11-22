// Pure helpers extracted from runtime/studio/research-triage-host.ts.
// All tx.query, fact reads, todo reads stay in the runtime host;
// this module owns constants, scout identity, and pure snapshot/request shaping.

import type { FactId, Json } from '@mangekyo/kernel';

export const retrySheetLifetimeMs = 24 * 60 * 60 * 1000;
export const researchTriageRecentWindow = 8;
export const researchTriageDetailLimit = 4;

export function scoutEffectIdentityValue(settingsId: FactId, dedupKey: string) {
  return { ownerKind: 'session' as const, ownerId: settingsId, stepKey: dedupKey, label: 'background-research-scout-v1' };
}

export type DeltaEventKind =
  | 'goal_or_task_changed'
  | 'research_enabled'
  | 'authorized_retention_miss'
  | 'authorized_attempt_changed';

export function makeDeltaEvent(
  rowId: string,
  factRef: string,
  factRev: number,
  kind: DeltaEventKind,
  payload: Json,
): { event_id: string; kind: DeltaEventKind; fact_ref: string; fact_rev: number; payload: Json } {
  return { event_id: rowId, kind, fact_ref: factRef, fact_rev: factRev, payload };
}

export function goalOrTaskPayload(factType: string): Json { return { fact_type: factType }; }
export function retentionMissPayload(): Json { return { status: 'missed' }; }
export function attemptChangedPayload(submittedAt: string): Json { return { submitted_at: submittedAt }; }

export function buildEmptyTriageSnapshotFields() {
  return { forecasts: {}, memos: {}, work: {}, signals: {}, chain: null, budget: { remaining: 0 } };
}

export function buildTriagePrefix(args: {
  facts: Record<string, Json>; todos: Record<string, Json>; inventory: Record<string, Json>;
}) {
  const { facts, todos, inventory } = args;
  return { facts, todos, inventory, ...buildEmptyTriageSnapshotFields() };
}

export function buildPaidTriageSnapshot(facts: Record<string, Json>) {
  return { facts, todos: {}, inventory: {}, events: {}, ...buildEmptyTriageSnapshotFields() };
}

export function buildPaidTriageInput<A>(candidate: Json, action: A, noop: A, response: (a: A) => unknown) {
  return { candidate, menu: [noop, action], response_format: response(noop) };
}

export function buildTriageSnapshotFacts(
  baseFacts: Record<string, Json>,
  intentSourceId: string | undefined,
  olderCandidate: Json | undefined,
): Record<string, Json> {
  return intentSourceId && olderCandidate ? { ...baseFacts, [intentSourceId]: olderCandidate } : baseFacts;
}
