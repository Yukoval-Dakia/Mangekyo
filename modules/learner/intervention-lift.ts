import { factId, type FactId, type Outcome, type Revision, type Tick } from '@mangekyo/kernel';

export const interventionLiftType = 'learner.interventionLift';
export const interventionLiftMethod = 'learner/intervention-lift@1';

export type LiftIdentity = { playbookId: FactId; version: number; strategyId: string };
export type VerificationRef = { id: FactId; rev: Revision; accessEpoch: Tick };
export type LiftAssessment = {
  submission: VerificationRef;
  item: string;
  occurredAt: string;
  comparisonKey: string;
  novelty: 'same' | 'isomorphic' | 'transfer' | 'unknown';
  independence: 'independent' | 'assisted' | 'unknown';
  score: number | null;
};

// The activity host resolves frozen, prospectively paired tasks and their formal
// assessments in the gather snapshot. comparisonKey binds skill, scoring rubric,
// difficulty stratum and task conditions. Each intervention is one sampling unit.
export type InterventionPair = LiftIdentity & {
  intervention: VerificationRef;
  deliveredAt: string;
  plannedBaselineItem: string;
  plannedPosttestItem: string;
  comparisonKey: string;
  baseline: LiftAssessment | null;
  posttest: LiftAssessment | null;
};
export type LiftInput = LiftIdentity & { asOf: string; interventions: readonly InterventionPair[] };
export type InterventionLift = LiftIdentity & {
  verdict: 'positive' | 'negative' | 'inconclusive';
  pairedMean: number;
  interval: [number, number];
  eligible: number;
  unresolved: number;
  pending: number;
  verificationRefs: VerificationRef[];
};

const day = 86_400_000;
const minEligible = 8;
function instant(value: string) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error('干预时刻须为规范 UTC 时间。');
  return ms;
}

function checkRef(ref: VerificationRef) {
  factId(ref.id);
  if (!Number.isSafeInteger(ref.rev) || ref.rev < 1 || !/^(0|[1-9][0-9]*)$/.test(ref.accessEpoch)) {
    throw new Error('干预依据缺少有效修订或授权代次。');
  }
}

function validAssessment(value: LiftAssessment | null, item: string, comparison: string) {
  return value !== null && value.item === item && value.comparisonKey === comparison &&
    value.independence === 'independent' && value.score !== null && Number.isFinite(value.score) &&
    value.score >= 0 && value.score <= 1;
}

export function measureInterventionLift(input: LiftInput): Outcome<InterventionLift> {
  const { playbookId, version, strategyId } = input;
  factId(playbookId);
  if (!Number.isSafeInteger(version) || version < 1 || !strategyId.trim()) throw new Error('缺少策略版本。');
  const asOf = instant(input.asOf);
  const interventions = new Set<string>();
  const submissions = new Set<string>();
  const verificationRefs: VerificationRef[] = [];
  let sum = 0;
  let eligible = 0;
  let pending = 0;
  let unresolved = 0;
  for (const pair of input.interventions) {
    if (pair.playbookId !== playbookId || pair.version !== version || pair.strategyId !== strategyId) {
      throw new Error('干预与策略版本不符。');
    }
    checkRef(pair.intervention);
    const start = instant(pair.deliveredAt);
    if (start > asOf) continue;
    if (interventions.has(pair.intervention.id) || submissions.has(pair.intervention.id))
      throw new Error('同一干预被重复纳入。');
    interventions.add(pair.intervention.id);
    // Close the entire follow-up window before sampling, including nonresponders.
    if (asOf < start + 14 * day) { pending++; continue; }
    const before = pair.baseline;
    const after = pair.posttest;
    verificationRefs.push(pair.intervention);
    if (!before || !after || !pair.comparisonKey.trim() || !pair.plannedBaselineItem.trim() ||
        !pair.plannedPosttestItem.trim() || pair.plannedBaselineItem === pair.plannedPosttestItem ||
        !validAssessment(before, pair.plannedBaselineItem, pair.comparisonKey) ||
        !validAssessment(after, pair.plannedPosttestItem, pair.comparisonKey) ||
        before.score === null || after.score === null ||
        (after.novelty !== 'isomorphic' && after.novelty !== 'transfer') ||
        instant(before.occurredAt) >= start || instant(after.occurredAt) < start + 3 * day ||
        instant(after.occurredAt) > start + 14 * day) {
      unresolved++;
      continue;
    }
    for (const ref of [before.submission, after.submission]) {
      checkRef(ref);
      if (submissions.has(ref.id) || interventions.has(ref.id))
        throw new Error('同一提交不能重复充当独立前后测。');
      submissions.add(ref.id);
      verificationRefs.push(ref);
    }
    eligible++;
    sum += after.score - before.score;
  }
  if (eligible < minEligible) return {
    kind: 'unknown', reason: `已满 14 天的可比独立前后测不足（${eligible}/${minEligible}）。`,
  };
  const closed = eligible + unresolved;
  // Paired differences lie in [-1,1]. Bound each missing difference by its
  // worst case before applying a two-sided 95% bounded-difference interval.
  const radius = Math.sqrt(2 * Math.log(40) / closed);
  const interval: [number, number] = [Math.max(-1, (sum - unresolved) / closed - radius),
    Math.min(1, (sum + unresolved) / closed + radius)];
  let verdict: InterventionLift['verdict'] = 'inconclusive';
  if (interval[0] > 0) verdict = 'positive';
  if (interval[1] < 0) verdict = 'negative';
  return { kind: 'value', value: { playbookId, version, strategyId, verdict, interval,
    pairedMean: sum / eligible, eligible, pending, unresolved, verificationRefs } };
}
