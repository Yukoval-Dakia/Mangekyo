import type { BusWitness, EvidenceEventV1, FactSnapshot } from '@mangekyo/kernel';
import { supportsAcrossDisciplines, type HypothesisStage, type MetacognitiveRead } from './belief-view.ts';
import { busWitnessKey, evidenceTime, isAttemptEvidenceType, scopedWitnessReader, witnessIdentity } from './memory-evidence.ts';
import type { RecurringErrorEvidence, RecurringErrorItemRef, RecurringErrorRead } from './recurring-error-cluster.ts';

type ErrorStage = NonNullable<EvidenceEventV1['error_stage']>;
type PaperItem = { readonly itemId: string; readonly number: number; readonly conceptIds: readonly string[] };

type PitfallRule = {
  readonly ref: BusWitness;
  readonly errorStage: ErrorStage;
  readonly conceptIds: readonly string[];
  readonly basis: readonly BusWitness[];
} & ({ readonly kind: 'misconception' | 'metacognitive_habit'; readonly stage: HypothesisStage }
   | { readonly kind: 'sticky' });

export type PreSubmitPitfallRead = RecurringErrorRead & {
  // Open the cited frozen item, its independent observation and its discipline
  // in this reader's recipient snapshot. All dependencies must occur in rule.basis.
  observeDiscipline?: MetacognitiveRead['observe'];
  // Activity opens the current frozen practice/mock edition with its full source basis.
  openPaper(scope: RecurringErrorRead['scope'], paper: BusWitness): Promise<{
    readonly ref: BusWitness;
    readonly items: readonly PaperItem[];
    readonly basis: readonly BusWitness[];
  } | undefined>;
};

export type PreSubmitPitfallInput = Parameters<RecurringErrorRead['openItem']>[2] & {
  readonly paper: BusWitness;
  readonly history: readonly RecurringErrorItemRef[];
  // Owner-resolved applicability, lifecycle and complete basis in the same
  // snapshot. For a habit this includes its cross-discipline qualification.
  readonly rules: readonly PitfallRule[];
};

export type PreSubmitPitfall = {
  readonly text: string;
  readonly anchors: readonly Pick<PaperItem, 'itemId' | 'number'>[];
};

// Only fixed process prompts cross the submission boundary. Rule text, old
// answers, explanations and current question content never become prompt copy.
const checks = {
  reading: '重读题干，条件和限制都看全了吗？',
  modeling: '核对已知和所求，表示一致吗？',
  strategy: '所选方法符合题设条件吗？',
  execution: '逐步回查，有漏算或抄错吗？',
  expression: '答案写完整了吗？检查格式要求。',
} satisfies Record<ErrorStage, string>;

function fields(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  return undefined;
}

function supportRows(value: unknown, basis: readonly BusWitness[]) {
  if (!Array.isArray(value) || !value.length) return undefined;
  const cited = new Set<string>();
  for (const entry of value) {
    const citation = fields(entry);
    if (!citation) return undefined;
    const ref = basis.find(ref => ref.id === citation.id && ref.rev === citation.rev && ref.accessEpoch === citation.accessEpoch);
    if (!ref) return undefined;
    if (citation.direction === 'support' && typeof citation.anchor === 'string')
      cited.add(JSON.stringify([witnessIdentity(ref), citation.anchor]));
  }
  return cited;
}

async function isCurrentSticky(fact: FactSnapshot, value: Readonly<Record<string, unknown>>, basis: readonly BusWitness[],
  purpose: string, open: ReturnType<typeof scopedWitnessReader>['open']) {
  if (fact.type !== 'companion.claim' || value.version !== 1 || value.authority !== 'directive' ||
      value.sticky !== true || value.category !== 'claim' || typeof value.text !== 'string' || value.valid_until !== null) return false;
  if (value.origin === 'learner') return value.action === 'remember' || value.action === 'correct';
  if (value.origin !== 'turn' || value.action !== 'correct' || !Array.isArray(value.evidence_refs) ||
      value.evidence_refs.length !== 1) return false;
  const quote = fields(value.evidence_refs[0]);
  if (!quote || typeof quote.rev !== 'number' || !Number.isSafeInteger(quote.rev) || quote.rev < 1 ||
      typeof quote.accessEpoch !== 'string' || !/^(0|[1-9]\d*)$/.test(quote.accessEpoch) ||
      typeof quote.start !== 'number' || !Number.isSafeInteger(quote.start) || quote.start < 0 ||
      typeof quote.excerpt !== 'string' || !quote.excerpt.length || quote.excerpt.trim() !== value.text.trim()) return false;
  for (const witness of basis) {
    if (witness.type !== 'activity.studyTurn' || witness.id !== quote.id) continue;
    const turn = await open(witness);
    if (!turn) continue;
    const delta = turn.ref.rev - quote.rev;
    const floor = turn.equivalentSince;
    if (delta < 0 || (delta > 0 && (purpose !== 'teaching' || witness.mode !== 'following' ||
        floor?.purpose !== purpose || floor.rev > quote.rev)) ||
        BigInt(turn.accessEpoch) - BigInt(quote.accessEpoch) !== BigInt(delta)) continue;
    const source = fields(turn.value);
    if (source?.caseId === 'companion' && source.memoryVersion === 1 && typeof source.workspaceRevision === 'string' &&
        typeof source.answer === 'string' && source.answer.slice(quote.start, quote.start + quote.excerpt.length) === quote.excerpt) return true;
  }
  return false;
}

export async function projectPreSubmitPitfalls(read: PreSubmitPitfallRead, input: PreSubmitPitfallInput):
Promise<PreSubmitPitfall[]> {
  const {scope} = read;
  const {paper, asOfAt, observedThrough} = input;
  const asOf = evidenceTime(asOfAt);
  if (!Number.isFinite(asOf) || !scope.purpose.trim() || !scope.recipient.trim() ||
      paper.type !== 'activity.workbookPaper' || paper.mode !== 'following' || !input.rules.length) return [];

  const {open, canOpen} = scopedWitnessReader(read);
  if (!await open(paper)) return [];
  const frozen = await read.openPaper(scope, paper);
  if (!frozen || busWitnessKey(frozen.ref) !== busWitnessKey(paper) || !await canOpen(frozen.basis)) return [];
  const items = frozen.items.toSorted((a, b) => a.number - b.number);
  if (new Set(items.map(item => item.itemId)).size !== items.length ||
      items.some((item, index) => !item.itemId.trim() || item.number !== index + 1)) return [];
  const paperConcepts = new Set(items.flatMap(item => item.conceptIds));

  const rules = (await Promise.all(input.rules.map(async rule => {
    const concepts = new Set(rule.conceptIds.filter(id => paperConcepts.has(id)));
    if (!concepts.size || !Object.hasOwn(checks, rule.errorStage) || rule.ref.mode !== 'following') return;
    if (rule.kind !== 'sticky' && (rule.stage !== 'supported' && rule.stage !== 'relapsed')) return;
    const fact = await open(rule.ref);
    const value = fields(fact?.value);
    if (!fact || !value) return;
    const cited = rule.kind === 'sticky' ? null : supportRows(value.evidence_refs, rule.basis);
    if (rule.kind === 'sticky') {
      if (!await isCurrentSticky(fact, value, rule.basis, scope.purpose, open)) return;
    } else {
      if (fact.type !== 'companion.memoryAssertion' || !cited?.size) return;
      if (rule.kind === 'misconception' && value.kind !== 'misconception') return;
      if (rule.kind === 'metacognitive_habit') {
        // Companion persists an objective hypothesis as a v2 observation.
        // The cross-discipline qualification belongs to the learner read model.
        if (value.version !== 2 || value.kind !== 'observation' || fields(value.belief)?.forgotten !== false ||
            !Array.isArray(value.evidence_refs) ||
            !read.observeDiscipline || (scope.purpose !== 'teaching' && scope.purpose !== 'background-research')) return;
        const refs = new Map(rule.basis.map(w => [JSON.stringify([witnessIdentity(w), w.mode]), w]));
        const qualifies = await supportsAcrossDisciplines(value.evidence_refs, {
          learner: scope.learner, purpose: scope.purpose, observe: read.observeDiscipline.bind(read),
          async reopen(ref, options) {
            const witness = refs.get(JSON.stringify([witnessIdentity(ref), options.mode]));
            return witness && open(witness);
          },
        }, {validAt: asOfAt, knownAt: asOfAt}, observedThrough);
        if (!qualifies) return;
      }
    }
    if (value.ttl != null && (typeof value.ttl !== 'string' || !(asOf < evidenceTime(value.ttl)))) return;
    if (!await canOpen(rule.basis)) return;
    return {rule, concepts, cited, activities: new Set<string>(), submissions: new Set<string>(), matched: new Set<string>()};
  }))).filter(rule => rule !== undefined);
  if (!rules.length) return [];

  const cutoff = {asOfAt, observedThrough};
  const through = BigInt(observedThrough);
  async function openHistory(item: RecurringErrorItemRef): Promise<RecurringErrorEvidence | undefined> {
    if (item.submission.learner !== scope.learner || !isAttemptEvidenceType(item.submission.type) || !item.itemId.trim()) return;
    const row = await read.openItem(scope, item, cutoff);
    if (!row || busWitnessKey(row.submission) !== busWitnessKey(item.submission) || row.itemId !== item.itemId ||
        row.activity.id === paper.id || !row.basis.length) return;
    const {evaluation, event} = row;
    if (!evaluation || evaluation.concept.type !== 'content.asset' || evaluation.concept.mode !== 'following' ||
        !event.concept_ids.includes(evaluation.concept.id) || event.outcome !== 'incorrect' || event.help_level !== 'independent' ||
        event.ref !== row.submission.id || event.rev !== row.submission.rev ||
        !(evidenceTime(event.occurred_at) <= asOf) || BigInt(row.admittedAt) > through) return;
    const concept = fields((await open(evaluation.concept))?.value);
    if (concept?.kind !== 'concept' || !await canOpen([row.activity, row.submission, row.source.ref, row.grade,
      evaluation.ref, ...row.basis, ...evaluation.basis])) return;
    return row;
  }

  const history = [...new Map(input.history.map(item =>
    [JSON.stringify([busWitnessKey(item.submission), item.itemId]), item])).values()];
  for (let i = 0; i < history.length; i += 16) {
    const rows = await Promise.all(history.slice(i, i + 16).map(openHistory));
    for (const row of rows) {
      if (!row?.evaluation) continue;
      const concept = row.evaluation.concept.id;
      const support = JSON.stringify([witnessIdentity(row.submission), row.itemId]);
      for (const candidate of rules) {
        const {rule, concepts, cited, submissions, activities, matched} = candidate;
        if (!concepts.has(concept) || rule.errorStage !== row.event.error_stage) continue;
        if (rule.kind === 'sticky') {
          // The current directive and the historical assignment have each
          // reopened in their own mode. Compare the editions they identify.
          if (!row.event.claim_ids.includes(rule.ref.id) ||
              !row.basis.some(w => w.learner === rule.ref.learner && w.type === rule.ref.type &&
                w.id === rule.ref.id && w.rev === rule.ref.rev && w.accessEpoch === rule.ref.accessEpoch)) continue;
        } else if (!cited?.has(support)) continue;
        matched.add(concept);
        if (submissions.has(row.submission.id)) continue;
        submissions.add(row.submission.id);
        activities.add(row.activity.id);
      }
    }
  }

  const ranked = rules.filter(item => item.activities.size >= 2).sort((a, b) =>
    b.activities.size - a.activities.size || Number(b.rule.kind === 'sticky') - Number(a.rule.kind === 'sticky') ||
    a.rule.ref.id.localeCompare(b.rule.ref.id));
  const result: PreSubmitPitfall[] = [];
  const shown = new Set<string>();
  for (const item of ranked) {
    const text = checks[item.rule.errorStage];
    const anchors = items.filter(slot => slot.conceptIds.some(id => item.matched.has(id)))
      .map(({itemId, number}) => ({itemId, number}));
    const key = JSON.stringify([text, anchors]);
    if (!anchors.length || shown.has(key)) continue;
    shown.add(key);
    result.push({text, anchors});
    if (result.length === 2) break;
  }
  return result;
}
