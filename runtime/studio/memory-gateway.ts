import { createHash } from 'node:crypto';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { factId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Json } from '../../kernel/src/declarations/types.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { isSourceFactId, sourceReference } from '../../modules/activity/source-values.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import { workbookAttempt, workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { memoryAssertion, memoryAssertionType, memoryLinkKinds, type MemoryLink } from '../../modules/companion/memory-assertion.ts';
import { memoryReviewDeriverVersion, reviewMemoryEvidence } from '../../modules/companion/memory-review.ts';
import { claimType, claimValue, explicitClaimRequest } from '../../modules/companion/claim.ts';
import { learnerPreference, learnerPreferenceType, type PreferenceScope } from '../../modules/learner/preference-values.ts';
import { purpose, slotType, studioLearner } from './identity.ts';
import { readLearningOverview } from './learning-overview.ts';
import { textSlice } from './reading.ts';
import { resolveSource, type WorkspaceSourceRecipient } from './source-read.ts';
import type { WorkspaceWitness } from './workspace-agent.ts';

type AnswerLocation = { id: string; itemId: string };
export type MemoryScope = { preference: PreferenceScope; links: readonly MemoryLink[];
  conditions?: readonly string[]; attempt?: AnswerLocation; experienceTurn?: string };
export type MemoryIntent = 'tutoring' | 'planning' | 'execution' | 'history';
const regionsByIntent = {
  tutoring: ['current_answer', 'preferences', 'claims', 'memory', 'course_knowledge', 'learner_model', 'verified_playbooks'],
  planning: ['goal', 'scheduled_tasks', 'claims', 'learner_model', 'todo', 'inventory'],
  execution: ['current_answer', 'todo', 'chronicle', 'verified_playbooks', 'experience'],
  history: ['current_answer', 'claims', 'memory', 'chronicle'],
} as const;
type MemoryRegion = typeof regionsByIntent[MemoryIntent][number];
type RegionPage = { region: MemoryRegion; start: number; basisDigest: string };
type Omission = { region: MemoryRegion; reason: 'unknown' | 'basis_stale' } |
  { region: MemoryRegion; reason: 'budget'; expand: RegionPage };
export type ContextBundle = { intent: MemoryIntent; data: Partial<Record<MemoryRegion, Json[]>>; omitted: Omission[] };
type SentWitness = WorkspaceWitness & { fragment?: { itemId: string; slotId: 'answer'; end?: number } |
  { field: 'answer'; start: 0; end: number } };
type RegionItem = { value: Json; sent: SentWitness[]; basis?: WorkspaceWitness[]; expiresAt?: string };
type Regions = Map<MemoryRegion, RegionItem[]>;

// Typed selectors share the existing message entry point. Natural-language titles never match a source identity.
export function memoryScopeFromMessage(message: string): MemoryScope {
  const input = /^学习范围[：:]([^\n]+)$/mu.exec(message)?.[1];
  const preference: { subject?: string; activity?: string; context?: string } = {};
  const links: MemoryLink[] = [];
  const conditions = new Set<string>();
  let attempt: AnswerLocation | undefined;
  for (const token of (input?.trim().split(/\s+/u) ?? []).slice(0, 8)) {
    const [key, value, extra] = token.split('=');
    if (!value || extra !== undefined || value.length > 240) continue;
    if (key === 'subject' || key === 'activity' || key === 'context') {
      preference[key] = value;
    } else if (key === 'condition') {
      conditions.add(value);
    } else if (key === 'attempt') {
      const [id, itemId, rest] = value.split('/');
      if (!attempt && isSourceFactId(id) && itemId && /^[A-Za-z0-9_-]{1,40}$/.test(itemId) && rest === undefined) {
        attempt = { id, itemId };
      }
    } else {
      const kind = memoryLinkKinds.find(kind => kind === key);
      if (kind && isSourceFactId(value)) links.push({ kind, id: factId(value) });
    }
  }
  return { preference, links, conditions: [...conditions], ...(attempt ? { attempt } : {}) };
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
  requested: readonly MemoryRegion[]) {
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

  if (requested.includes('claims')) {
    const { rows } = await tx.query<{ id: string; tick: string }>(
      `SELECT id,created_tick::text AS tick FROM facts WHERE learner_id=$1 AND type=$2
       AND retracted_rev IS NULL AND 'teaching'=ANY(purpose) ORDER BY created_tick DESC,id LIMIT 24`, [tx.learner, claimType]);
    for (const row of rows) {
      const fact = await open(row.id);
      if (!fact) continue;
      const claim = claimValue(fact.value);
      const source = await open(claim.source.id);
      if (!source || source.type !== 'activity.studyTurn' || source.ref.rev !== claim.source.rev ||
          source.accessEpoch !== claim.source.accessEpoch) continue;
      const submission = studyTurn(source.value);
      if (submission.caseId !== 'companion' || submission.answer !== claim.quote) continue;
      const { rows: [origin] } = await tx.query<{ author: string }>(
        `SELECT author FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=$3`,
        [tx.learner, source.ref.id, source.ref.rev],
      );
      if (origin?.author !== 'learner') continue;
      const action = explicitClaimRequest(claim.quote);
      if (!action || action.action === 'forget' || !action.teaching) continue;
      add('claims', { value: { id: row.id, quote: claim.quote, source: claim.source, supersedes: claim.supersedes,
        validFrom: null, recordedAt: null, recordedTick: row.tick },
      sent: [witness(fact), { ...witness(source), fragment: { field: 'answer', start: 0, end: claim.quote.length } }] });
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
      const { text, scope } = learnerPreference(fact.value);
      add('preferences', { value: { id, text: textSlice(text, 0, 600).content, scope }, sent: [witness(fact)] });
      continue;
    }
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
    const value = { method: memoryReviewDeriverVersion, assertion, outcome, findings, nextEvidence: [...nextEvidence],
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
  authorize: (tx: ReadTransaction) => Promise<void>;
}) {
  const { db, owner, scope, intent, maxBytes, expand, maySend, authorize } = options;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16_384) throw new Error('记忆预算须在 1–16 KiB。');
  const available: readonly MemoryRegion[] = regionsByIntent[intent];
  if (expand && (!available.includes(expand.region) || !Number.isSafeInteger(expand.start) || expand.start < 0 ||
      !/^[a-f0-9]{64}$/.test(expand.basisDigest)))
    throw new Error('记忆展开位置无效。');
  const regions = expand ? [expand.region] : available;
  const collect = async (tx: ReadTransaction) => {
    const results = await collectRecall(tx, scope, maySend, new Date().toISOString(), regions);
    const { bundle, selected } = packBundle(intent, regions, results, maxBytes, expand);
    const context = JSON.stringify(bundle);
    const sent = selected.flatMap(item => item.sent);
    const witnesses = (items: readonly RegionItem[]) => [...new Map(items.flatMap(item =>
      [...(item.basis ?? []), ...item.sent].map(ref => [ref.id, ref] as const))).values()];
    const opened = witnesses([...results.values()].flat());
    const basis = witnesses(selected);
    const expiresAt = selected.flatMap(item => item.expiresAt ? [item.expiresAt] : []).sort()[0] ?? null;
    return { bundle, context, receipt: { digest: digest(context), opened, basis, sent, expiresAt } };
  };
  let recall: Awaited<ReturnType<typeof collect>> | undefined;
  const receipt = await recordLocalRead(db, { learner: studioLearner, ownerKind: owner.kind, ownerId: owner.id,
    stepKey: owner.step, label: 'local:learning-memory', input: { purpose, intent, maxBytes, scope, ...(expand ? { expand } : {}) } }, async tx => {
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
