import type { FactSnapshot } from '@mangekyo/kernel';
import { witnessIdentity } from '@mangekyo/module-learner/facts/memory-evidence';
import { preSubmitRevisionWitness } from '@mangekyo/module-learner/facts/pre-submit-process';
import { hypothesisStatus, memoryReceipt, saveBeliefCommand } from './belief.ts';
import { applyClaimCommand, claimRef, claimText, claimType, ClaimInputError } from './claim.ts';
import { memoryAssertion, memoryAssertionType } from './memory-assertion.ts';
import type { MemoryRegion } from './recall-packet.ts';
import { reviewUnderstanding, teachingCitation, understandingPresentation, type ExtractedUnderstanding } from './understanding.ts';

const undoTokenPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUndoToken(value: unknown): value is string {
  return typeof value === 'string' && undoTokenPattern.test(value);
}

export function validateCompanionMemoryInput(input: Record<string, unknown>): { readonly text: string; readonly revision: number } | null {
  if (typeof input.text !== 'string' || input.text.length > 800 || !input.text.isWellFormed() || input.text.includes('\0') ||
      typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0) return null;
  return { text: input.text, revision: input.revision };
}

export function mergeDeliveredRanges(existing: readonly [number, number][], next: [number, number]): [number, number][] {
  const sorted = [...existing, next].sort((a, b) => a[0] - b[0]);
  const covered: [number, number][] = [];
  for (const range of sorted) {
    const last = covered.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else covered.push([range[0], range[1]]);
  }
  return covered;
}

export function extractDeliveredClaimRefs<TRef extends { readonly id: string; readonly rev: number; readonly type: string }>(
  claims: readonly unknown[],
  output: string,
  covered: readonly [number, number][],
  sent: readonly TRef[],
): TRef[] {
  const key = '"claims":';
  const offset = output.indexOf(key + JSON.stringify(claims));
  if (offset < 0) return [];
  const matched: TRef[] = [];
  let position = offset + key.length + 1;
  for (const item of claims) {
    const limit = position + JSON.stringify(item).length;
    if (item && typeof item === 'object' && 'id' in item && 'rev' in item &&
        covered.some(([from, to]) => from <= position && limit <= to)) {
      const ref = sent.find(entry => (entry.type === claimType || entry.type === memoryAssertionType) &&
        entry.id === item.id && entry.rev === item.rev);
      if (ref) matched.push(ref);
    }
    position = limit + 1;
  }
  return matched;
}

export function buildTurnMemoryLookupKeys(turns: readonly string[], keyFor: (turn: string, belief: boolean) => string) {
  return turns.flatMap(turn => [false, true].map(mode => ({
    turn, key: keyFor(turn, mode), type: mode ? saveBeliefCommand : applyClaimCommand,
  })));
}

export function groupRecoveredTurnReceipts(
  rows: readonly { readonly turn: string; readonly command: string; readonly id: string; readonly rev: number; readonly action: Parameters<typeof memoryReceipt>[2] }[],
  undoTokenFor: (command: string, id: string) => string,
) {
  return new Map([...Map.groupBy(rows, row => row.turn)].map(([turn, group]) => [turn,
    group.map(({ id, rev, action, command }) => ({ ...memoryReceipt(id, rev, action, undoTokenFor(command, id)), title: '记忆回执' }))]));
}

export function resolveClaimRecallRegion(
  claim: { readonly version: number; readonly category?: string; readonly action?: string; readonly valid_until?: string | null },
  management: boolean,
  at: string,
  requested: readonly MemoryRegion[],
): 'preferences' | 'claims' | null {
  const legacy = claim.version === 0;
  const region = !management && !legacy && (claim.category === 'preference' || claim.category === 'refusal') ? 'preferences' : 'claims';
  if (!requested.includes(region)) return null;
  if (!legacy && (claim.action === 'forget' || (claim.valid_until && claim.valid_until <= at))) return null;
  return region;
}

export function collectPreSubmitRevisions(sources: readonly { readonly fact: FactSnapshot }[], purpose: string) {
  const seen = new Set<string>();
  return sources.flatMap(source => {
    const revision = preSubmitRevisionWitness(source.fact, purpose);
    if (!revision) return [];
    const key = witnessIdentity(revision);
    if (seen.has(key)) return [];
    seen.add(key);
    return [revision];
  });
}

export function buildHypothesisRecallValue(
  fact: FactSnapshot,
  data: ExtractedUnderstanding,
  sources: Parameters<typeof reviewUnderstanding>[2] & readonly { readonly fact: FactSnapshot }[],
  purpose: string,
) {
  const preSubmitRevised = collectPreSubmitRevisions(sources, purpose);
  return {
    id: fact.ref.id, rev: fact.ref.rev, category: 'hypothesis' as const, kind: 'observation' as const,
    status: hypothesisStatus(data), text: data.text, scope: data.scope, evidence_refs: data.evidence_refs,
    review: reviewUnderstanding(fact.ref.id, data, sources),
    ...(preSubmitRevised.length ? { process: { preSubmitRevised } } : {}),
  };
}

export function buildUnderstandingRecallSpec(
  fact: FactSnapshot,
  value: ExtractedUnderstanding,
  sources: Parameters<typeof understandingPresentation>[1] & Parameters<typeof reviewUnderstanding>[2],
  requested: readonly MemoryRegion[],
) {
  const kind = understandingPresentation(value, sources);
  const region = kind === 'preference' ? 'preferences' as const : 'memory' as const;
  if (!requested.includes(region)) return null;
  return {
    region,
    value: {
      id: fact.ref.id, rev: fact.ref.rev, kind, text: value.text, scope: value.scope, ttl: value.ttl, sticky: value.sticky,
      evidence_refs: value.evidence_refs.map(teachingCitation), review: reviewUnderstanding(fact.ref.id, value, sources),
    },
  };
}

export function matchesMemoryAssertionScope(
  memory: ReturnType<typeof memoryAssertion>,
  at: string,
  context: string | undefined,
  activeConditions: readonly string[] | undefined,
): boolean {
  const { validFrom, validUntil, conditions = [] } = memory.scope;
  if ((validFrom && validFrom > at) || (validUntil && validUntil <= at)) return false;
  return conditions.every(condition => condition === context || activeConditions?.includes(condition));
}

export function buildManageExtractedInput(id: string, input: Record<string, unknown>, isBelief: boolean) {
  if (input.action !== 'correct' && input.action !== 'forget') throw new ClaimInputError('记忆操作无效。');
  const { rev, accessEpoch } = claimRef({ id, rev: input.rev, accessEpoch: input.accessEpoch });
  const action = input.action === 'forget' ? (isBelief ? 'forget-hypothesis' : 'forget-extracted') : 'correct-extracted';
  return {
    status: input.action === 'forget' ? 'withdrawn' as const : 'corrected' as const,
    commandInput: input.action === 'forget'
      ? { id, action, rev, accessEpoch }
      : { id, action: 'correct-extracted' as const, rev, accessEpoch, text: claimText(input.text, 600) },
  };
}

export function parseRevokeSourceInput(
  input: Record<string, unknown>,
  defaultPurpose: string,
  researchPurpose: string,
): { readonly ok: true; readonly expectedRev: number; readonly use: string } | { readonly ok: false; readonly message: string } {
  const { expectedRev } = input;
  if (typeof expectedRev !== 'number' || !Number.isSafeInteger(expectedRev) || expectedRev < 1 || expectedRev > 2_147_483_647)
    return { ok: false, message: '原话版本无效。' };
  const use = input.purpose === undefined ? defaultPurpose : input.purpose;
  if (use !== defaultPurpose && use !== researchPurpose) return { ok: false, message: '原话用途无效。' };
  return { ok: true, expectedRev, use };
}
