const identityKeys = ['playbookId', 'version', 'strategyId'];
const planKeys = ['plannedBaselineItem', 'plannedPosttestItem', 'comparisonKey'];
const minEligible = 8;
const day = 86_400_000;

function row(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}

function integer(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function bounded(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && value >= min && value <= max;
}

function timestamp(value: unknown): value is string {
  if (!matches(value, /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/)) return false;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) && at.toISOString() === value;
}

type VerificationRef = {id: string; rev: number; accessEpoch: string};
function witness(value: unknown): value is VerificationRef {
  return row(value, ['id', 'rev', 'accessEpoch']) && matches(value.id, /^[0-9A-HJKMNP-TV-Z]{26}$/) &&
    integer(value.rev, 1) && matches(value.accessEpoch, /^(0|[1-9][0-9]*)$/);
}

type Assessment = {submission: VerificationRef; item: string; comparisonKey: string; occurredAt: string;
  novelty: unknown; independence: unknown; score: number | null};
function assessment(value: unknown): value is Assessment | null {
  return value === null || (row(value, ['item', 'comparisonKey', 'submission', 'occurredAt', 'novelty', 'independence', 'score']) &&
    witness(value.submission) && timestamp(value.occurredAt) &&
    typeof value.item === 'string' && typeof value.comparisonKey === 'string' &&
    ['same', 'isomorphic', 'transfer', 'unknown'].includes(value.novelty as string) &&
    ['independent', 'assisted', 'unknown'].includes(value.independence as string) &&
    (value.score === null || bounded(value.score, 0, 1)));
}

type Identity = {playbookId: string; version: number; strategyId: string};
type Pair = {deliveredAt: string; intervention: VerificationRef; baseline: Assessment | null; posttest: Assessment | null;
  plannedBaselineItem: string; plannedPosttestItem: string; comparisonKey: string};
type WireInput = Identity & {asOf: string; interventions: readonly Pair[]};
export function isInterventionLiftInput(value: unknown): value is WireInput {
  return row(value, [...identityKeys, 'asOf', 'interventions']) &&
    matches(value.playbookId, /^[0-9A-HJKMNP-TV-Z]{26}$/) && integer(value.version, 1) &&
    typeof value.strategyId === 'string' && value.strategyId.trim().length > 0 && timestamp(value.asOf) &&
    Array.isArray(value.interventions) && [...value.interventions].every(pair =>
      row(pair, [...identityKeys, ...planKeys, 'intervention', 'deliveredAt', 'baseline', 'posttest']) &&
      pair.playbookId === value.playbookId && pair.strategyId === value.strategyId && pair.version === value.version &&
      planKeys.every(key => typeof pair[key] === 'string') && timestamp(pair.deliveredAt) &&
      witness(pair.intervention) && assessment(pair.baseline) && assessment(pair.posttest));
}

type WireOutcome = {kind: 'unknown'; reason: string} | {kind: 'value'; value: Record<string, unknown>};
export function isInterventionLiftOutcome(value: unknown, input: WireInput): value is WireOutcome {
  const asOf = Date.parse(input.asOf);
  const seen = new Set<string>();
  const refs: VerificationRef[] = [];
  let sum = 0, eligible = 0, pending = 0, unresolved = 0;
  for (const pair of input.interventions) {
    const start = Date.parse(pair.deliveredAt);
    if (start > asOf) continue;
    if (seen.has(pair.intervention.id)) return false;
    seen.add(pair.intervention.id);
    if (asOf < start + 14 * day) { pending++; continue; }
    refs.push(pair.intervention);
    const {baseline, posttest, plannedBaselineItem, plannedPosttestItem, comparisonKey} = pair;
    if (!baseline || !posttest || !plannedBaselineItem.trim() || !plannedPosttestItem.trim() || !comparisonKey.trim() ||
        plannedBaselineItem === plannedPosttestItem || baseline.item !== plannedBaselineItem ||
        posttest.item !== plannedPosttestItem || baseline.comparisonKey !== comparisonKey || posttest.comparisonKey !== comparisonKey ||
        baseline.independence !== 'independent' || posttest.independence !== 'independent' ||
        baseline.score === null || posttest.score === null || (posttest.novelty !== 'isomorphic' && posttest.novelty !== 'transfer') ||
        Date.parse(baseline.occurredAt) >= start || Date.parse(posttest.occurredAt) < start + 3 * day ||
        Date.parse(posttest.occurredAt) > start + 14 * day) {
      unresolved++;
      continue;
    }
    for (const ref of [baseline.submission, posttest.submission]) {
      if (seen.has(ref.id)) return false;
      seen.add(ref.id);
      refs.push(ref);
    }
    eligible++;
    sum += posttest.score - baseline.score;
  }
  if (eligible < minEligible)
    return row(value, ['kind', 'reason']) && value.kind === 'unknown' &&
      value.reason === `已满 14 天的可比独立前后测不足（${eligible}/${minEligible}）。`;
  if (!row(value, ['kind', 'value']) || value.kind !== 'value') return false;
  const result = value.value;
  if (!row(result, [...identityKeys, 'verdict', 'interval', 'pairedMean', 'eligible', 'pending', 'unresolved', 'verificationRefs']) ||
      result.playbookId !== input.playbookId || result.version !== input.version || result.strategyId !== input.strategyId ||
      result.eligible !== eligible || result.pending !== pending || result.unresolved !== unresolved ||
      result.pairedMean !== sum / eligible || !Array.isArray(result.interval) || result.interval.length !== 2 ||
      !Array.isArray(result.verificationRefs) || result.verificationRefs.length !== refs.length) return false;
  const closed = eligible + unresolved;
  const radius = Math.sqrt(2 * Math.log(40) / closed);
  const low = Math.max(-1, (sum - unresolved) / closed - radius);
  const high = Math.min(1, (sum + unresolved) / closed + radius);
  const [sentLow, sentHigh] = result.interval;
  const verdict = (lo: number, hi: number) => lo > 0 ? 'positive' : hi < 0 ? 'negative' : 'inconclusive';
  // libm and V8 may round the log/sqrt by an ulp. Never tolerate a change of verdict.
  if (!bounded(sentLow, -1, 1) || !bounded(sentHigh, sentLow, 1) || Math.abs(sentLow - low) > Number.EPSILON ||
      Math.abs(sentHigh - high) > Number.EPSILON || result.verdict !== verdict(low, high) ||
      result.verdict !== verdict(sentLow, sentHigh)) return false;
  return [...result.verificationRefs].every((sent, index) => {
    const ref = refs[index];
    return ref !== undefined && witness(sent) && sent.id === ref.id && sent.rev === ref.rev && sent.accessEpoch === ref.accessEpoch;
  });
}
