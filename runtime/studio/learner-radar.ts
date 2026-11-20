import { guardAccess, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { derivationId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Outcome } from '../../kernel/src/declarations/types.ts';
import { parseManifest, type ManifestInput } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { isSourceFactId, sourceReference } from '../../modules/activity/source-values.ts';
import { workbookAttemptType, workbookPaper, workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { forecastType, reconciliationType, type RetentionForecast, type RetentionObservation, reconcileRetention } from '../../modules/learner/retention.ts';
import { purpose } from './identity.ts';
import { readLearningOverview } from './learning-overview.ts';
import { textSlice } from './reading.ts';
import type { SourceTrack, WorkspaceSourceRecipient } from './source-read.ts';
import { workspaceQuery } from './workspace-read.ts';

export type RadarSlot = Extract<ManifestInput, { kind: 'slot' }>;
type FactInput = Extract<ManifestInput, { kind: 'fact' }>;
export type RetentionBasis = { slot: RadarSlot; facts: FactInput[] };
type Access = { callerPurpose: string; maySend: WorkspaceSourceRecipient };
type Reconciliation = ReturnType<typeof reconcileRetention> & { forecastId: string; observedThrough: Tick };
type Selection = {
  id: string; slot_type: string; slot_key: string; deriver: string;
  effective_tick: Tick; value: Outcome<RetentionForecast | Reconciliation>; manifest: unknown;
};

// The controlled posttest publisher uses the same retention result contract.
// Its private fact types can support the result without opening their raw payloads to the companion.
const retentionPaper = 'activity.retentionPaper';
const posttestSubmission = 'activity.retentionPosttestSubmission';
const candidateLimit = 16;
const detailLimit = 3;
const unknown = { state: 'unknown' } as const;

export function isRadarRetentionSlot(type: string) {
  return type === forecastType || type === reconciliationType;
}

async function currentSelections(tx: ReadTransaction, type: string, id?: string, key?: string) {
  const { rows } = await tx.query<Selection>(
    `SELECT d.id, d.slot_type, d.slot_key, d.deriver, d.effective_tick::text, d.value, d.manifest
     FROM slot_state s JOIN derivations d
       ON (d.learner_id,d.slot_type,d.slot_key,d.id)=(s.learner_id,s.slot_type,s.slot_key,s.current_id)
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND ($3::text IS NULL OR d.id=$3)
       AND ($5::text IS NULL OR d.slot_key=$5)
       AND d.lifecycle='effective' AND d.selection_ended_tick IS NULL AND d.invalidated_tick IS NULL
       AND NOT d.is_shadow AND d.effective_tick >= d.gather_tick AND d.value->>'kind'='value'
     ORDER BY d.effective_tick DESC, d.id LIMIT $4`, [tx.learner, type, id ?? null, id || key ? 1 : candidateLimit, key ?? null],
  );
  return rows;
}

async function validRetentionManifest(tx: ReadTransaction, row: Selection, callerPurpose = purpose) {
  const owner = row.slot_type === forecastType ? 'learner/retention-forecast@' : 'learner/retention-reconciliation@';
  if (!row.deriver.startsWith(owner)) return;
  let manifest;
  try { manifest = parseManifest(row.manifest); }
  catch { return; }
  if (manifest.purpose !== purpose || manifest.inputs.length > 64 ||
      (await revalidateManifest(tx, manifest)).kind !== 'valid' ||
      (callerPurpose !== purpose && (await revalidateManifest(tx, manifest, callerPurpose)).kind !== 'valid')) return;
  return manifest;
}

async function readSelection(tx: ReadTransaction, row: Selection, access: Access) {
  if (row.value.kind !== 'value') return;
  const manifest = await validRetentionManifest(tx, row, access.callerPurpose);
  if (!manifest) return;
  const actor = { purpose: access.callerPurpose, maySend: access.maySend };
  const facts: { input: FactInput; fact: FactSnapshot }[] = [];
  let forecast: { row: Selection; value: RetentionForecast } | undefined;
  for (const input of manifest.inputs) {
    if (input.kind === 'slot' && row.slot_type === reconciliationType && !forecast &&
        input.slotType === forecastType && input.mode === 'following') {
      const [parent] = await currentSelections(tx, forecastType, input.derivationId);
      if (!parent || parent.slot_key !== input.slotKey) return;
      const selected = await readSelection(tx, parent, access);
      if (!selected || selected.row.value.kind !== 'value' || !('method' in selected.row.value.value)) return;
      forecast = { row: parent, value: selected.row.value.value };
      facts.push(...selected.facts);
      continue;
    }
    if (input.kind !== 'fact') return;
    try {
      const fact = await guardAccess(tx, input, actor);
      facts.push({ input, fact });
    } catch (error) {
      if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return;
      throw error;
    }
  }
  const value = row.value.value;
  if (row.slot_type === forecastType && 'method' in value && value.input.target.activity === 'frozen-workbook-item') {
    forecast = { row, value };
  }
  if (!forecast || ('forecastId' in value && value.forecastId !== forecast.row.id)) return;
  const slot: RadarSlot = { kind: 'slot', slotType: row.slot_type, slotKey: row.slot_key,
    derivationId: derivationId(row.id), mode: 'following' };
  return { row, slot, facts, forecast };
}

type SelectionRead = NonNullable<Awaited<ReturnType<typeof readSelection>>>;

function basisOf(selected: SelectionRead): RetentionBasis {
  const facts = new Map(selected.facts.map(({ input }) => [
    `${input.id}:${input.rev}:${input.accessEpoch}:${input.mode}`, input,
  ]));
  return { slot: selected.slot, facts: [...facts.values()] };
}

export async function readRetentionBasis(tx: ReadTransaction, slot: RadarSlot, access: Access): Promise<RetentionBasis | undefined> {
  if (!isRadarRetentionSlot(slot.slotType) || slot.mode !== 'following') return;
  const [row] = await currentSelections(tx, slot.slotType, slot.derivationId);
  if (!row || row.slot_key !== slot.slotKey) return;
  const selected = await readSelection(tx, row, access);
  return selected && projectRetention(selected) ? basisOf(selected) : undefined;
}

// Revalidate the research grant's provenance without opening the exercise or answer.
export async function readMissedPosttest(tx: ReadTransaction, key: string, resultId?: string) {
  const [row] = await currentSelections(tx, reconciliationType, resultId, key);
  if (row?.value.kind !== 'value' || !('observation' in row.value.value)) return;
  const { status, observation, forecastId } = row.value.value;
  if (status !== 'missed' || observation.result !== 'incorrect' || observation.exposure.kind !== 'independent') return;
  const manifest = await validRetentionManifest(tx, row);
  if (!manifest) return;
  const parent = manifest.inputs.find(input => input.kind === 'slot' &&
    input.slotType === forecastType && input.mode === 'following' && input.derivationId === forecastId);
  if (parent?.kind !== 'slot' || !manifest.inputs.some(input => input.kind === 'fact' &&
      input.id === observation.submission.id && input.rev === observation.submission.rev)) return;
  const [forecast] = await currentSelections(tx, forecastType, parent.derivationId, parent.slotKey);
  const estimate = forecast?.value.kind === 'value' && 'estimate' in forecast.value.value
    ? forecast.value.value.estimate : undefined;
  const predictedCorrect = estimate?.kind === 'categorical' ? estimate.expected === 'correct'
    : estimate?.kind === 'probabilistic' ? estimate.probability >= 0.5 : false;
  if (!forecast || !predictedCorrect || !await validRetentionManifest(tx, forecast)) return;
  const { rowCount } = await tx.query(
    'SELECT 1 FROM facts WHERE learner_id=$1 AND id=$2 AND type=$3 AND retracted_rev IS NULL',
    [tx.learner, observation.submission.id, posttestSubmission],
  );
  return rowCount ? derivationId(row.id) : undefined;
}

function projectRetention(selected: SelectionRead) {
  const { row, facts, forecast } = selected;
  if (row.value.kind !== 'value') return;
  const { method, estimate, input } = forecast.value;
  const value = row.value.value;
  const { itemId, paper } = input.target;
  const matches = (ref: RetentionObservation['submission'], types: string[]) => facts.find(({ fact }) =>
    fact.ref.id === ref.id && fact.ref.rev === ref.rev && types.includes(fact.type))?.fact;
  const href = `/api/retention/${row.slot_key}`;
  const source = matches(paper, [workbookPaperType, retentionPaper]);
  if (!source) return;
  const observation = 'observation' in value ? value.observation : undefined;
  const refs = [...input.observations.map(item => item.submission), ...(observation ? [observation.submission] : [])];
  if (refs.some(ref => !matches(ref, [workbookAttemptType, posttestSubmission]))) return;
  // Keep the tool result small. The frozen result URL and the dispatch witness retain the full basis.
  const sources = new Set([source]);
  const forecastBasis = estimate.kind === 'categorical' ? estimate.basis : input.observations.at(-1)?.submission;
  for (const ref of [forecastBasis, observation?.submission]) {
    if (!ref) continue;
    const fact = matches(ref, [workbookAttemptType, posttestSubmission]);
    if (!fact) return;
    sources.add(fact);
  }
  const evidence = [...sources].map(fact => {
    const ref = { id: fact.ref.id, rev: fact.ref.rev, type: fact.type };
    if (fact.type === workbookPaperType || fact.type === workbookAttemptType) {
      const anchor = fact.type === workbookPaperType ? { kind: 'question', itemId } as const
        : { kind: 'answer-slot', itemId, slotId: 'answer' } as const;
      return { ...ref, open: { tool: 'open_learning', args: { refs: JSON.stringify(sourceReference(fact, anchor)) } } };
    }
    return { ...ref, href };
  });
  const common = { id: row.id, key: row.slot_key, state: 'current' as const, effectiveTick: row.effective_tick,
    method: { id: method.id, version: method.version }, itemId,
    window: { requestedAt: input.window.requestedAt, through: input.window.through }, evidence, href };
  if ('status' in value && observation) return { ...common, kind: 'reconciliation' as const,
    forecastId: forecast.row.id, status: value.status,
    observation: { result: observation.result, exposure: observation.exposure.kind } };
  if ('estimate' in value) {
    if (estimate.kind === 'probabilistic') {
      return { ...common, kind: 'forecast' as const,
        estimate: { kind: 'probabilistic' as const, probability: estimate.probability,
          interval: estimate.interval, uncertainty: estimate.uncertainty } };
    }
    return { ...common, kind: 'forecast' as const,
      estimate: estimate.kind === 'unknown' ? { kind: 'unknown' as const, reason: estimate.reason }
        : { kind: 'categorical' as const, expected: estimate.expected } };
  }
  return undefined;
}

export async function readRetentionRadar(tx: ReadTransaction, access: Access, options: {
  track?: (basis: RetentionBasis) => void;
  horizon?: { from: string; through: string };
  limitPerKind?: number;
} = {}) {
  async function collect(type: string) {
    const items: NonNullable<ReturnType<typeof projectRetention>>[] = [];
    for (const row of await currentSelections(tx, type)) {
      if (items.length >= (options.limitPerKind ?? detailLimit)) break;
      const selected = await readSelection(tx, row, access);
      if (!selected) continue;
      const end = selected.forecast.value.input.window.through;
      if (options.horizon && (end < options.horizon.from || end > options.horizon.through)) continue;
      const value = projectRetention(selected);
      if (!value) continue;
      options.track?.(basisOf(selected));
      items.push(value);
    }
    return items;
  }
  const forecasts = await collect(forecastType);
  const reconciliations = await collect(reconciliationType);
  // An empty visible set cannot establish that there are no results outside this purpose.
  return forecasts.length || reconciliations.length ? { state: 'available' as const, forecasts, reconciliations } : unknown;
}

function radarArguments(args: Record<string, unknown>) {
  const { scope, horizon_hours: hours } = args;
  if (hours !== undefined && (typeof hours !== 'number' || !Number.isSafeInteger(hours) || hours < 1 || hours > 168)) return;
  if (scope !== undefined) {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return;
    const { subject_id, kc_ids, ...other } = scope as Record<string, unknown>;
    if (Object.keys(other).length || (subject_id !== undefined && !isSourceFactId(subject_id)) ||
        (kc_ids !== undefined && (!Array.isArray(kc_ids) || kc_ids.length > 8 || !kc_ids.every(isSourceFactId)))) return;
    if (subject_id !== undefined || (Array.isArray(kc_ids) && kc_ids.length)) return { scoped: true };
  }
  const now = Date.now();
  return { scoped: false, horizon: hours === undefined ? undefined : {
    from: new Date(now).toISOString(), through: new Date(now + hours * 3_600_000).toISOString(),
  } };
}

function standalonePaper(fact: FactSnapshot, maySend: WorkspaceSourceRecipient) {
  if (fact.type !== workbookPaperType || !maySend(fact)) return false;
  try {
    const { materialId, assessmentRelease, questions } = workbookPaper(fact.value);
    return materialId === null && !assessmentRelease && questions.every(question => !question.sourceQuestionRef);
  } catch {
    return false;
  }
}

export async function readLearnerRadar(tx: ReadTransaction, args: Record<string, unknown>,
  maySend: WorkspaceSourceRecipient, track: SourceTrack, trackRetention?: (basis: RetentionBasis) => void) {
  const query = radarArguments(args);
  if (!query) return { ok: false, code: 'invalid_args', message: 'horizon_hours 须为 1–168 的整数，scope 只接受 subject_id 或最多 8 个 kc_ids。' };
  const prerequisites = { tool: 'search_workspace', args: { hops: 2, direction: 'inbound', edgeKinds: ['prereq_of'] },
    required: ['conceptId'] };
  if (query.scoped) return { retention: unknown, goal: unknown, tasks: unknown, inventory: unknown, prerequisites,
    unappliedFilters: ['scope'], reason: '当前保持结果、任务和库存没有可靠的学科或知识点归属。' };
  const retention = trackRetention ? await readRetentionRadar(tx, { callerPurpose: purpose, maySend },
    { track: trackRetention, ...(query.horizon ? { horizon: query.horizon } : {}) }) : unknown;
  const observed = new Map<string, FactSnapshot>();
  const overview = await readLearningOverview(tx, { callerPurpose: purpose, maySend: (_, fact) => maySend(fact),
    track: fact => observed.set(fact.ref.id, fact) });
  const { tasks, goal } = overview;
  const active = 'items' in tasks ? tasks.items.filter(task => !task.done).slice(0, detailLimit) : [];
  for (const id of [...(goal.state === 'set' ? [goal.witness.id] : []), ...active.map(task => task.id)]) {
    const fact = observed.get(id);
    if (fact) track(fact, 'following');
  }
  const inventory = await workspaceQuery(tx, { kind: 'paper' }, {
    recipient: 'workspace', maySend: fact => standalonePaper(fact, maySend), track,
  });
  const papers = inventory && 'results' in inventory ? inventory.results : [];
  return { retention, prerequisites,
    goal: goal.state === 'set' ? { ...goal, text: goal.text === null ? null : textSlice(goal.text, 0, 240).content } : goal,
    tasks: active.length ? { state: tasks.state, items: active.map(task => ({ ...task, title: textSlice(task.title, 0, 100).content })) }
      : { state: tasks.state === 'partial' ? 'unknown' : tasks.state === 'unavailable' ? 'unknown' : 'empty' },
    inventory: papers.length ? { state: 'available', items: papers.map(({ id, rev, title, sourceRef }) =>
      ({ id, rev, title: textSlice(title, 0, 100).content, sourceRef, kind: 'paper', status: 'ready', usage: 'unknown' })) } : unknown,
  };
}
