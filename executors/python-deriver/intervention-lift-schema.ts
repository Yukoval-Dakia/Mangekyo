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
  if (row(value, ['kind', 'reason']) && value.kind === 'unknown') {
    return matches(value.reason, /^已满 14 天的可比独立前后测不足（[0-7]\/8）。$/);
  }
  if (!row(value, ['kind', 'value']) || value.kind !== 'value') return false;
  const result = value.value;
  if (!row(result, [...identityKeys, 'verdict', 'interval', 'pairedMean', 'eligible', 'pending', 'unresolved', 'verificationRefs']) ||
      result.playbookId !== input.playbookId || result.version !== input.version || result.strategyId !== input.strategyId ||
      !integer(result.eligible, minEligible) || !integer(result.pending, 0) || !integer(result.unresolved, 0) ||
      !bounded(result.pairedMean, -1, 1) || !Array.isArray(result.interval) || result.interval.length !== 2) return false;
  const [low, high] = result.interval;
  if (!bounded(low, -1, 1) || !bounded(high, low, 1) ||
      result.verdict !== (low > 0 ? 'positive' : high < 0 ? 'negative' : 'inconclusive')) return false;
  const asOf = Date.parse(input.asOf);
  const delivered = input.interventions.filter(pair => Date.parse(pair.deliveredAt) <= asOf);
  const closed = delivered.filter(pair => Date.parse(pair.deliveredAt) + 14 * day <= asOf);
  if (result.eligible + result.unresolved !== closed.length || result.pending + closed.length !== delivered.length ||
      !Array.isArray(result.verificationRefs) ||
      result.verificationRefs.length !== closed.length + 2 * result.eligible) return false;
  const refs = result.verificationRefs;
  if (![...refs].every(witness)) return false;
  const indexed = new Map(refs.map(ref => [ref.id, ref]));
  const same = (ref: VerificationRef) => {
    const sent = indexed.get(ref.id);
    return sent?.rev === ref.rev && sent.accessEpoch === ref.accessEpoch;
  };
  const verified = closed.filter(pair => pair.baseline && pair.posttest &&
    same(pair.baseline.submission) && same(pair.posttest.submission));
  if (indexed.size !== refs.length || !closed.every(pair => same(pair.intervention)) ||
      verified.length !== result.eligible) return false;
  return verified.every(({baseline, posttest, plannedBaselineItem, plannedPosttestItem, comparisonKey, deliveredAt}) => {
    const delivered = Date.parse(deliveredAt);
    return baseline && posttest && baseline.independence === 'independent' && posttest.independence === 'independent' &&
      baseline.score !== null && posttest.score !== null && plannedBaselineItem !== plannedPosttestItem &&
      plannedBaselineItem.trim() && plannedPosttestItem.trim() && comparisonKey.trim() &&
      baseline.item === plannedBaselineItem && posttest.item === plannedPosttestItem &&
      baseline.comparisonKey === comparisonKey && posttest.comparisonKey === comparisonKey &&
      (posttest.novelty === 'isomorphic' || posttest.novelty === 'transfer') &&
      Date.parse(baseline.occurredAt) < delivered &&
      Date.parse(posttest.occurredAt) >= delivered + 3 * day && Date.parse(posttest.occurredAt) <= delivered + 14 * day;
  });
}
