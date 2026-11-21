import type { BusWitness, CanonicalEvidenceSliceV1, FactSnapshot, Revision, Tick } from '@mangekyo/kernel';
import { allows, evidenceTime, scopedWitnessReader, type EvidenceReadScope } from './memory-evidence.ts';

export type OwnWordsTakeawayScope = EvidenceReadScope;

/**
 * Activity supplies this only after the learner pressed the hint control and the
 * L0 takeaway text was actually painted. Prepared, offered, opened, saved or
 * post-submit displays cannot be represented by this type.
 */
export type L0TakeawayDisplay = {
  readonly display: BusWitness;
  readonly content: BusWitness;
  readonly admittedAt: Tick;
  readonly activityId: string;
  readonly itemId: string;
  readonly issuance: { readonly id: string; readonly rev: Revision };
  readonly learnerRequested: true;
};

export type OwnWordsTakeawayInput = {
  readonly scope?: OwnWordsTakeawayScope;
  readonly takeaway: BusWitness;
  readonly takeawayAdmittedAt: Tick;
  readonly concept: BusWitness;
  readonly submission: BusWitness;
  readonly submissionAdmittedAt: Tick;
  readonly itemId: string;
  readonly slice: CanonicalEvidenceSliceV1;
  readonly l0Display?: L0TakeawayDisplay | undefined;
  readonly phase: 'during-attempt' | 'post-submit';
};

export type OwnWordsTakeawayRead = {
  readonly scope: OwnWordsTakeawayScope;
  reopen(scope: OwnWordsTakeawayScope, ref: BusWitness): Promise<FactSnapshot | undefined>;
};

export type OwnWordsTakeawayResult =
  | { readonly kind: 'hidden'; readonly reason: 'not-requested' | 'not-displayed' | 'not-authorized' | 'stale-evidence' | 'unknown' }
  | { readonly kind: 'echo'; readonly text: string; readonly evidence: readonly BusWitness[] }
  | { readonly kind: 'positive-review'; readonly concept: string; readonly submittedAt: string;
      readonly takeawayAdmittedAt: Tick; readonly submissionAdmittedAt: Tick; readonly evidence: readonly BusWitness[] }
  | { readonly kind: 'error-review'; readonly text: string; readonly errorStage: NonNullable<CanonicalEvidenceSliceV1['events'][number]['error_stage']>; readonly evidence: readonly BusWitness[] };

type Fields = Readonly<Record<string, unknown>>;
const errorStages = new Set(['reading', 'modeling', 'strategy', 'execution', 'expression']);

function fields(value: unknown): Fields | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
}

function sameWitness(left: BusWitness, right: BusWitness) {
  return left.learner === right.learner && left.id === right.id && left.rev === right.rev &&
    left.accessEpoch === right.accessEpoch && left.type === right.type && left.mode === right.mode;
}

function sameRef(left: unknown, right: BusWitness) {
  const row = fields(left);
  return !!row && row.id === right.id && row.rev === right.rev;
}

function validTick(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

function witnessBasis(value: unknown): readonly Fields[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 48) return undefined;
  const rows = value.map(fields).filter((row): row is Fields => row !== undefined);
  if (rows.length !== value.length) return undefined;
  return rows.every(row => typeof row.id === 'string' && Number.isSafeInteger(row.rev) &&
    Number(row.rev) >= 1 && typeof row.accessEpoch === 'string' && validTick(row.accessEpoch)) ? rows : undefined;
}

function takeawayText(fact: FactSnapshot | undefined, concept: BusWitness): string | undefined {
  const value = fields(fact?.value);
  const object = fields(value?.scope);
  const basis = witnessBasis(object?.basis);
  if (!fact || fact.type !== 'companion.claim' || !value || !object || !basis ||
      value.version !== 1 || value.authority !== 'directive' || value.category !== 'claim' ||
      value.sticky !== true || value.valid_until !== null || typeof value.text !== 'string' ||
      !value.text.trim() || value.text.length > 60 || !value.text.isWellFormed() || value.text.includes('\0') ||
      object.kind !== 'object' || object.object !== concept.id ||
      !basis.some(ref => ref.id === concept.id && Number(ref.rev) === concept.rev &&
        ref.accessEpoch === concept.accessEpoch)) return undefined;
  if (value.origin !== 'learner' || (value.action !== 'remember' && value.action !== 'correct') ||
      !Array.isArray(value.evidence_refs) || value.evidence_refs.length !== 0) return undefined;
  return value.text;
}

function submissionEvent(input: OwnWordsTakeawayInput) {
  const event = input.slice.events.filter(row => row.ref === input.submission.id && row.rev === input.submission.rev);
  return event.length === 1 ? event[0]! : undefined;
}

async function displayIsValid(read: OwnWordsTakeawayRead, scope: OwnWordsTakeawayScope,
  input: OwnWordsTakeawayInput, text: string): Promise<boolean> {
  const display = input.l0Display;
  if (!display || display.learnerRequested !== true || display.itemId !== input.itemId ||
      !display.activityId.trim() || !sameWitness(display.content, input.takeaway) ||
      !validTick(display.admittedAt) || !validTick(input.submissionAdmittedAt) ||
      !validTick(input.slice.clock_watermark) ||
      !(BigInt(display.admittedAt) < BigInt(input.submissionAdmittedAt)) ||
      BigInt(display.admittedAt) > BigInt(input.slice.clock_watermark)) return false;
  const { open } = scopedWitnessReader({ scope, reopen: read.reopen });
  const [displayFact, contentFact] = await Promise.all([open(display.display), open(display.content)]);
  const value = fields(displayFact?.value);
  const mount = fields(value?.mount);
  const issuance = fields(mount?.issuance);
  const item = fields(mount?.item);
  return !!displayFact && displayFact.type === 'activity.helpExposure' && !!value && !!mount && !!issuance && !!item &&
    value.kind === 'displayed' && value.learnerRequested === true && mount.activityId === display.activityId &&
    issuance.id === display.issuance.id && issuance.rev === display.issuance.rev &&
    item.itemId === input.itemId && sameRef(value.content, display.content) &&
    (Array.isArray(value.alsoAppliesTo) ? value.alsoAppliesTo.length === 0 : true) &&
    fields(value.step)?.kind === 'hint' && fields(value.step)?.order === 1 &&
    takeawayText(contentFact, input.concept) === text;
}

export async function projectOwnWordsTakeaway(read: OwnWordsTakeawayRead, input: OwnWordsTakeawayInput): Promise<OwnWordsTakeawayResult> {
  const scope = input.scope ?? read.scope;
  if (scope.learner !== read.scope.learner || !scope.purpose.trim() || !scope.recipient.trim() ||
      !validTick(input.submissionAdmittedAt) || !validTick(input.slice.clock_watermark) ||
      !validTick(input.takeawayAdmittedAt) || !(BigInt(input.takeawayAdmittedAt) < BigInt(input.submissionAdmittedAt)) ||
      BigInt(input.takeawayAdmittedAt) > BigInt(input.slice.clock_watermark) ||
      BigInt(input.submissionAdmittedAt) > BigInt(input.slice.clock_watermark) ||
      !Number.isFinite(evidenceTime(input.slice.as_of_at)))
    return { kind: 'hidden', reason: 'unknown' };
  const reader = { scope, reopen: read.reopen };
  const { open, canOpen } = scopedWitnessReader(reader);
  const [takeaway, concept] = await Promise.all([open(input.takeaway), open(input.concept)]);
  const text = takeawayText(takeaway, input.concept);
  const event = submissionEvent(input);
  const occurredAt = event ? evidenceTime(event.occurred_at) : undefined;
  if (!text || !concept || !allows(concept.purpose, scope.purpose) || !event ||
      input.submission.learner !== scope.learner || input.takeaway.learner !== scope.learner ||
      input.concept.learner !== scope.learner || input.submission.mode !== 'following' ||
      input.takeaway.mode !== 'following' || input.concept.mode !== 'following' ||
      input.concept.type !== 'content.asset' || !event.concept_ids.includes(input.concept.id) ||
      occurredAt === undefined || !Number.isFinite(occurredAt) || occurredAt > evidenceTime(input.slice.as_of_at) ||
      (event.outcome !== 'correct' && event.outcome !== 'incorrect'))
    return { kind: 'hidden', reason: 'stale-evidence' };

  if (input.phase === 'during-attempt') {
    if (input.l0Display?.learnerRequested !== true || event.help_level !== 'hinted')
      return { kind: 'hidden', reason: input.l0Display?.learnerRequested === true ? 'stale-evidence' : 'not-requested' };
    if (!await displayIsValid(reader, scope, input, text))
      return { kind: 'hidden', reason: 'not-displayed' };
    if (!await canOpen([input.takeaway, input.concept, input.l0Display.display, input.l0Display.content]))
      return { kind: 'hidden', reason: 'not-authorized' };
    return { kind: 'echo', text, evidence: [input.takeaway, input.l0Display.display] };
  }

  const displayed = input.l0Display && await displayIsValid(reader, scope, input, text);
  if (displayed || event.help_level !== 'independent') return { kind: 'hidden', reason: 'stale-evidence' };
  if (!await canOpen([input.takeaway, input.concept, input.submission])) return { kind: 'hidden', reason: 'not-authorized' };
  const evidence = [input.takeaway, input.submission, input.concept] as const;
  if (event.outcome === 'correct') {
    return { kind: 'positive-review', concept: input.concept.id, submittedAt: event.occurred_at,
      takeawayAdmittedAt: input.takeawayAdmittedAt, submissionAdmittedAt: input.submissionAdmittedAt, evidence };
  }
  const errorStage = event.error_stage;
  return errorStage && errorStages.has(errorStage)
    ? { kind: 'error-review', text, errorStage, evidence }
    : { kind: 'hidden', reason: 'unknown' };
}
