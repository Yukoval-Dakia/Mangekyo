import { createHash } from 'node:crypto';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { factId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Json } from '../../kernel/src/declarations/types.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { isSourceFactId, sourceReference } from '../../modules/activity/source-values.ts';
import { workbookAttempt, workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { memoryAssertion, memoryAssertionType, type MemoryLink } from '../../modules/companion/memory-assertion.ts';
import { memoryReviewDeriverVersion, reviewMemoryEvidence } from '../../modules/companion/memory-review.ts';
import { currentMemoryClaims, openClaimEvidence, readClaimValue } from './memory-claims.ts';
import type { OpenedCurrentLearningObject } from './current-learning-object.ts';
import { learnerPreferenceType, type PreferenceScope } from '../../modules/learner/preference-values.ts';
import {
  extractedUnderstanding, isExtractedUnderstanding, reviewUnderstanding, understandingPresentation, understandingProjection,
} from '../../modules/companion/understanding.ts';
import { hypothesisStatus } from '../../modules/companion/belief.ts';
import { openObjectiveCitations } from './belief-evidence.ts';
import { openUnderstandingCitations } from './research-understanding.ts';
import { purpose, slotType, studioLearner } from './identity.ts';
import { readLearningOverview } from './learning-overview.ts';
import { textSlice } from './reading.ts';
import { resolveSource, type WorkspaceSourceRecipient } from './source-read.ts';
import type { WorkspaceWitness } from './workspace-agent.ts';

type AnswerLocation = { id: string; itemId: string };
export type MemoryScope = { preference: PreferenceScope; links: readonly MemoryLink[];
  conditions?: readonly string[]; attempt?: AnswerLocation; experienceTurn?: string };
export type MemoryIntent = 'tutoring' | 'planning' | 'execution' | 'history' | 'management';
const regionsByIntent = {
  tutoring: ['current_answer', 'preferences', 'claims', 'memory', 'course_knowledge', 'learner_model', 'verified_playbooks'],
  planning: ['goal', 'scheduled_tasks', 'preferences', 'claims', 'learner_model', 'todo', 'inventory'],
  execution: ['current_answer', 'todo', 'chronicle', 'verified_playbooks', 'experience'],
  management: ['claims'],
  history: ['current_answer', 'claims', 'memory', 'chronicle'],
} as const;
type MemoryRegion = typeof regionsByIntent[MemoryIntent][number];
type RegionPage = { region: MemoryRegion; start: number; basisDigest: string };
type Omission = { region: MemoryRegion; reason: 'unknown' | 'basis_stale' } |
  { region: MemoryRegion; reason: 'budget'; expand: RegionPage };
export type ContextBundle = { intent: MemoryIntent; data: Partial<Record<MemoryRegion, Json[]>>; omitted: Omission[] };
type SentWitness = WorkspaceWitness & { fragment?: { itemId: string; slotId: 'answer'; end?: number } |
  { field: 'answer'; start: number; end: number } };
type RegionItem = { value: Json; sent: SentWitness[]; basis?: WorkspaceWitness[]; expiresAt?: string };
type Regions = Map<MemoryRegion, RegionItem[]>;

export function memoryScopeForObject(current: OpenedCurrentLearningObject | undefined): MemoryScope {
  if (!current) return {preference: {}, links: [], conditions: []};
  const {root, view} = current;
  return {preference: {activity: view.alias === 'current_attempt' ? 'attempt' : 'page', context: root.id},
    links: [{kind: 'source', id: factId(root.id)}], ...(current.answerSlot ? {attempt: {id: root.id, itemId: current.answerSlot}} : {})};
}

const witness = (fact: FactSnapshot): WorkspaceWitness => ({ id: fact.ref.id, rev: fact.ref.rev,
  epoch: fact.accessEpoch, type: fact.type, mode: 'following' });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

function regionPage(region: MemoryRegion, start: number, candidates: readonly RegionItem[]): RegionPage {
  const basisDigest = digest(JSON.stringify(candidates.map(item => [item.sent, item.basis ?? []])));
  return { region, start, basisDigest };
}

function packBundle(intent: MemoryIntent, regions: readonly MemoryRegion[], results: Regions, maxBytes: number, page?: RegionPage) {
  const bundle: ContextBundle = { intent, data: {}, omitted: [] };
  const selected: RegionItem[] = [];
  if (page && regionPage(page.region, page.start, results.get(page.region) ?? []).basisDigest !== page.basisDigest) {
    bundle.omitted.push({ region: page.region, reason: 'basis_stale' });
    return { bundle, selected };
  }
  for (const region of regions) {
    const candidates = results.get(region) ?? [];
    const start = page?.start ?? 0;
    if (start >= candidates.length) bundle.omitted.push({ region, reason: 'unknown' });
    else bundle.omitted.push({ region, reason: 'budget', expand: regionPage(region, start, candidates) });
  }
  for (const region of regions) {
    const candidates = results.get(region) ?? [];
    const items: Json[] = [];
    for (let index = page?.start ?? 0; index < candidates.length; index++) {
      const entry = candidates[index]!;
      const rest = bundle.omitted.filter(item => item.region !== region);
      if (index + 1 < candidates.length) rest.push({ region, reason: 'budget', expand: regionPage(region, index + 1, candidates) });
      const data = { ...bundle.data, [region]: [...items, entry.value] };
      if (Buffer.byteLength(JSON.stringify({ ...bundle, data, omitted: rest })) > maxBytes) break;
      items.push(entry.value);
      bundle.data = data;
      bundle.omitted = rest;
      selected.push(entry);
    }
  }
  return { bundle, selected };
}

async function collectRecall(tx: ReadTransaction, scope: MemoryScope, maySend: WorkspaceSourceRecipient, at: string,
  requested: readonly MemoryRegion[], options: {ownTurn?: string; management?: boolean; query?: string; beliefTools?: boolean}) {
  const results: Regions = new Map();
  function add(region: MemoryRegion, entry: RegionItem) {
    const items = results.get(region) ?? [];
    items.push(entry);
    results.set(region, items);
  }
  if (requested.includes('goal') || requested.includes('scheduled_tasks')) {
    const overview = await readLearningOverview(tx, { callerPurpose: purpose, maySend: (_projection, fact) => maySend(fact) });
    const known = new Map(overview.witnesses.map(w => [w.id, { id: w.id, rev: w.rev, epoch: w.accessEpoch, type: w.type, mode: 'following' as const }]));
    if (requested.includes('goal') && overview.goal.state === 'set' && overview.goal.text !== null) {
      const { witness: ref, text } = overview.goal;
      add('goal', { value: { id: ref.id, text: textSlice(text, 0, 1200).content }, sent: [known.get(ref.id)!] });
    }
    if (requested.includes('scheduled_tasks') && 'items' in overview.tasks) {
      for (const item of overview.tasks.items) add('scheduled_tasks', { value: item, sent: [known.get(item.id)!] });
    }
  }
  const wantsMemory = requested.includes('memory');
  const wantsPreferences = requested.includes('preferences');
  const wantsCourse = requested.includes('course_knowledge');
  const wantsAnswer = requested.includes('current_answer');
  const reader = createCommandReadContext(tx, purpose);
  async function open(id: string) {
    try {
      const fact = await reader.fact(factId(id), { mode: 'following' });
      return maySend(fact) ? fact : undefined;
    } catch (error) {
      if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) return;
      throw error;
    }
  }

  if (requested.includes('experience') && isSourceFactId(scope.experienceTurn)) {
    const turn = await open(scope.experienceTurn);
    if (turn?.type === 'activity.studyTurn') {
      const { rows: [settlement] } = await tx.query<{ status: string }>(
        `SELECT last_error->>'status' AS status FROM slot_state WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3`,
        [tx.learner, slotType, turn.ref.id],
      );
      if (settlement?.status === 'failed' || settlement?.status === 'unknown') {
        add('experience', { value: { turn: turn.ref.id, outcome: settlement.status }, sent: [witness(turn)] });
      }
    }
  }

  if (requested.includes('claims') || wantsPreferences) {
    for (const row of await currentMemoryClaims(tx, options)) {
      const fact = await open(row.id);
      const claim = fact && readClaimValue(fact.value);
      if (!fact || !claim) continue;
      const understanding = understandingProjection(fact)!;
      const legacy = claim.version === 0;
      const evidence = legacy ? claim.source : claim.evidence_refs[0];
      const excerpt = legacy ? claim.quote : claim.evidence_refs[0]?.excerpt;
      const start = legacy ? 0 : claim.evidence_refs[0]?.start ?? 0;
      if (!evidence || !excerpt) continue;
      const source = await openClaimEvidence(tx, evidence, excerpt, start, legacy);
      if (!source || !maySend(source)) continue;
      const region = !options.management && !legacy && (claim.category === 'preference' || claim.category === 'refusal') ? 'preferences' : 'claims';
      if (!requested.includes(region)) continue;
      if (!legacy && (claim.action === 'forget' || (claim.valid_until && claim.valid_until <= at))) continue;
      const scopeBasis: WorkspaceWitness[] = [];
      if (!legacy && claim.scope.kind === 'object') {
        if (!options.management && claim.scope.object !== scope.preference.context) continue;
        for (const ref of claim.scope.basis) {
          const object = await open(ref.id);
          if (object?.ref.rev === ref.rev && object.accessEpoch === ref.accessEpoch) scopeBasis.push(witness(object));
        }
        if (scopeBasis.length !== claim.scope.basis.length) continue;
      }
      add(region, {value: {id: row.id, rev: fact.ref.rev, text: legacy ? null : claim.text,
        ...(!legacy && claim.authority && {authority: claim.authority, ...(options.beliefTools && {category: claim.authority}), ...(claim.refusal && {refusal: claim.refusal})}),
        quote_excerpt: excerpt, kind: legacy ? 'legacy' : claim.category,
        scope: legacy ? {kind: 'unknown'} : claim.scope.kind === 'object'
          ? {kind: 'object', id: claim.scope.object} : claim.scope,
        valid_until: legacy ? null : claim.valid_until, recordedTick: row.tick, ttl: understanding.ttl, sticky: understanding.sticky,
        evidence_refs: understanding.evidence_refs},
      sent: [witness(fact), {...witness(source), fragment: {field: 'answer', start, end: start + excerpt.length}}],
      basis: scopeBasis, ...(!legacy && claim.valid_until ? {expiresAt: claim.valid_until} : {})});
    }
  }
  if (options.management && options.beliefTools) {
    for (const {id} of await currentMemoryClaims(tx, {...options, type: memoryAssertionType})) {
      const fact = await open(id);
      if (!fact) continue;
      const data = extractedUnderstanding(fact.value);
      const sources = await openObjectiveCitations(tx, data.evidence_refs, purpose, maySend);
      if (sources.length !== data.evidence_refs.length) continue;
      const object = data.scope.kind === 'object' ? await open(data.scope.object) : undefined;
      if (data.scope.kind === 'object' && !object) continue;
      const review = reviewUnderstanding(fact.ref.id, data, sources);
      const status = hypothesisStatus(data);
      add('claims', {value: {id, rev: fact.ref.rev, category: 'hypothesis', kind: 'observation', status,
        text: data.text, scope: data.scope, evidence_refs: data.evidence_refs, review},
      sent: [witness(fact), ...sources.map(source => witness(source.fact))], basis: object ? [witness(object)] : []});
    }
  }
  if (wantsMemory || wantsPreferences || requested.includes('verified_playbooks')) {
    const {rows} = await tx.query<{id: string}>(`SELECT f.id FROM facts f JOIN fact_revs r
        ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
        AND f.purpose && ARRAY['teaching','all'] AND r.data->>'version'='2' AND NOT (r.data ? 'belief')
        AND (r.data->'scope'->>'kind'='general' OR r.data->'scope'->>'object'=$3)
      ORDER BY f.changed_tick DESC,f.id LIMIT 24`,
    [tx.learner, memoryAssertionType, scope.preference.context ?? null]);
    for (const {id} of rows) {
      const fact = await open(id);
      if (!fact) continue;
      const value = extractedUnderstanding(fact.value);
      if (value.ttl && value.ttl <= at) continue;
      const sources = await openUnderstandingCitations(tx, value.evidence_refs, purpose, maySend);
      if (sources.length !== value.evidence_refs.length) continue;
      const kind = understandingPresentation(value, sources);
      const region = kind === 'preference' ? 'preferences' : 'memory';
      if (!requested.includes(region)) continue;
      const review = reviewUnderstanding(fact.ref.id, value, sources);
      add(region, {value: {id, rev: fact.ref.rev, kind, text: value.text, scope: value.scope,
        ttl: value.ttl, sticky: value.sticky, evidence_refs: value.evidence_refs.map(({basis_digest, ...citation}) => citation), review},
      sent: [witness(fact), ...sources.map(source => source.basis[0]!)],
      basis: sources.flatMap(source => source.basis.slice(1)), ...(value.ttl ? {expiresAt: value.ttl} : {})});
    }
  }
  if (!wantsMemory && !wantsPreferences && !wantsCourse && !wantsAnswer) return results;

  async function openAnswer(source: AnswerLocation) {
    const fact = await open(source.id);
    if (fact?.type !== workbookAttemptType) return;
    const { submittedAt, gradingVersion } = workbookAttempt(fact.value);
    const ref = sourceReference(fact, { kind: 'answer-slot', itemId: source.itemId, slotId: 'answer' });
    const projection = await resolveSource(tx, ref, { recipient: 'workspace', maySend }, 'following');
    if (!projection || projection.content === null || projection.content === '') return;
    const content = typeof projection.content === 'string' ? textSlice(projection.content, 0, 600).content : projection.content;
    const sourceWitness: SentWitness = { ...witness(fact), fragment: { itemId: source.itemId, slotId: 'answer',
      ...(typeof content === 'string' ? { end: content.length } : {}) } };
    return { fact, ref, content, submittedAt, gradingVersion, witness: sourceWitness };
  }

  const matched = new Map<string, { link: MemoryLink; basis: WorkspaceWitness[] }>();
  const current = scope.attempt && (wantsAnswer || wantsMemory) ? await openAnswer(scope.attempt) : undefined;
  if (current && wantsAnswer) {
    const { rows: [origin] } = await tx.query<{ tick: string; author: string }>(
      `SELECT tick::text,author FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=1`, [tx.learner, current.fact.ref.id],
    );
    if (origin?.author === 'learner') add('current_answer', { value: { sourceRef: current.ref, content: current.content,
      occurredAt: current.submittedAt, recordedAt: null, recordedTick: origin.tick, help: 'unknown' }, sent: [current.witness] });
  }
  if (current && wantsMemory) {
    const link = { kind: 'source' as const, id: current.fact.ref.id };
    matched.set(`source:${link.id}`, { link, basis: [current.witness] });
  }
  for (const link of (wantsMemory || wantsCourse) ? scope.links : []) {
    if (matched.has(`${link.kind}:${link.id}`)) continue;
    const basis: WorkspaceWitness[] = [];
    const source = await resolveSource(tx, link.id, { recipient: 'workspace', maySend, track: fact => basis.push(witness(fact)) });
    if (!source || (link.kind === 'concept' && source.kind !== 'concept') ||
        (link.kind === 'family' && !source.tags?.includes('question-family'))) continue;
    matched.set(`${link.kind}:${link.id}`, { link, basis });
    if (wantsCourse && link.kind === 'concept' && typeof source.content === 'string') {
      const root = basis.find(item => item.id === link.id);
      if (root) add('course_knowledge', { value: { sourceRef: source.sourceRef, title: source.title,
        content: textSlice(source.content, 0, 600).content }, sent: [root], basis });
    }
  }

  if (!wantsMemory && !wantsPreferences) return results;

  const { rows } = await tx.query<{ id: string; type: string }>(
    `SELECT id,type FROM (SELECT f.id,f.type,f.changed_tick,
       row_number() OVER (PARTITION BY f.type ORDER BY f.changed_tick DESC,f.id) AS position
     FROM facts f JOIN fact_revs r
     ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.retracted_rev IS NULL
       AND 'teaching'=ANY(f.purpose) AND 'teaching'=ANY(r.purpose)
       AND ((f.type=$2 AND $4::jsonb @> (r.data->'scope'))
         OR (f.type=$3 AND r.data->'scope'->>'subject'=$4::jsonb->>'subject'
            AND (r.data->'scope'->>'activity' IS NULL OR r.data->'scope'->>'activity'=$4::jsonb->>'activity')
            AND EXISTS (SELECT 1 FROM jsonb_array_elements($5::jsonb) AS matched(link)
                        WHERE r.data->'links' @> jsonb_build_array(matched.link))))
     ) eligible WHERE position<=24 ORDER BY changed_tick DESC,id`,
    [tx.learner, wantsPreferences ? learnerPreferenceType : null, wantsMemory ? memoryAssertionType : null, JSON.stringify(scope.preference),
      JSON.stringify([...matched.values()].map(({ link }) => link))],
  );

  for (const { id, type } of rows) {
    const fact = await open(id);
    if (!fact) continue;
    if (type === learnerPreferenceType) {
      const understanding = understandingProjection(fact)!;
      const {text, scope, kind, ttl, sticky, evidence_refs} = understanding;
      if (text !== null) add('preferences', {value: {id, rev: fact.ref.rev, text: textSlice(text, 0, 600).content,
        scope, kind, ttl, sticky, evidence_refs}, sent: [witness(fact)]});
      continue;
    }
    if (isExtractedUnderstanding(fact.value)) continue;
    const understanding = understandingProjection(fact)!;
    const memory = memoryAssertion(fact.value);
    const { validFrom, validUntil, conditions = [] } = memory.scope;
    if ((validFrom && validFrom > at) || (validUntil && validUntil <= at) ||
        !conditions.every(condition => condition === scope.preference.context || scope.conditions?.includes(condition))) continue;
    const link = memory.links.map(link => matched.get(`${link.kind}:${link.id}`)).find(Boolean);
    if (!link) continue;

    const opened = [];
    for (const item of memory.evidence) opened.push(await openAnswer(item));
    // The assertion may itself disclose a withdrawn source. Only supply it while every cited input is current.
    if (!opened.every((item, i) => item && item.fact.ref.rev === memory.evidence[i]?.rev &&
        item.fact.accessEpoch === memory.evidence[i]?.accessEpoch)) continue;
    const originals = opened.filter(item => item !== undefined);
    const { rows: provenance } = await tx.query<{ fact_id: string; author: string; tick: string }>(
      `SELECT original.fact_id, original.author, source.tick::text
       FROM fact_revs source JOIN fact_revs original ON original.learner_id=source.learner_id AND original.fact_id=source.fact_id AND original.rev=1
       JOIN unnest($2::text[], $3::int[]) chosen(id,rev) ON (source.fact_id,source.rev)=(chosen.id,chosen.rev)
       WHERE source.learner_id=$1`, [tx.learner, originals.map(item => item.fact.ref.id), originals.map(item => item.fact.ref.rev)],
    );
    const evidence = originals.flatMap((item, i) => {
      const origin = provenance.find(row => row.fact_id === item.fact.ref.id);
      if (origin?.author !== 'learner') return [];
      return [{ eventId: item.fact.ref.id, assertionId: id, scope: memory.scope,
        witness: { factId: item.fact.ref.id, revision: item.fact.ref.rev, accessEpoch: item.fact.accessEpoch,
          sourceVersion: `${workbookAttemptType}/${item.gradingVersion}`, authorRole: 'learner' as const },
        occurredAt: item.submittedAt, recordedAt: 'unknown', help: { exposed: 'unknown' as const, order: 'unknown' as const },
        direction: memory.evidence[i]!.direction }];
    });
    if (evidence.length !== originals.length) continue;
    const review = reviewMemoryEvidence({ requestId: id, assertion: { id, text: memory.text, scope: memory.scope }, evidence });
    if (review.kind !== 'value') continue;
    const { assertion, outcome, findings, nextEvidence } = review.value;
    const value = {id, rev: fact.ref.rev, kind: understanding.kind, ttl: understanding.ttl, sticky: understanding.sticky,
      evidence_refs: understanding.evidence_refs, method: memoryReviewDeriverVersion, assertion, outcome, findings, nextEvidence: [...nextEvidence],
      sources: review.value.sources.map(source => {
        const item = originals.find(item => item.fact.ref.id === source.eventId)!;
        return { ...source, recordedTick: provenance.find(row => row.fact_id === source.eventId)!.tick,
          sourceRef: item.ref, content: item.content };
      }) };
    add('memory', { value, sent: [witness(fact), ...originals.map(item => item.witness)], basis: link.basis,
      ...(validUntil ? { expiresAt: validUntil } : {}) });
  }
  return results;
}

export async function readMemoryGateway(options: {
  db: Db; owner: { kind: 'session' | 'derivation'; id: string; step: string }; scope: MemoryScope;
  intent: MemoryIntent; maxBytes: number; expand?: RegionPage; maySend: WorkspaceSourceRecipient;
  authorize: (tx: ReadTransaction) => Promise<void>; ownTurn?: string; query?: string; beliefTools?: boolean;
}) {
  const { db, owner, scope, intent, maxBytes, expand, maySend, authorize, ownTurn, query } = options;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16_384) throw new Error('记忆预算须在 1–16 KiB。');
  const available: readonly MemoryRegion[] = regionsByIntent[intent];
  if (expand && (!available.includes(expand.region) || !Number.isSafeInteger(expand.start) || expand.start < 0 ||
      !/^[a-f0-9]{64}$/.test(expand.basisDigest)))
    throw new Error('记忆展开位置无效。');
  const regions = expand ? [expand.region] : available;
  const collect = async (tx: ReadTransaction) => {
    const results = await collectRecall(tx, scope, maySend, new Date().toISOString(), regions, {management: intent === 'management',
      ...(options.beliefTools ? {beliefTools:true} : {}),
      ...(ownTurn ? {ownTurn} : {}), ...(query ? {query} : {})});
    const { bundle, selected } = packBundle(intent, regions, results, maxBytes, expand);
    const context = JSON.stringify(bundle);
    const sent = selected.flatMap(item => item.sent);
    const witnesses = (items: readonly RegionItem[]) => [...new Map(items.flatMap(item =>
      [...(item.basis ?? []), ...item.sent].map(ref => [`${ref.id}:${ref.rev}`, ref] as const))).values()];
    const opened = witnesses([...results.values()].flat());
    const basis = witnesses(selected);
    const expiresAt = selected.flatMap(item => item.expiresAt ? [item.expiresAt] : []).sort()[0] ?? null;
    return { bundle, context, receipt: { digest: digest(context), opened, basis, sent, expiresAt } };
  };
  let recall: Awaited<ReturnType<typeof collect>> | undefined;
  const receipt = await recordLocalRead(db, { learner: studioLearner, ownerKind: owner.kind, ownerId: owner.id,
    stepKey: owner.step, label: 'local:learning-memory', input: { purpose, intent, maxBytes, scope, ...(options.beliefTools ? {beliefTools:true} : {}), ...(expand ? { expand } : {}), ...(ownTurn ? {ownTurn} : {}), ...(query ? {query} : {}) } }, async tx => {
    recall = await collect(tx);
    return JSON.stringify(recall.receipt);
  }, authorize);
  recall ??= await db.snapshot({ learner: studioLearner }, async tx => {
    await authorize(tx);
    return collect(tx);
  });
  if (JSON.stringify(recall.receipt) === receipt) return recall;
  return undefined;
}
