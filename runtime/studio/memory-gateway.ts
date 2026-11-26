import { createHash } from 'node:crypto';
import {
  factId, listRevisionProvenance, readAvailable, readFactOrigin, readSlotStatus,
  type Db, type FactSnapshot, type ReadTransaction,
} from '../../kernel/src/index.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { type StudioMemoryScope } from '../../modules/activity/current-object-basis.ts';
import { readLearningOverview } from '../../modules/activity/learning-overview.ts';
import { isSourceFactId, sourceReference } from '../../modules/activity/source-values.ts';
import { workbookAttempt, workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { claimRecallValue, recallClaimEvidence, workbookRecallValue } from '../../modules/companion/belief.ts';
import { memoryAssertion, memoryAssertionType, type MemoryLink } from '../../modules/companion/memory-assertion.ts';
import { buildHypothesisRecallValue, buildUnderstandingRecallSpec, matchesMemoryAssertionScope, resolveClaimRecallRegion } from '../../modules/companion/memory-slice.ts';
import { recallPacket, recallRegions, type MemoryIntent, type MemoryRegion, type RecallItem, type RecallRegions, type RegionPage, type SentWitness } from '../../modules/companion/recall-packet.ts';
import { extractedUnderstanding, isExtractedUnderstanding, understandingProjection } from '../../modules/companion/understanding.ts';
import { learnerPreferenceType } from '../../modules/learner/preference-values.ts';
import { projectLearnerModelFlowSignals } from '../../modules/learner/record-flow.ts';
import { openObjectiveCitations } from './belief-evidence.ts';
import { openHypothesisObject } from './hypothesis-object.ts';
import { purpose, purposeReader, slotType, studioHost, studioLearner, toWitness } from './identity.ts';
import { currentMemoryClaims, openClaimEvidence, readClaimValue } from './memory-claims.ts';
import { textSlice } from './reading.ts';
import { loadAuthorizedRecordFlowSnapshot } from './record-flow.ts';
import { openUnderstandingCitations } from './research-understanding.ts';
import { resolveSource, type WorkspaceSourceRecipient } from './source-read.ts';
import type { WorkspaceWitness } from './workspace-agent.ts';

export type MemoryScope = StudioMemoryScope;
export { memoryScopeForObject } from '../../modules/activity/current-object-basis.ts';
const witness = (fact: FactSnapshot): WorkspaceWitness => toWitness(fact, 'following');

async function collectRecall(tx: ReadTransaction, scope: MemoryScope, maySend: WorkspaceSourceRecipient, at: string,
  requested: readonly MemoryRegion[], options: { ownTurn?: string; management?: boolean; query?: string; beliefTools?: boolean }) {
  const results: RecallRegions<WorkspaceWitness> = new Map();
  const add = (region: MemoryRegion, entry: RecallItem<WorkspaceWitness>) => { const list = results.get(region) ?? []; list.push(entry); results.set(region, list); };
  const read = purposeReader(tx, maySend), open = (id: string) => readAvailable(() => read.fact(factId(id), { mode: 'following' }));
  if (requested.includes('goal') || requested.includes('scheduled_tasks')) {
    const overview = await readLearningOverview(tx, { callerPurpose: purpose, maySend: (_p, fact) => maySend(fact) });
    const known = new Map(overview.witnesses.map(w => [w.id, { id: w.id, rev: w.rev, epoch: w.accessEpoch, type: w.type, mode: 'following' as const }]));
    if (requested.includes('goal') && overview.goal.state === 'set' && overview.goal.text !== null)
      add('goal', { value: { id: overview.goal.witness.id, text: textSlice(overview.goal.text, 0, 1200).content }, sent: [known.get(overview.goal.witness.id)!] });
    if (requested.includes('scheduled_tasks') && 'items' in overview.tasks)
      for (const item of overview.tasks.items) add('scheduled_tasks', { value: item, sent: [known.get(item.id)!] });
  }
  if (requested.includes('learner_model')) {
    const { snap, snapshots } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose, maySend });
    const focusIds = [scope.attempt?.id, ...scope.links.map(l => l.id),
      isSourceFactId(scope.preference.context) ? scope.preference.context : undefined].filter((id): id is string => Boolean(id));
    for (const { witnessFactIds, ...signal } of projectLearnerModelFlowSignals(focusIds, snap))
      if (witnessFactIds.length && witnessFactIds.every(id => snapshots.has(id)))
        add('learner_model', { value: signal, sent: witnessFactIds.map(id => witness(snapshots.get(id)!)) });
  }
  const wantsMemory = requested.includes('memory'), wantsPreferences = requested.includes('preferences');
  const wantsCourse = requested.includes('course_knowledge'), wantsAnswer = requested.includes('current_answer');
  if (requested.includes('experience') && isSourceFactId(scope.experienceTurn)) {
    const turn = await open(scope.experienceTurn);
    if (turn?.type === 'activity.studyTurn') {
      const status = (await readSlotStatus(tx, slotType, turn.ref.id))?.lastError?.status;
      if (status === 'failed' || status === 'unknown')
        add('experience', { value: { turn: turn.ref.id, outcome: status }, sent: [witness(turn)] });
    }
  }
  if (requested.includes('claims') || wantsPreferences) for (const row of await currentMemoryClaims(tx, options)) {
    const fact = await open(row.id), claim = fact && readClaimValue(fact.value);
    if (!fact || !claim) continue;
    const { evidence, excerpt, start } = recallClaimEvidence(claim), legacy = claim.version === 0;
    const source = evidence && excerpt ? await openClaimEvidence(tx, evidence, excerpt, start, legacy) : undefined;
    const region = source && maySend(source) ? resolveClaimRecallRegion(claim, !!options.management, at, requested) : undefined;
    if (!source || !region) continue;
    const scopeBasis: WorkspaceWitness[] = [];
    if (!legacy && claim.scope.kind === 'object') {
      if (!options.management && claim.scope.object !== scope.preference.context) continue;
      for (const ref of claim.scope.basis) {
        const object = await open(ref.id);
        if (object?.ref.rev === ref.rev && object.accessEpoch === ref.accessEpoch) scopeBasis.push(witness(object));
      }
      if (scopeBasis.length !== claim.scope.basis.length) continue;
    }
    add(region, { value: claimRecallValue(fact, claim, row.tick, excerpt!, !!options.beliefTools),
      sent: [witness(fact), { ...witness(source), rev: evidence!.rev, epoch: evidence!.accessEpoch,
        fragment: { field: 'answer', start, end: start + excerpt!.length } }],
      basis: scopeBasis, ...(!legacy && claim.valid_until ? { expiresAt: claim.valid_until } : {}) });
  }
  if (options.management && options.beliefTools) {
    for (const { id } of await currentMemoryClaims(tx, { ...options, type: memoryAssertionType })) {
      const fact = await open(id);
      if (!fact) continue;
      const data = extractedUnderstanding(fact.value), sources = await openObjectiveCitations(tx, data.evidence_refs, purpose, maySend);
      const objectBasis = sources.length === data.evidence_refs.length ? await openHypothesisObject(tx, data, maySend) : undefined;
      if (objectBasis) add('claims', { value: buildHypothesisRecallValue(fact, data, sources, purpose),
        sent: [witness(fact), ...sources.map(s => witness(s.fact))], basis: objectBasis });
    }
  }
  if (wantsMemory || wantsPreferences || requested.includes('verified_playbooks')) {
    const { rows } = await tx.query<{ id: string }>(`SELECT f.id FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND f.purpose && ARRAY['teaching','all']
        AND r.data->>'version'='2' AND NOT (r.data ? 'belief') AND (r.data->'scope'->>'kind'='general' OR r.data->'scope'->>'object'=$3)
      ORDER BY f.changed_tick DESC,f.id LIMIT 24`, [tx.learner, memoryAssertionType, scope.preference.context ?? null]);
    for (const { id } of rows) {
      const fact = await open(id), value = fact && extractedUnderstanding(fact.value);
      if (!fact || !value || (value.ttl && value.ttl <= at)) continue;
      const sources = await openUnderstandingCitations(tx, value.evidence_refs, purpose, maySend);
      const spec = sources.length === value.evidence_refs.length ? buildUnderstandingRecallSpec(fact, value, sources, requested) : null;
      if (spec) add(spec.region, { value: spec.value, sent: [witness(fact), ...sources.map(s => s.basis[0]!)],
        basis: sources.flatMap(s => s.basis.slice(1)), ...(value.ttl && { expiresAt: value.ttl }) });
    }
  }
  if (!wantsMemory && !wantsPreferences && !wantsCourse && !wantsAnswer) return results;

  async function openAnswer(source: { id: string; itemId: string }) {
    const fact = await open(source.id);
    if (fact?.type !== workbookAttemptType) return;
    const { submittedAt, gradingVersion } = workbookAttempt(fact.value);
    const ref = sourceReference(fact, { kind: 'answer-slot', itemId: source.itemId, slotId: 'answer' });
    const projection = await resolveSource(tx, ref, { recipient: 'workspace', maySend }, 'following');
    if (!projection || projection.content === null || projection.content === '') return;
    const content = typeof projection.content === 'string' ? textSlice(projection.content, 0, 600).content : projection.content;
    const sourceWitness: SentWitness<WorkspaceWitness> = { ...witness(fact),
      fragment: { itemId: source.itemId, slotId: 'answer', ...(typeof content === 'string' && { end: content.length }) } };
    return { fact, ref, content, submittedAt, gradingVersion, witness: sourceWitness };
  }
  const matched = new Map<string, { link: MemoryLink; basis: WorkspaceWitness[] }>();
  const current = scope.attempt && (wantsAnswer || wantsMemory) ? await openAnswer(scope.attempt) : undefined;
  if (current && wantsAnswer) {
    const origin = await readFactOrigin(tx, current.fact.ref.id);
    if (origin?.author === 'learner') add('current_answer', { value: { sourceRef: current.ref, content: current.content,
      occurredAt: current.submittedAt, recordedAt: null, recordedTick: origin.tick, help: 'unknown' }, sent: [current.witness] });
  }
  if (current && wantsMemory) matched.set(`source:${current.fact.ref.id}`, { link: { kind: 'source', id: current.fact.ref.id }, basis: [current.witness] });
  for (const link of (wantsMemory || wantsCourse) ? scope.links : []) {
    if (matched.has(`${link.kind}:${link.id}`)) continue;
    const basis: WorkspaceWitness[] = [], source = await resolveSource(tx, link.id,
      { recipient: 'workspace', maySend, track: f => basis.push(witness(f)) });
    if (!source || (link.kind === 'concept' && source.kind !== 'concept') || (link.kind === 'family' && !source.tags?.includes('question-family'))) continue;
    matched.set(`${link.kind}:${link.id}`, { link, basis });
    if (wantsCourse && link.kind === 'concept' && typeof source.content === 'string') {
      const root = basis.find(item => item.id === link.id);
      if (root) add('course_knowledge', { value: { sourceRef: source.sourceRef, title: source.title,
        content: textSlice(source.content, 0, 600).content }, sent: [root], basis });
    }
  }
  if (!wantsMemory && !wantsPreferences) return results;

  const { rows } = await tx.query<{ id: string; type: string }>(`SELECT id,type FROM (SELECT f.id,f.type,f.changed_tick,
      row_number() OVER (PARTITION BY f.type ORDER BY f.changed_tick DESC,f.id) AS position
    FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.retracted_rev IS NULL AND 'teaching'=ANY(f.purpose) AND 'teaching'=ANY(r.purpose)
      AND ((f.type=$2 AND $4::jsonb @> (r.data->'scope')) OR (f.type=$3 AND r.data->'scope'->>'subject'=$4::jsonb->>'subject'
        AND (r.data->'scope'->>'activity' IS NULL OR r.data->'scope'->>'activity'=$4::jsonb->>'activity')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements($5::jsonb) AS matched(link) WHERE r.data->'links' @> jsonb_build_array(matched.link))))
    ) eligible WHERE position<=24 ORDER BY changed_tick DESC,id`, [tx.learner, wantsPreferences ? learnerPreferenceType : null,
    wantsMemory ? memoryAssertionType : null, JSON.stringify(scope.preference), JSON.stringify([...matched.values()].map(({ link }) => link))]);
  for (const { id, type } of rows) {
    const fact = await open(id);
    if (!fact) continue;
    if (type === learnerPreferenceType) {
      const { text, scope: s, kind, ttl, sticky, evidence_refs } = understandingProjection(fact)!;
      if (text !== null) add('preferences', { value: { id, rev: fact.ref.rev, text: textSlice(text, 0, 600).content,
        scope: s, kind, ttl, sticky, evidence_refs }, sent: [witness(fact)] });
      continue;
    }
    if (isExtractedUnderstanding(fact.value)) continue;
    const memory = memoryAssertion(fact.value), link = matchesMemoryAssertionScope(memory, at, scope.preference.context, scope.conditions)
      ? memory.links.map(l => matched.get(`${l.kind}:${l.id}`)).find(Boolean) : undefined;
    if (!link) continue;
    const opened = await Promise.all(memory.evidence.map(item => openAnswer(item)));
    if (!opened.every((item, i) => item && item.fact.ref.rev === memory.evidence[i]?.rev && item.fact.accessEpoch === memory.evidence[i]?.accessEpoch)) continue;
    const originals = opened.filter((item): item is NonNullable<typeof item> => item !== undefined);
    const provenance = (await listRevisionProvenance(tx, originals.map(item => ({ id: item.fact.ref.id, rev: item.fact.ref.rev }))))
      .map(row => ({ fact_id: row.id, author: row.author, tick: row.tick }));
    const value = workbookRecallValue(fact, memory, originals, provenance);
    if (value) add('memory', { value, sent: [witness(fact), ...originals.map(item => item.witness)], basis: link.basis,
      ...(memory.scope.validUntil && { expiresAt: memory.scope.validUntil }) });
  }
  return results;
}

export async function readMemoryGateway(options: {
  db: Db; owner: { kind: 'session' | 'derivation'; id: string; step: string }; scope: MemoryScope;
  intent: MemoryIntent; maxBytes: number; expand?: RegionPage; maySend: WorkspaceSourceRecipient;
  authorize: (tx: ReadTransaction) => Promise<void>; ownTurn?: string; query?: string; beliefTools?: boolean;
}) {
  const { db, owner, scope, intent, maxBytes, expand, maySend, authorize, ownTurn, query } = options;
  const host = studioHost(db), regions = recallRegions(intent, maxBytes, expand);
  const queryOpts = { ...(options.beliefTools ? { beliefTools: true } : {}), ...(ownTurn ? { ownTurn } : {}), ...(query ? { query } : {}) };
  const collect = async (tx: ReadTransaction) => recallPacket(intent, regions,
    await collectRecall(tx, scope, maySend, new Date().toISOString(), regions, { management: intent === 'management', ...queryOpts }),
    maxBytes, text => createHash('sha256').update(text).digest('hex'), expand);
  let recall: Awaited<ReturnType<typeof collect>> | undefined;
  const receipt = await recordLocalRead(db, { learner: studioLearner, ownerKind: owner.kind, ownerId: owner.id, stepKey: owner.step,
    label: 'local:learning-memory', input: { purpose, intent, maxBytes, scope, ...queryOpts, ...(expand ? { expand } : {}) } },
    async tx => { recall = await collect(tx); return JSON.stringify(recall.receipt); }, authorize);
  recall ??= await host.snapshot(async tx => { await authorize(tx); return collect(tx); });
  return JSON.stringify(recall.receipt) === receipt ? recall : undefined;
}
