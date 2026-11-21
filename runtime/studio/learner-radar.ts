import { guardAccess, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { derivationId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Outcome } from '../../kernel/src/declarations/types.ts';
import { parseManifest, type ManifestInput } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { posttestOpensAt } from '../../modules/activity/retention-posttest.ts';
import { isSourceFactId } from '../../modules/activity/source-values.ts';
import { isStandaloneWorkbookPaper, workbookAttemptType, workbookPaper, workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { forecastType, reconciliationType, type RetentionForecast } from '../../modules/learner/retention.ts';
import { classifyFrozenCrossing, projectForgettingRisks, projectRetentionRead, type RetentionReconciliation } from '../../modules/learner/retention-view.ts';
import { purpose } from './identity.ts';
import { checkStudioNotionFact } from './notion.ts';
import { retentionHistoryValid } from './retention.ts';
import { readLearningOverview } from './learning-overview.ts';
import { radarArguments } from '../../executors/teaching/workspace-tools.ts';
import { radarInventory, radarOverview, retentionEvidenceLink } from '../../modules/activity/workspace-source-projection.ts';
import type { SourceTrack, WorkspaceSourceRecipient } from './source-read.ts';
import { workspaceQuery } from './workspace-read.ts';

export type RadarSlot = Extract<ManifestInput, { kind: 'slot' }>;
type FactInput = Extract<ManifestInput, { kind: 'fact' }>;
export type RetentionBasis = { slot: RadarSlot; facts: FactInput[] };
type Access = { callerPurpose: string; maySend: WorkspaceSourceRecipient };
type Selection = {
  id: string; slot_type: string; slot_key: string; deriver: string;
  effective_tick: Tick; value: Outcome<RetentionForecast | RetentionReconciliation>; manifest: unknown;
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
  // Old gathers may repeat an issuance for multiple observations. Keep all distinct modes and revisions.
  manifest = { ...manifest, inputs: [...new Map(manifest.inputs.map(input => [JSON.stringify(input), input])).values()] };
  if (manifest.purpose !== purpose ||
      (await revalidateManifest(tx, manifest)).kind !== 'valid' ||
      (callerPurpose !== purpose && (await revalidateManifest(tx, manifest, callerPurpose)).kind !== 'valid')) return;
  if (row.value.kind !== 'value') return;
  const value = row.value.value;
  const parent = 'forecastId' in value ? value.forecastId : row.id;
  if (!await retentionHistoryValid(tx, derivationId(parent), 'observation' in value ? value.observation : undefined)) return;
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

function projectRetention({ row, facts, forecast }: SelectionRead) {
  const href = `/api/retention/${row.slot_key}`;
  return projectRetentionRead({ id: row.id, key: row.slot_key, effectiveTick: row.effective_tick, value: row.value },
    { id: forecast.row.id, value: forecast.value }, {
      papers: facts.filter(({ fact }) => fact.type === workbookPaperType || fact.type === retentionPaper).map(({ fact }) => fact),
      submissions: facts.filter(({ fact }) => fact.type === workbookAttemptType || fact.type === posttestSubmission).map(({ fact }) => fact),
    }, href, (fact, itemId) => retentionEvidenceLink(fact, itemId, href));
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

// This read covers active frozen workbook-item forecasts, not the learner's
// entire question inventory. The method owns the threshold and crossing time.
export async function readForgettingRisks(tx: ReadTransaction, maySend: WorkspaceSourceRecipient, options: {
  asOf: string; watermark: Tick; horizonHours: number;
  track: SourceTrack; trackRetention: (basis: RetentionBasis) => void;
}) {
  const { asOf, watermark, horizonHours } = options;
  const now = Date.parse(asOf);
  const end = now + horizonHours * 3_600_000;
  const { rows: candidates } = await tx.query<{ slot_key: string }>(
    `SELECT s.slot_key FROM slot_state s WHERE s.learner_id=$1 AND s.slot_type=$2
       AND EXISTS (SELECT 1 FROM derivations d
         WHERE (d.learner_id,d.slot_type,d.slot_key)=(s.learner_id,s.slot_type,s.slot_key)
           AND NOT d.is_shadow AND d.effective_tick <= $5::bigint)
       AND COALESCE(scope_keys #>> '{window,scheduledAt}', scope_keys #>> '{window,requestedAt}', '') <= $3
       AND (scope_keys #>> '{window,through}' IS NULL OR scope_keys #>> '{window,through}' > $3)
     ORDER BY changed_tick DESC, slot_key LIMIT $4`, [tx.learner, forecastType, asOf, candidateLimit + 1, watermark],
  );
  const risks = [];
  let classified = 0;
  for (const { slot_key: key } of candidates.slice(0, candidateLimit)) {
    const [row] = await currentSelections(tx, forecastType, undefined, key);
    if (!row || BigInt(row.effective_tick) > BigInt(watermark)) continue;
    const selected = await readSelection(tx, row, { callerPurpose: purpose, maySend });
    if (!selected) continue;
    const { input } = selected.forecast.value;
    const crossing = classifyFrozenCrossing(selected.forecast.value, posttestOpensAt(input.window), row.effective_tick, now, end);
    if (!crossing) continue;
    const projected = projectRetention(selected);
    const { paper, condition } = input.target;
    const source = selected.facts.find(({ fact }) => fact.ref.id === paper.id && fact.ref.rev === paper.rev);
    if (projected?.kind !== 'forecast' || !source) continue;
    try {
      for (const { fact } of selected.facts) await checkStudioNotionFact(tx, fact, purpose, maySend);
    } catch (error) {
      if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) continue;
      throw error;
    }
    // Out-of-window crossings also support a covered result or true empty set.
    options.trackRetention(basisOf(selected));
    for (const { fact, input } of selected.facts) options.track(fact, input.mode);
    classified++;
    if (crossing.inHorizon) {
      risks.push({ forecast_id: row.id, forecast_key: key, item_id: projected.itemId, condition,
        paper: { ...paper, title: workbookPaper(source.fact.value).title.slice(0, 100).toWellFormed() },
        crossing_at: crossing.at, forecast_as_of_at: crossing.asOf,
        forecast_effective_tick: row.effective_tick, method: projected.method });
    }
  }
  return projectForgettingRisks(risks, classified, candidates.length, asOf, end, watermark);
}

export async function readLearnerRadar(tx: ReadTransaction, args: Record<string, unknown>,
  maySend: WorkspaceSourceRecipient, track: SourceTrack, trackRetention?: (basis: RetentionBasis) => void) {
  const query = radarArguments(args, isSourceFactId);
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
  const projected = radarOverview(overview, detailLimit);
  for (const id of projected.witnessIds) {
    const fact = observed.get(id);
    if (fact) track(fact, 'following');
  }
  const inventory = await workspaceQuery(tx, { kind: 'paper' }, {
    recipient: 'workspace', maySend: fact => fact.type === workbookPaperType && maySend(fact) && isStandaloneWorkbookPaper(fact.value), track,
  });
  const papers = inventory && 'results' in inventory ? inventory.results : [];
  return { retention, prerequisites, ...projected.view, inventory: radarInventory(papers) };
}
