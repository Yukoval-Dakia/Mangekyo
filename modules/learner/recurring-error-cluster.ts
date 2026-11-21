import type { BusWitness, EvidenceEventV1, FactId, FactSnapshot, LearnerId, Tick } from '@mangekyo/kernel';
import type { HypothesisStage } from './belief-view.ts';
import { allows } from './memory-evidence.ts';

type ErrorStage = NonNullable<EvidenceEventV1['error_stage']>;
const errorStages: ReadonlySet<ErrorStage> = new Set(['reading', 'modeling', 'strategy', 'execution', 'expression']);
const readBatchSize = 16;

export type RecurringErrorItemRef = {
  readonly submission: BusWitness;
  readonly itemId: string;
};
type QuestionSource = { readonly ref: BusWitness; readonly itemId: string };

export type RecurringErrorEvidence = RecurringErrorItemRef & {
  readonly activity: BusWitness;
  // The source identifies the canonical question across copies, revisions and activities.
  readonly source: QuestionSource;
  readonly grade: BusWitness;
  readonly admittedAt: Tick;
  readonly event: EvidenceEventV1;
  readonly basis: readonly BusWitness[];
  readonly evaluation?: { readonly ref: BusWitness; readonly concept: BusWitness; readonly basis: readonly BusWitness[] };
  readonly misconceptions?: readonly {
    readonly ref: BusWitness; readonly stage: HypothesisStage; readonly basis: readonly BusWitness[];
  }[];
  readonly divergence?: { readonly text: string; readonly basis: readonly BusWitness[] };
};

type ReadScope = { readonly learner: LearnerId; readonly purpose: string; readonly recipient: string };
type Cutoff = { readonly asOfAt: string; readonly observedThrough: Tick };

export type RecurringErrorRead = {
  readonly scope: ReadScope;
  // Bind both methods to the same authorized learner snapshot and recipient. The Activity and
  // Evaluation readers bind the event, grade and optional divergence text to the exact frozen
  // submission item. The Hypothesis reader supplies current status and its complete evidence basis.
  // Unavailable reads return undefined. Transient failures propagate to the caller.
  openItem(scope: ReadScope, item: RecurringErrorItemRef, cutoff: Cutoff): Promise<RecurringErrorEvidence | undefined>;
  reopen(scope: ReadScope, ref: BusWitness): Promise<FactSnapshot | undefined>;
};

export type RecurringErrorClusterInput = Cutoff & {
  readonly current: RecurringErrorItemRef;
  // The host discovers item locators. They carry no authority until reopened.
  readonly history: readonly RecurringErrorItemRef[];
};

export type RecurringErrorAnchor = {
  readonly activityRef: BusWitness;
  readonly submissionRef: BusWitness;
  readonly itemId: string;
  readonly source: QuestionSource;
  readonly occurredAt: string;
  readonly errorStage?: ErrorStage;
  readonly divergenceSummary?: string;
};

export type RecurringErrorCluster = {
  // Includes the current wrong answer. Anchors contain only previous occurrences.
  readonly count: number;
  readonly anchors: readonly RecurringErrorAnchor[];
};

function witnessKey({ learner, id, rev, accessEpoch, type, mode }: BusWitness) {
  return JSON.stringify([learner, id, rev, accessEpoch, type, mode]);
}

function questionKey({ ref, itemId }: QuestionSource) {
  return JSON.stringify([ref.id, itemId]);
}

function asInstant(at: string) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(at) || at.startsWith('0000')) return NaN;
  const [seconds, fraction] = at.slice(0, -1).split('.');
  const normalized = seconds + '.' + (fraction ?? '').padEnd(3, '0') + 'Z';
  const time = Date.parse(normalized);
  return Number.isFinite(time) && new Date(time).toISOString() === normalized ? time : NaN;
}

function kindIs(fact: FactSnapshot | undefined, kind: string) {
  const value = fact?.value;
  return value !== null && typeof value === 'object' && 'kind' in value && value.kind === kind;
}

function hypothesisMatches(fact: FactSnapshot | undefined, row: RecurringErrorEvidence, basis: readonly BusWitness[]) {
  const value = fact?.value;
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'misconception') return false;
  const refs = value.evidence_refs;
  const linked = row.event.claim_ids.includes(fact.ref.id);
  if (!Array.isArray(refs)) return linked;
  let cited = false;
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) ||
        !basis.some(w => w.id === ref.id && w.rev === ref.rev && w.accessEpoch === ref.accessEpoch)) return false;
    cited ||= ref.id === row.submission.id && ref.rev === row.submission.rev &&
      ref.accessEpoch === row.submission.accessEpoch && ref.anchor === row.itemId && ref.direction === 'support';
  }
  return linked || cited;
}

function outputWitness({ learner, id, rev, accessEpoch, type, mode }: BusWitness): BusWitness {
  return { learner, id, rev, accessEpoch, type, mode };
}

type OpenedItem = {
  row: RecurringErrorEvidence;
  time: number;
  diagnoses: { key: string; kind: 'misconception' | 'evaluation' }[];
  stage: ErrorStage | undefined;
};

// An activity and a canonical question can each contribute once. Reassign a
// representative if that lets a different activity contribute its only question.
function distinctOccurrences<T>(rows: readonly T[], activity: (row: T) => FactId, question: (row: T) => string) {
  const byActivity = new Map<FactId, T[]>();
  for (const row of rows) {
    const key = activity(row);
    const group = byActivity.get(key);
    if (group) group.push(row);
    else byActivity.set(key, [row]);
  }
  const byQuestion = new Map<string, T>();
  function assign(candidates: readonly T[], seen: Set<string>): boolean {
    for (const row of candidates) {
      const key = question(row);
      if (seen.has(key)) continue;
      seen.add(key);
      const previous = byQuestion.get(key);
      if (previous && !assign(byActivity.get(activity(previous))!, seen)) continue;
      byQuestion.set(key, row);
      return true;
    }
    return false;
  }
  for (const candidates of byActivity.values()) assign(candidates, new Set());
  const selected = new Set(byQuestion.values());
  return rows.filter(row => selected.has(row));
}

export async function recurringErrorCluster(read: RecurringErrorRead, input: RecurringErrorClusterInput):
Promise<RecurringErrorCluster | null> {
  const { scope } = read;
  const cutoff = { asOfAt: input.asOfAt, observedThrough: input.observedThrough };
  const asOf = asInstant(cutoff.asOfAt);
  if (!Number.isFinite(asOf) || !scope.purpose.trim() || !scope.recipient.trim()) return null;
  const through = BigInt(cutoff.observedThrough);

  const reads = new Map<string, Promise<FactSnapshot | undefined>>();
  function reopen(ref: BusWitness) {
    if (ref.learner !== scope.learner || (ref.mode !== 'pinned' && ref.mode !== 'following'))
      return Promise.resolve(undefined);
    const key = witnessKey(ref);
    let opened = reads.get(key);
    if (!opened) {
      opened = read.reopen(scope, ref).then(fact => fact?.ref.learner === scope.learner &&
        fact.ref.id === ref.id && fact.ref.rev === ref.rev && fact.type === ref.type &&
        fact.accessEpoch === ref.accessEpoch && allows(fact.purpose, scope.purpose) ? fact : undefined);
      reads.set(key, opened);
    }
    return opened;
  }
  const canOpen = async (refs: readonly BusWitness[]) => (await Promise.all(refs.map(reopen))).every(Boolean);

  async function formalStage(row: RecurringErrorEvidence) {
    const { evaluation, event } = row;
    const stage = event.error_stage;
    if (!evaluation || !stage || !errorStages.has(stage) || evaluation.concept.type !== 'content.asset' ||
        evaluation.concept.mode !== 'following' || !event.concept_ids.includes(evaluation.concept.id)) return;
    const [concept, basis] = await Promise.all([
      reopen(evaluation.concept), canOpen([evaluation.ref, ...evaluation.basis]),
    ]);
    return basis && kindIs(concept, 'concept') ? stage : undefined;
  }

  async function misconceptionKeys(row: RecurringErrorEvidence) {
    return (await Promise.all((row.misconceptions ?? []).map(async ({ ref, stage, basis }) => {
      if (ref.type !== 'companion.memoryAssertion' || ref.mode !== 'following' ||
          (stage !== 'supported' && stage !== 'relapsed') || !basis.length) return;
      const [hypothesis, current] = await Promise.all([reopen(ref), canOpen(basis)]);
      return current && hypothesisMatches(hypothesis, row, basis) ? witnessKey(ref) : undefined;
    }))).filter(key => key !== undefined);
  }

  async function openItem(item: RecurringErrorItemRef, current?: OpenedItem): Promise<OpenedItem | undefined> {
    if (item.submission.learner !== scope.learner || !item.itemId.trim()) return;
    const row = await read.openItem(scope, item, cutoff);
    if (!row || witnessKey(row.submission) !== witnessKey(item.submission) || row.itemId !== item.itemId ||
        !row.source.itemId.trim() || !row.basis.length) return;
    const { event } = row;
    const time = asInstant(event.occurred_at);
    const admittedAt = BigInt(row.admittedAt);
    if (!(time <= asOf) || admittedAt > through || event.ref !== row.submission.id || event.rev !== row.submission.rev ||
        event.outcome !== 'incorrect' || event.help_level !== 'independent') return;
    if (current && (row.activity.id === current.row.activity.id || row.submission.id === current.row.submission.id ||
        questionKey(row.source) === questionKey(current.row.source) ||
        time > current.time || (time === current.time && admittedAt >= BigInt(current.row.admittedAt)))) return;
    if (!await canOpen([row.submission, row.activity, row.source.ref, row.grade, ...row.basis])) return;
    const [stage, keys] = await Promise.all([formalStage(row), misconceptionKeys(row)]);
    const diagnoses: OpenedItem['diagnoses'] = keys.map(key => ({ key, kind: 'misconception' }));
    if (stage && row.evaluation) diagnoses.push({ key: JSON.stringify([row.evaluation.concept.id, stage]), kind: 'evaluation' });
    return { row, time, diagnoses, stage };
  }

  const current = await openItem(input.current);
  if (!current?.diagnoses.length) return null;
  const order = (a: OpenedItem, b: OpenedItem) => b.time - a.time ||
    a.row.submission.id.localeCompare(b.row.submission.id) || a.row.itemId.localeCompare(b.row.itemId);
  const history: OpenedItem[] = [];
  const candidates = [...new Map(input.history.map(item =>
    [JSON.stringify([witnessKey(item.submission), item.itemId]), item])).values()];
  for (let i = 0; i < candidates.length; i += readBatchSize) {
    const batch = await Promise.all(candidates.slice(i, i + readBatchSize).map(item => openItem(item, current)));
    history.push(...batch.filter(item => item !== undefined));
  }
  history.sort(order);

  // Keep one diagnosis per cluster. Combining different diagnoses would count
  // errors that do not share the same cause with one another.
  let selected: { anchors: OpenedItem[]; diagnosis: OpenedItem['diagnoses'][number] } | undefined;
  for (const diagnosis of current.diagnoses) {
    const matching = history.filter(item => item.diagnoses.some(entry => entry.key === diagnosis.key));
    const anchors = distinctOccurrences(matching, item => item.row.activity.id, item => questionKey(item.row.source));
    if (!anchors.length) continue;
    if (!selected || (diagnosis.kind === 'misconception' && selected.diagnosis.kind === 'evaluation') ||
        (diagnosis.kind === selected.diagnosis.kind && (anchors.length > selected.anchors.length ||
          (anchors.length === selected.anchors.length && diagnosis.key < selected.diagnosis.key)))) {
      selected = { anchors, diagnosis };
    }
  }
  if (!selected) return null;
  const anchors = await Promise.all(selected.anchors.slice(0, 3).map(async ({ row, stage }) => {
    const { divergence, source } = row;
    const text = divergence?.text.trim();
    const withSummary = divergence && text && text.length <= 360 && text.isWellFormed() && !/[\r\n\0]/.test(text) &&
      divergence.basis.length > 0 && await canOpen(divergence.basis);
    return {
      activityRef: outputWitness(row.activity), submissionRef: outputWitness(row.submission), itemId: row.itemId,
      source: { ref: outputWitness(source.ref), itemId: source.itemId }, occurredAt: row.event.occurred_at,
      ...(stage ? { errorStage: stage } : {}),
      ...(withSummary ? { divergenceSummary: text } : {}),
    };
  }));
  return { count: 1 + selected.anchors.length, anchors };
}
