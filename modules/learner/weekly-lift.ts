import { factId, type FactId, type GatherContext } from '@mangekyo/kernel';
import { liftAssessment } from './intervention-lift-evidence.ts';
import { interventionLiftKey, interventionLiftMethod, interventionLiftType, type InterventionPair, type LiftInput,
  type LiftIdentity, type VerificationRef } from './intervention-lift.ts';
import { instant, openWitness, record } from './memory-evidence.ts';
import type { RetentionObservation } from './retention.ts';

const followupMs = 14 * 86_400_000;
export const liftPurpose = 'background-research';

export function weeklyLiftCutoff(at: string) {
  const date = new Date(instant(at));
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

export function isWeeklyLiftCutoff(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24 || !value.endsWith('T00:00:00.000Z')) return false;
  const date = new Date(value);
  return date.getUTCDay() === 1 && date.toISOString() === value;
}

export function weeklyLiftWork(playbookId: FactId, version: number, at: string) {
  return {
    slotType: interventionLiftType,
    slotKey: interventionLiftKey(playbookId, version),
    deriver: interventionLiftMethod,
    asOf: weeklyLiftCutoff(at),
  };
}

type OpenedAssessment = {
  submission: VerificationRef;
  item: string;
  comparisonKey: string;
  observation: RetentionObservation;
};

type OpenedPair = Omit<InterventionPair, keyof LiftIdentity | 'baseline' | 'posttest'> & {
  plannedAt: string;
  // Authorized source families of the frozen items, including copies and translations.
  baselineFamily: string | null;
  posttestFamily: string | null;
  baseline: OpenedAssessment | null;
  posttest: OpenedAssessment | null;
};

// The activity adapter reopens the prospectively frozen assignment, actual
// delivery and formal item-level judgments through ctx.read. Only evidence
// recorded by asOf can count. Return null when the complete delivered cohort
// cannot be established. Keep known deliveries with denied arms as missing.
export type ReopenLiftCohort = (
  ctx: GatherContext, identity: LiftIdentity, asOf: string,
) => Promise<readonly OpenedPair[] | null>;

export async function reopenWeeklyLift(
  ctx: GatherContext, identity: LiftIdentity, asOf: string, read: ReopenLiftCohort,
): Promise<LiftInput> {
  if (!isWeeklyLiftCutoff(asOf)) throw new Error('Lift 截止时刻须为 UTC 周一零时。');
  const cohort = await read(ctx, identity, asOf);
  const interventions: InterventionPair[] = [];
  const families = new Map<string, number>();
  const rows = (cohort ?? []).filter(pair => instant(pair.deliveredAt) <= asOf)
    .sort((a, b) => a.intervention.id === b.intervention.id ? 0 : a.intervention.id < b.intervention.id ? -1 : 1);
  const closesByCutoff = (pair: OpenedPair) => Date.parse(pair.deliveredAt) + followupMs <= Date.parse(asOf);
  for (const pair of rows.filter(closesByCutoff)) {
    for (const family of [pair.baselineFamily, pair.posttestFamily]) {
      if (family) families.set(family, (families.get(family) ?? 0) + 1);
    }
  }
  for (const row of rows) {
    const {plannedAt, baselineFamily, posttestFamily, baseline, posttest, ...pair} = row;
    await openWitness(ctx.read, pair.intervention, liftPurpose);
    const distinct = baselineFamily && posttestFamily &&
      families.get(baselineFamily) === 1 && families.get(posttestFamily) === 1;
    const prospectivelyPaired = closesByCutoff(row) && distinct && instant(plannedAt) < pair.deliveredAt;
    const assessment = (arm: OpenedAssessment | null) => prospectivelyPaired && arm
      ? liftAssessment(ctx, arm.submission, arm.observation, {...arm, asOf}) : null;
    interventions.push({...identity, ...pair, baseline: await assessment(baseline), posttest: await assessment(posttest)});
  }
  return {...identity, asOf, interventions};
}

type PythonLift = (method: string, input: LiftInput) => Promise<
  {kind: 'failed'; reason: string} |
  {kind: 'ok'; outcome: {kind: 'unknown'; reason: string} | {kind: 'value'; value: unknown}}
>;

export async function runSealedWeeklyLift(input: LiftInput, derive: PythonLift) {
  if (!isWeeklyLiftCutoff(input.asOf)) throw new Error('Lift 截止时刻须为 UTC 周一零时。');
  const result = await derive(interventionLiftMethod, input);
  if (result.kind === 'failed') return result;
  if (result.outcome.kind === 'unknown') return result.outcome;
  // The Python host validates the result against the sealed input.
  return {kind: 'value' as const, value: {...record(result.outcome.value), asOf: input.asOf}};
}

export function weeklyLiftIdentity(key: string): Omit<LiftIdentity, 'strategyId'> {
  const value: unknown = JSON.parse(key);
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' ||
      typeof value[1] !== 'number' || !Number.isSafeInteger(value[1]) || value[1] < 1 ||
      interventionLiftKey(value[0], value[1]) !== key)
    throw new Error('Lift 需要当前策略版本的槽键。');
  return {playbookId: factId(value[0]), version: value[1]};
}

export function weeklyLiftExpiry(asOf: string) {
  return new Date(Date.parse(asOf) + 7 * 86_400_000).toISOString();
}
