import type { BusWitness, CanonicalEvidenceSliceV1, FactSnapshot, Revision, Tick } from '@mangekyo/kernel';
import { allows, evidenceTime, scopedWitnessReader, type EvidenceReadScope } from './memory-evidence.ts';

export type OwnWordsTakeawayScope = EvidenceReadScope;

/**
 * Activity supplies this only after the learner pressed the hint control and the
 * L0 takeaway text was actually painted. Prepared, offered, opened or saved
 * displays cannot be represented by this type.
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

export type OwnWordsTakeawayDuringAttemptInput = {
  readonly scope?: OwnWordsTakeawayScope;
  readonly takeaway: BusWitness;
  readonly takeawayAdmittedAt: Tick;
  readonly concept: BusWitness;
  readonly itemId: string;
  readonly clockWatermark: Tick;
  readonly l0Display?: L0TakeawayDisplay | undefined;
  readonly phase: 'during-attempt';
};

export type OwnWordsTakeawayPostSubmitInput = {
  readonly scope?: OwnWordsTakeawayScope;
  readonly takeaway: BusWitness;
  readonly takeawayAdmittedAt: Tick;
  readonly takeawaySavedAt?: string | undefined;
  readonly concept: BusWitness;
  readonly submission: BusWitness;
  readonly submissionAdmittedAt: Tick;
  readonly itemId: string;
  readonly slice: CanonicalEvidenceSliceV1;
  readonly exposureCoverage: 'complete' | 'incomplete';
  readonly l0Display?: L0TakeawayDisplay | undefined;
  readonly phase: 'post-submit';
};

export type OwnWordsTakeawayInput = OwnWordsTakeawayDuringAttemptInput | OwnWordsTakeawayPostSubmitInput;

export type OwnWordsTakeawayRead = {
  readonly scope: OwnWordsTakeawayScope;
  reopen(scope: OwnWordsTakeawayScope, ref: BusWitness): Promise<FactSnapshot | undefined>;
};

export type OwnWordsTakeawayResult =
  | { readonly kind: 'hidden'; readonly reason: 'not-requested' | 'not-displayed' | 'not-authorized' | 'stale-evidence' | 'unknown' }
  | { readonly kind: 'echo'; readonly text: string; readonly evidence: readonly BusWitness[] }
  | { readonly kind: 'positive-review'; readonly concept: string; readonly submittedAt: string;
      readonly takeawayAdmittedAt: Tick; readonly submissionAdmittedAt: Tick; readonly takeawaySavedAt?: string;
      readonly evidence: readonly BusWitness[] }
  | { readonly kind: 'error-review'; readonly text: string; readonly helpLevel: 'independent' | 'hinted';
      readonly errorStage: NonNullable<CanonicalEvidenceSliceV1['events'][number]['error_stage']>; readonly evidence: readonly BusWitness[] };

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

function atWatermark(ref: BusWitness, watermark: string): boolean {
  return validTick(ref.accessEpoch) && validTick(watermark) && BigInt(ref.accessEpoch) <= BigInt(watermark);
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
  if (!fact || (fact.type !== 'activity.ownWordsTakeaway' && fact.type !== 'companion.claim') || !value || !object || !basis ||
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

function submissionEvent(input: OwnWordsTakeawayPostSubmitInput) {
  const event = input.slice.events.filter(row => row.ref === input.submission.id && row.rev === input.submission.rev);
  return event.length === 1 ? event[0]! : undefined;
}

async function openedDisplay(read: OwnWordsTakeawayRead, scope: OwnWordsTakeawayScope,
  input: OwnWordsTakeawayInput): Promise<FactSnapshot | undefined> {
  const display = input.l0Display;
  const { open } = scopedWitnessReader({ scope, reopen: read.reopen });
  if (!display || !sameWitness(display.content, input.takeaway)) return undefined;
  const [openedDisplay, openedContent] = await Promise.all([open(display.display), open(display.content)]);
  if (!openedDisplay || !openedContent || takeawayText(openedContent, input.concept) === undefined) return undefined;
  return displayMatches(openedDisplay, input) ? openedDisplay : undefined;
}

function displayMatches(displayFact: FactSnapshot | undefined, input: OwnWordsTakeawayInput): boolean {
  const display = input.l0Display;
  const value = fields(displayFact?.value);
  const mount = fields(value?.mount);
  const issuance = fields(mount?.issuance);
  const item = fields(mount?.item);
  const step = fields(value?.step);
  const appliesToItem = Array.isArray(value?.alsoAppliesTo) &&
    value.alsoAppliesTo.some(row => fields(row)?.itemId === input.itemId);
  const matchesItem = input.phase === 'during-attempt' ? item?.itemId === input.itemId : (item?.itemId === input.itemId || appliesToItem);
  return !!display && !!displayFact && displayFact.type === 'activity.helpExposure' && !!value && !!mount && !!issuance && !!item &&
    display.learnerRequested === true && display.itemId === input.itemId && !!display.activityId.trim() &&
    mount.activityId === display.activityId && issuance.id === display.issuance.id && issuance.rev === display.issuance.rev &&
    value.kind === 'displayed' && value.learnerRequested === true && sameRef(value.content, display.content) &&
    matchesItem &&
    ((step?.kind === 'hint' && step.order === 1) || (step?.kind === 'hint_l0' && (step.order === 0 || step.order === 1)));
}

async function displayIsValid(read: OwnWordsTakeawayRead, scope: OwnWordsTakeawayScope,
  input: OwnWordsTakeawayInput, text: string): Promise<boolean> {
  const display = input.l0Display;
  if (!display) return false;
  const watermark = input.phase === 'during-attempt' ? input.clockWatermark : input.slice.clock_watermark;
  if (!validTick(display.admittedAt) || !validTick(watermark) || !atWatermark(display.display, watermark) ||
      !atWatermark(display.content, watermark) || BigInt(display.admittedAt) > BigInt(watermark)) return false;
  const { open } = scopedWitnessReader({ scope, reopen: read.reopen });
  const [openedDisplay, openedContent] = await Promise.all([open(display.display), open(display.content)]);
  return displayMatches(openedDisplay, input) && takeawayText(openedContent, input.concept) === text;
}

export async function projectOwnWordsTakeaway(read: OwnWordsTakeawayRead, input: OwnWordsTakeawayInput): Promise<OwnWordsTakeawayResult> {
  const scope = input.scope ?? read.scope;
  const watermark = input.phase === 'during-attempt' ? input.clockWatermark : input.slice.clock_watermark;
  if (scope.learner !== read.scope.learner || !scope.purpose.trim() || !scope.recipient.trim() ||
      !validTick(input.takeawayAdmittedAt) || BigInt(input.takeawayAdmittedAt) > BigInt(watermark) ||
      !atWatermark(input.takeaway, watermark) || !atWatermark(input.concept, watermark) ||
      (input.phase === 'post-submit' && (!validTick(input.submissionAdmittedAt) || !atWatermark(input.submission, watermark) ||
        BigInt(input.submissionAdmittedAt) > BigInt(watermark) || !Number.isFinite(evidenceTime(input.slice.as_of_at)))))
    return { kind: 'hidden', reason: 'unknown' };
  if (input.phase === 'during-attempt' && input.l0Display && (!validTick(input.l0Display.admittedAt) ||
      BigInt(input.takeawayAdmittedAt) > BigInt(input.l0Display.admittedAt) || BigInt(input.l0Display.admittedAt) > BigInt(watermark)))
    return { kind: 'hidden', reason: 'unknown' };
  const reader = { scope, reopen: read.reopen };
  const { open, canOpen } = scopedWitnessReader(reader);
  const [takeaway, concept] = await Promise.all([open(input.takeaway), open(input.concept)]);
  const text = takeawayText(takeaway, input.concept);
  if (!text || !concept || !allows(concept.purpose, scope.purpose) || input.takeaway.learner !== scope.learner ||
      input.concept.learner !== scope.learner || input.takeaway.mode !== 'following' || input.concept.mode !== 'following' ||
      input.concept.type !== 'content.asset') return { kind: 'hidden', reason: 'stale-evidence' };

  if (input.phase === 'during-attempt') {
    if (!input.l0Display) return { kind: 'hidden', reason: 'not-requested' };
    if (!await displayIsValid(reader, scope, input, text))
      return { kind: 'hidden', reason: 'not-displayed' };
    if (!sameWitness(input.l0Display.content, input.takeaway) ||
        !await canOpen([input.takeaway, input.concept, input.l0Display.display, input.l0Display.content]))
      return { kind: 'hidden', reason: 'not-authorized' };
    return { kind: 'echo', text, evidence: [input.takeaway, input.l0Display.display] };
  }

  const event = submissionEvent(input);
  const occurredAt = event ? evidenceTime(event.occurred_at) : undefined;
  if (!event || input.submission.learner !== scope.learner || input.submission.mode !== 'following' ||
      !event.concept_ids.includes(input.concept.id) || occurredAt === undefined || !Number.isFinite(occurredAt) ||
      occurredAt > evidenceTime(input.slice.as_of_at) ||
      (event.outcome !== 'correct' && event.outcome !== 'incorrect') || input.slice.omissions?.length)
    return { kind: 'hidden', reason: 'stale-evidence' };
  const savedAt = input.takeawaySavedAt === undefined ? undefined : evidenceTime(input.takeawaySavedAt);
  if ((savedAt !== undefined && (!Number.isFinite(savedAt) || savedAt > occurredAt)) ||
      !(BigInt(input.takeawayAdmittedAt) < BigInt(input.submissionAdmittedAt)))
    return { kind: 'hidden', reason: 'unknown' };
  const allowPreSubmitDisplay = event.outcome === 'incorrect' && event.help_level === 'hinted';
  if (input.l0Display) {
    if (!validTick(input.l0Display.admittedAt) || !validTick(input.submissionAdmittedAt) ||
        BigInt(input.l0Display.admittedAt) > BigInt(watermark) ||
        !atWatermark(input.l0Display.display, watermark) || !atWatermark(input.l0Display.content, watermark))
      return { kind: 'hidden', reason: 'unknown' };
    const preSubmit = BigInt(input.l0Display.admittedAt) < BigInt(input.submissionAdmittedAt);
    if (preSubmit && (!allowPreSubmitDisplay || BigInt(input.l0Display.admittedAt) < BigInt(input.takeawayAdmittedAt)))
      return { kind: 'hidden', reason: 'stale-evidence' };
    if (!await openedDisplay(reader, scope, input)) return { kind: 'hidden', reason: 'unknown' };
  }
  if (!await canOpen([input.takeaway, input.concept, input.submission,
    ...(input.l0Display ? [input.l0Display.display, input.l0Display.content] : [])])) return { kind: 'hidden', reason: 'not-authorized' };
  const evidence = [input.takeaway, input.submission, input.concept] as const;
  if (event.outcome === 'correct') {
    if (event.help_level !== 'independent' || input.exposureCoverage !== 'complete')
      return { kind: 'hidden', reason: 'unknown' };
    return { kind: 'positive-review', concept: input.concept.id, submittedAt: event.occurred_at,
      takeawayAdmittedAt: input.takeawayAdmittedAt, submissionAdmittedAt: input.submissionAdmittedAt,
      ...(input.takeawaySavedAt === undefined ? {} : {takeawaySavedAt: input.takeawaySavedAt}), evidence};
  }
  const errorStage = event.error_stage;
  return errorStage && errorStages.has(errorStage) && (event.help_level === 'independent' || event.help_level === 'hinted')
    ? { kind: 'error-review', text, helpLevel: event.help_level, errorStage, evidence }
    : { kind: 'hidden', reason: 'unknown' };
}
