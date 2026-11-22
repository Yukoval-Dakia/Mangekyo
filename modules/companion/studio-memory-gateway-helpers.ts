// Pure helpers extracted from runtime/studio/memory-gateway.ts.
// All tx.query, fact reads, source resolution stay in the runtime host;
// this module owns witness shaping, region add, and pure packet composition.

import type { FactSnapshot } from '@mangekyo/kernel';

export function witnessFromSnapshot(fact: FactSnapshot) {
  return { id: fact.ref.id, rev: fact.ref.rev, epoch: fact.accessEpoch, type: fact.type, mode: 'following' as const };
}

export function makeRegionAdder<R extends string | number | symbol, I>(results: Map<R, I[]>) {
  return (region: R, entry: I) => {
    const items = results.get(region) ?? [];
    items.push(entry);
    results.set(region, items);
  };
}

export function claimRegionFor(args: { management?: boolean | undefined; legacy: boolean; category: unknown }) {
  const { management, legacy, category } = args;
  return !management && !legacy && (category === 'preference' || category === 'refusal') ? 'preferences' as const : 'claims' as const;
}

export function isClaimExpiredOrForgotten(args: { legacy: boolean; action: unknown; validUntil: string | null | undefined; at: string }) {
  const { legacy, action, validUntil, at } = args;
  return !legacy && (action === 'forget' || (validUntil != null && validUntil <= at));
}

export function isUnderstandingExpired(args: { ttl: string | null | undefined; at: string }) {
  const { ttl, at } = args;
  return ttl != null && ttl <= at;
}

export function understandingRegionFor(kind: unknown) {
  return kind === 'preference' ? 'preferences' as const : 'memory' as const;
}

export function isMemoryAssertionCurrentlyValid(args: {
  validFrom: string | null | undefined; validUntil: string | null | undefined; conditions: readonly string[];
  at: string; scopeContext: string | undefined; scopeConditions: readonly string[] | undefined;
}) {
  const { validFrom, validUntil, conditions, at, scopeContext, scopeConditions } = args;
  return !(validFrom != null && validFrom > at) && !(validUntil != null && validUntil <= at) &&
    conditions.every(c => c === scopeContext || scopeConditions?.includes(c));
}

export function claimScopeMatches(scopeKind: unknown, scopeObject: string | undefined, requestedContext: string | undefined, management?: boolean | undefined) {
  return scopeKind !== 'object' || management === true || scopeObject === requestedContext;
}

export function linkMatchesSource(linkKind: string, source: { kind?: string; tags?: readonly string[] } | null | undefined): source is { kind?: string; tags?: readonly string[] } {
  return !!source && !(linkKind === 'concept' && source.kind !== 'concept') &&
    !(linkKind === 'family' && !source.tags?.includes('question-family'));
}

export function findLinkRootWitness<W extends { id: string }>(basis: readonly W[], linkId: string) {
  return basis.find(item => item.id === linkId);
}

export function isFailedSettlement(status: string | undefined): status is 'failed' | 'unknown' {
  return status === 'failed' || status === 'unknown';
}

export function isLearnerAuthoredOrigin(author: string | undefined) {
  return author === 'learner';
}

export function linkKeyFor(kind: string, id: string) {
  return `${kind}:${id}`;
}

export function answerSentWitnessFragment(args: { itemId: string; slotId: 'answer'; contentIsString: boolean; contentLength?: number | undefined }) {
  const { itemId, slotId, contentIsString, contentLength } = args;
  return { itemId, slotId, ...(contentIsString && contentLength !== undefined ? { end: contentLength } : {}) };
}
