// Pure helpers extracted from runtime/studio/research-understanding.ts.
// All tx, runEffect, db.snapshot stay in the runtime host;
// this module owns recipient predicates, window constants, and pure transport guards.

import type { FactSnapshot } from '@mangekyo/kernel';

export const understandingExtractionWindowMs = 86_400_000;

export function makeMayResearch(
  researchPurpose: string,
  turnEvidenceType: string,
  turnAllowsBackgroundUnderstanding: (fact: FactSnapshot) => boolean,
): (fact: FactSnapshot) => boolean {
  return fact =>
    fact.type === turnEvidenceType
      ? turnAllowsBackgroundUnderstanding(fact)
      : fact.purpose.includes(researchPurpose) || fact.purpose.includes('all');
}

export function makePaidExtractionRecipient(
  researchPurpose: string,
  workbookAttemptType: string,
  turnEvidenceType: string,
  turnAllowsBackgroundUnderstanding: (fact: FactSnapshot) => boolean,
): (fact: FactSnapshot) => boolean {
  return fact =>
    fact.purpose.includes(researchPurpose) &&
    (fact.type === workbookAttemptType ||
      (fact.type === turnEvidenceType && turnAllowsBackgroundUnderstanding(fact)));
}

export function assertZeroCostTransport(
  transport: { route: string; cost: number; sample: unknown } | undefined,
): asserts transport is { route: string; cost: 0; sample: unknown } {
  if (
    !transport ||
    !transport.route.trim() ||
    transport.cost !== 0 ||
    typeof transport.sample !== 'function'
  ) {
    throw new Error('个性化抽取只接受已授权的零成本模型传输。');
  }
}

export function selectExtractionRoute<Grant, Tariff>(args: {
  paid: { grant: Grant & { profile: string; route: string }; tariff: Tariff } | undefined;
  transport: { route: string; maySend?: (fact: FactSnapshot) => boolean } | undefined;
  extractorProfile: string;
  workerCap: (grant: Grant, tariff: Tariff) => number;
  paidRecipient: (fact: FactSnapshot) => boolean;
}): { maySend: ((fact: FactSnapshot) => boolean) | undefined; budgetCap: number; route: string } | null {
  const { paid, transport, extractorProfile, workerCap, paidRecipient } = args;
  if (!transport && !paid) return null;
  const budgetCap = paid ? workerCap(paid.grant, paid.tariff) : 0;
  const route = paid?.grant.route ?? transport!.route;
  if (paid && (!budgetCap || paid.grant.profile !== extractorProfile)) return null;
  return { maySend: paid ? paidRecipient : transport?.maySend, budgetCap, route };
}

export function extractionConsideredAt(expiresAtMs: number, windowMs: number): string {
  return new Date(expiresAtMs - windowMs).toISOString();
}

export function buildExtractedUnderstandingId(
  factIdFn: (v: string) => unknown,
  stableIdFn: (...p: string[]) => string,
  sourceId: string,
  sourceRev: number,
  anchor: string | undefined,
  index: number,
): unknown {
  return factIdFn(
    stableIdFn(
      'extracted-understanding-v1',
      sourceId,
      String(sourceRev),
      ...(anchor ? [anchor] : []),
      String(index),
    ),
  );
}

export function buildPublishUnderstandingCommandId(
  commandIdFn: (v: string) => unknown,
  stableIdFn: (...p: string[]) => string,
  todoId: string,
): unknown {
  return commandIdFn(stableIdFn('publish-understanding-v1', todoId));
}
