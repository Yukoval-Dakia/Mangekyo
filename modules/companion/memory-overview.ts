import { FactNotFoundError, factId, type FactId, type FactSnapshot, type LearnerId, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import type { CalibrationSummary, RefusalBoundary } from '@mangekyo/module-learner/facts/cognition';
import {
  hypothesisStatus, managedUnderstanding, saveBeliefCommand,
} from './belief.ts';
import {
  applyClaimCommand, claimType, claimValue, ClaimInputError, manageClaimCommand,
  matchesClaimEvidence, type ClaimRef,
} from './claim.ts';
import { memoryAssertion, memoryAssertionType } from './memory-assertion.ts';
import { researchSettings } from './research.ts';
import {
  citationExcerpt, extractedUnderstanding, isExtractedUnderstanding, reviewUnderstanding,
  understandingPresentation, understandingProjection, type ExtractedUnderstanding,
} from './understanding.ts';

export type CompanionReadScope = {
  readonly learner: LearnerId;
  query<Row>(sql: string, params: readonly (string | number | null | boolean | readonly string[])[]):
    Promise<{ readonly rows: readonly Row[] }>;
};

export type MemoryCategory = 'preference' | 'claim' | 'state' | 'refusal';

export type MemoryBasisEntry =
  | {
    readonly kind: 'turn-quote';
    readonly id: FactId;
    readonly rev: Revision;
    readonly accessEpoch: Tick;
    readonly excerpt: string;
    readonly start: number;
  }
  | {
    readonly kind: 'scope-object';
    readonly id: FactId;
    readonly rev: Revision;
    readonly accessEpoch: Tick;
    readonly type?: string;
  }
  | {
    readonly kind: 'activity-citation';
    readonly id: FactId;
    readonly rev: Revision;
    readonly accessEpoch: Tick;
    readonly anchor: string;
    readonly direction: 'support' | 'contradict' | 'unresolved';
    readonly excerpt: string;
  }
  | {
    readonly kind: 'learner-declaration';
    readonly id: FactId;
    readonly rev: Revision;
    readonly accessEpoch: Tick;
  };

export type MemoryActionSpec = {
  readonly method: 'POST';
  readonly path: string;
  readonly body: Record<string, unknown>;
};

export type MemoryRevokeSourceAction = MemoryActionSpec & {
  readonly sourceId: FactId;
};

export type MemoryItemActions = {
  readonly correct?: MemoryActionSpec;
  readonly forget?: MemoryActionSpec;
  readonly undo?: MemoryActionSpec;
  readonly revokeSources?: readonly MemoryRevokeSourceAction[];
};

export type MemoryOverviewItem = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly accessEpoch: Tick;
  readonly factType: 'companion.claim' | 'learner.preference';
  readonly category: MemoryCategory;
  readonly text: string;
  readonly origin: 'turn' | 'learner';
  readonly authority: 'directive' | null;
  readonly sticky: boolean;
  readonly scope: unknown;
  readonly validUntil: string | null;
  readonly expired: boolean;
  readonly refusal: RefusalBoundary | null;
  readonly recordedTick: Tick;
  readonly basis: readonly MemoryBasisEntry[];
  readonly actions: MemoryItemActions;
};

export type MemoryHypothesisItem = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly accessEpoch: Tick;
  readonly factType: 'companion.memoryAssertion';
  readonly kind: string;
  readonly status: string;
  readonly text: string;
  readonly scope: unknown;
  readonly sticky: boolean;
  readonly ttl: string | null;
  readonly review: 'supported' | 'contradicted' | 'unresolved' | 'unknown';
  readonly basis: readonly MemoryBasisEntry[];
  readonly actions: MemoryItemActions;
};

export type MemoryOverviewResponse = {
  readonly asOf: string;
  readonly categories: {
    readonly preference: readonly MemoryOverviewItem[];
    readonly claim: readonly MemoryOverviewItem[];
    readonly state: readonly MemoryOverviewItem[];
    readonly refusal: readonly MemoryOverviewItem[];
  };
  readonly stickyDirectives: readonly MemoryOverviewItem[];
  readonly hypotheses: readonly MemoryHypothesisItem[];
  readonly calibration: CalibrationSummary;
};

const learnerPreferenceType = 'learner.preference';

export const activeClaimSuccessorSql = (ignoreEntry = 'NULL') => `SELECT 1 FROM facts sf JOIN fact_revs sr
  ON (sr.learner_id,sr.fact_id,sr.rev)=(sf.learner_id,sf.id,sf.current_rev)
  WHERE sf.learner_id=f.learner_id AND sf.type=f.type AND sf.retracted_rev IS NULL
    AND COALESCE(sr.data#>>'{supersedes,id}', sr.data#>>'{belief,supersedes,id}')=f.id
    AND (sr.data->>'version'='1' OR sr.data ? 'belief') AND sf.id IS DISTINCT FROM ${ignoreEntry}
    AND ($3::text IS NULL OR COALESCE(sr.data#>>'{belief,turn}', sr.data#>>'{evidence_refs,0,id}') IS DISTINCT FROM $3)`;

export async function queryCurrentMemoryClaims(tx: CompanionReadScope, options: {
  ownTurn?: string | undefined; management?: boolean; query?: string; before?: string; learner?: boolean; type?: string;
}) {
  const { ownTurn, management, query, before, learner, type = claimType } = options;
  const { rows } = await tx.query<{ id: ClaimRef['id']; tick: Tick }>(`
    SELECT f.id,f.created_tick::text AS tick FROM facts f
    JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
      AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
      AND ($2='companion.claim' OR r.data ? 'belief')
      AND ($3::text IS NULL OR COALESCE(r.data#>>'{belief,turn}', r.data#>>'{evidence_refs,0,id}') IS DISTINCT FROM $3)
      AND NOT EXISTS (${activeClaimSuccessorSql()})
      AND ($4::text IS NULL OR position(lower($4) in lower(COALESCE(r.data->>'text',r.data->>'quote','')))>0)
      AND ($5::text IS NULL OR f.id<$5)
      AND ($6::boolean OR (r.data->>'action' IS DISTINCT FROM 'forget' AND r.data#>>'{belief,forgotten}' IS DISTINCT FROM 'true' AND (f.purpose && ARRAY['teaching','all'])))
    ORDER BY CASE WHEN $6 THEN 0 ELSE f.created_tick END DESC,f.id DESC LIMIT $7`,
    [tx.learner, type, ownTurn ?? null, query ?? null, before ?? null, Boolean(learner), learner || management ? 51 : 24]);
  return rows;
}

export async function checkMemoryClaimsCurrent(
  tx: CompanionReadScope, ids: readonly string[], ownTurn?: string, ignoreEntry?: string, allowRetracted = false, type = claimType,
) {
  if (!ids.length) return true;
  const { rows } = await tx.query<{ id: string }>(`SELECT f.id FROM facts f
    WHERE f.learner_id=$1 AND f.type=$2 AND ($6::boolean OR f.retracted_rev IS NULL) AND f.id=ANY($4::text[])
      AND NOT EXISTS (${activeClaimSuccessorSql('$5::text')})`, [tx.learner, type, ownTurn ?? null, ids, ignoreEntry ?? null, allowRetracted]);
  return rows.length === ids.length;
}

export function parseStoredClaim(value: unknown) {
  try { return claimValue(value); } catch (error) {
    if (!(error instanceof ClaimInputError)) throw error;
    return undefined;
  }
}

type OpenedSource = Parameters<typeof reviewUnderstanding>[2][number];
type ObjectWitness = { readonly id: string; readonly rev: number; readonly epoch: string; readonly type: string };

export type MemoryOverviewPorts = {
  readonly readStorage: Pick<ReadContext, 'fact'>;
  readonly readTeaching: Pick<ReadContext, 'fact'>;
  readonly isUnavailable: (error: unknown) => boolean;
  readonly undoTokenFor: (commandId: string, factId: string) => string;
  readonly openHypothesisObject: (data: ExtractedUnderstanding) => Promise<readonly ObjectWitness[] | undefined>;
  readonly openObjectiveCitations: (refs: ExtractedUnderstanding['evidence_refs']) => Promise<readonly OpenedSource[]>;
  readonly openUnderstandingCitations: (refs: ExtractedUnderstanding['evidence_refs']) => Promise<readonly OpenedSource[]>;
  readonly checkObjectScopeFact?: (fact: FactSnapshot) => Promise<boolean>;
  readonly isRevocableCompanionTurn: (fact: FactSnapshot) => boolean;
  readonly readCalibration: () => Promise<CalibrationSummary>;
};

export async function readMemoryOverview(
  tx: CompanionReadScope,
  asOf: string,
  ports: MemoryOverviewPorts,
): Promise<MemoryOverviewResponse> {
  const now = Date.parse(asOf);
  const unavailable = (error: unknown) => error instanceof FactNotFoundError || ports.isUnavailable(error);
  const openFact = async (read: Pick<ReadContext, 'fact'>, id: FactId) => {
    try { return await read.fact(id, { mode: 'following' }); }
    catch (error) { if (unavailable(error)) return undefined; throw error; }
  };
  const openEvidence = async (ref: ClaimRef, excerpt: string, start = 0, legacy = false) => {
    const fact = await openFact(ports.readTeaching, ref.id);
    if (!fact || !matchesClaimEvidence(fact, ref, excerpt, start, legacy)) return undefined;
    const { rows: [source] } = await tx.query<{ author: string }>(
      'SELECT author FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=$3', [tx.learner, ref.id, ref.rev]);
    return source?.author === 'learner' ? fact : undefined;
  };

  const claimRows = await queryCurrentMemoryClaims(tx, { learner: true });
  const preferenceRows = await tx.query<{ id: string; tick: Tick }>(`
      SELECT f.id, f.created_tick::text AS tick FROM facts f
      WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
        AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
      ORDER BY f.created_tick DESC, f.id LIMIT 50`, [tx.learner, learnerPreferenceType]);
  const assertionRows = await tx.query<{ id: string }>(`
      SELECT f.id FROM facts f JOIN fact_revs r
        ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
        AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
      ORDER BY f.changed_tick DESC, f.id LIMIT 64`, [tx.learner, memoryAssertionType]);
  const calibration = await ports.readCalibration();

  const claimIds = claimRows.slice(0, 50).map(row => row.id);
  const birthCommands = new Map<string, string>();
  if (claimIds.length) {
    const { rows: births } = await tx.query<{ fact_id: string; command_id: string }>(`
      SELECT r.fact_id, r.command_id FROM fact_revs r
      JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
      WHERE r.learner_id=$1 AND r.fact_id=ANY($2::text[]) AND r.rev=1
        AND c.state='done' AND c.type=ANY($3::text[])`,
      [tx.learner, claimIds, [applyClaimCommand, manageClaimCommand, saveBeliefCommand]]);
    for (const row of births) birthCommands.set(row.fact_id, row.command_id);
  }

  const categories: Record<MemoryCategory, MemoryOverviewItem[]> = {
    preference: [], claim: [], state: [], refusal: [],
  };
  const stickyDirectives: MemoryOverviewItem[] = [];

  for (const { id, tick } of claimRows.slice(0, 50)) {
    const fact = await openFact(ports.readStorage, id);
    if (!fact) continue;
    const parsed = parseStoredClaim(fact.value);
    if (!parsed) continue;
    if (parsed.version === 1 && parsed.action === 'forget') continue;

    const basis: MemoryBasisEntry[] = [];
    const revokeSources: MemoryRevokeSourceAction[] = [];
    let valid = true;

    if (parsed.version === 0) {
      if (!parsed.source) continue;
      const src = await openEvidence(parsed.source, parsed.quote, 0, true);
      if (!src) continue;
      basis.push({ kind: 'turn-quote', id: parsed.source.id, rev: parsed.source.rev, accessEpoch: parsed.source.accessEpoch, excerpt: parsed.quote, start: 0 });
      if (ports.isRevocableCompanionTurn(src)) {
        revokeSources.push({
          sourceId: src.ref.id, method: 'POST', path: `/api/memory/claims/sources/${src.ref.id}/revoke`,
          body: { expectedRev: src.ref.rev, purpose: 'teaching' },
        });
      }
    } else {
      if (parsed.scope.kind === 'object') {
        for (const ref of parsed.scope.basis) {
          const obj = await openFact(ports.readTeaching, ref.id);
          if (!obj || obj.ref.rev !== ref.rev || obj.accessEpoch !== ref.accessEpoch ||
              (ports.checkObjectScopeFact && !await ports.checkObjectScopeFact(obj))) {
            valid = false;
            break;
          }
          basis.push({ kind: 'scope-object', id: ref.id, rev: ref.rev, accessEpoch: ref.accessEpoch, type: obj.type });
        }
      }
      if (!valid) continue;
      for (const ref of parsed.evidence_refs) {
        const src = await openEvidence(ref, ref.excerpt, ref.start);
        if (!src) { valid = false; break; }
        basis.push({ kind: 'turn-quote', id: ref.id, rev: ref.rev, accessEpoch: ref.accessEpoch, excerpt: ref.excerpt, start: ref.start });
        if (ports.isRevocableCompanionTurn(src)) {
          revokeSources.push({
            sourceId: src.ref.id, method: 'POST', path: `/api/memory/claims/sources/${src.ref.id}/revoke`,
            body: { expectedRev: src.ref.rev, purpose: 'teaching' },
          });
        }
      }
      if (!valid) continue;
      if (parsed.origin === 'learner' && !basis.length) {
        basis.push({ kind: 'learner-declaration', id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch });
      }
    }

    const category: MemoryCategory = parsed.version === 0 ? 'claim' : parsed.category as MemoryCategory;
    const validUntil = parsed.version === 0 ? null : parsed.valid_until;
    const expired = validUntil !== null && Number.isFinite(now) && Date.parse(validUntil) <= now;
    const birthCommand = fact.ref.rev === 1 ? birthCommands.get(fact.ref.id) : undefined;
    const undoToken = birthCommand ? ports.undoTokenFor(birthCommand, fact.ref.id) : undefined;
    const item: MemoryOverviewItem = {
      id: fact.ref.id,
      rev: fact.ref.rev,
      accessEpoch: fact.accessEpoch,
      factType: claimType,
      category,
      text: parsed.version === 0 ? parsed.quote : parsed.text,
      origin: parsed.version === 0 ? 'turn' : parsed.origin as 'turn' | 'learner',
      authority: parsed.version === 1 && parsed.authority ? parsed.authority : null,
      sticky: parsed.version === 0 ? true : parsed.sticky,
      scope: parsed.version === 0 ? { kind: 'unknown' } : parsed.scope.kind === 'object'
        ? { kind: 'object', object: parsed.scope.object } : parsed.scope,
      validUntil,
      expired,
      refusal: parsed.version === 1 && parsed.refusal ? parsed.refusal : null,
      recordedTick: tick,
      basis,
      actions: {
        correct: { method: 'POST', path: `/api/memory/claims/${fact.ref.id}`, body: { action: 'correct', rev: fact.ref.rev, accessEpoch: fact.accessEpoch } },
        forget: { method: 'POST', path: `/api/memory/claims/${fact.ref.id}`, body: { action: 'forget', rev: fact.ref.rev, accessEpoch: fact.accessEpoch } },
        ...(undoToken ? { undo: { method: 'POST', path: `/api/memory/claims/${fact.ref.id}/undo`, body: { undo_token: undoToken } } } : {}),
        ...(revokeSources.length ? { revokeSources } : {}),
      },
    };
    categories[category].push(item);
    if (!expired && (item.sticky || item.authority === 'directive')) stickyDirectives.push(item);
  }

  for (const row of preferenceRows.rows) {
    const fact = await openFact(ports.readStorage, factId(row.id));
    if (!fact || fact.type !== learnerPreferenceType) continue;
    let projected;
    try { projected = understandingProjection(fact); } catch { continue; }
    if (!projected || typeof projected.text !== 'string') continue;
    const item: MemoryOverviewItem = {
      id: fact.ref.id,
      rev: fact.ref.rev,
      accessEpoch: fact.accessEpoch,
      factType: learnerPreferenceType,
      category: 'preference',
      text: projected.text,
      origin: 'learner',
      authority: 'directive',
      sticky: true,
      scope: projected.scope,
      validUntil: null,
      expired: false,
      refusal: null,
      recordedTick: row.tick,
      basis: [{ kind: 'learner-declaration', id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch }],
      actions: {},
    };
    categories.preference.push(item);
    stickyDirectives.push(item);
  }

  const hypotheses: MemoryHypothesisItem[] = [];
  for (const row of assertionRows.rows) {
    const id = factId(row.id);
    const fact = await openFact(ports.readStorage, id);
    if (!fact || fact.type !== memoryAssertionType) continue;
    if (isExtractedUnderstanding(fact.value)) {
      let data: ExtractedUnderstanding;
      try { data = extractedUnderstanding(fact.value); } catch { continue; }
      if (data.belief?.forgotten) continue;
      if (data.belief && !await checkMemoryClaimsCurrent(tx, [id], undefined, undefined, true, memoryAssertionType)) continue;
      let objectBasis: readonly ObjectWitness[] = [];
      let sources: readonly OpenedSource[];
      if (data.belief) {
        const openedObject = await ports.openHypothesisObject(data);
        if (!openedObject) continue;
        objectBasis = openedObject;
        sources = await ports.openObjectiveCitations(data.evidence_refs);
      } else {
        sources = await ports.openUnderstandingCitations(data.evidence_refs);
      }
      if (sources.length !== data.evidence_refs.length) continue;
      const managed = managedUnderstanding(fact.ref.id, data, sources);
      if (managed.evidenceState !== 'current' || managed.understanding.text === null) continue;
      const reviewResult = reviewUnderstanding(fact.ref.id, data, sources);
      const reviewOutcome = reviewResult.kind === 'value' ? reviewResult.value.outcome.kind : 'unknown';
      const basis: MemoryBasisEntry[] = [
        ...data.evidence_refs.map((ref, index) => ({
          kind: 'activity-citation' as const,
          id: ref.id, rev: ref.rev, accessEpoch: ref.accessEpoch,
          anchor: ref.anchor, direction: ref.direction,
          excerpt: citationExcerpt(sources[index]!, ref) ?? ref.excerpt ?? '',
        })),
        ...objectBasis.map(item => ({
          kind: 'scope-object' as const,
          id: factId(item.id), rev: item.rev as Revision, accessEpoch: item.epoch as Tick, type: item.type,
        })),
      ];
      hypotheses.push({
        id: fact.ref.id,
        rev: fact.ref.rev,
        accessEpoch: fact.accessEpoch,
        factType: memoryAssertionType,
        kind: understandingPresentation(data, sources),
        status: data.belief ? hypothesisStatus(data) : data.sticky ? 'learner-corrected' : 'tentative',
        text: managed.understanding.text,
        scope: data.scope,
        sticky: data.sticky,
        ttl: data.ttl,
        review: reviewOutcome,
        basis,
        actions: {
          correct: { method: 'POST', path: `/api/memory/claims/${fact.ref.id}`, body: { action: 'correct', rev: fact.ref.rev, accessEpoch: fact.accessEpoch } },
          forget: { method: 'POST', path: `/api/memory/claims/${fact.ref.id}`, body: { action: 'forget', rev: fact.ref.rev, accessEpoch: fact.accessEpoch } },
          ...(!data.sticky && data.undo_token ? { undo: { method: 'POST', path: `/api/memory/claims/${fact.ref.id}/undo`, body: { undo_token: data.undo_token } } } : {}),
        },
      });
    } else {
      let legacy;
      try { legacy = memoryAssertion(fact.value); } catch { continue; }
      const basis: MemoryBasisEntry[] = [];
      let allOpen = true;
      for (const ref of legacy.evidence) {
        const src = await openFact(ports.readStorage, ref.id);
        if (!src || src.ref.rev !== ref.rev || src.accessEpoch !== ref.accessEpoch) { allOpen = false; break; }
        basis.push({
          kind: 'activity-citation', id: ref.id, rev: ref.rev, accessEpoch: ref.accessEpoch,
          anchor: ref.itemId, direction: ref.direction, excerpt: '',
        });
      }
      if (!allOpen) continue;
      hypotheses.push({
        id: fact.ref.id,
        rev: fact.ref.rev,
        accessEpoch: fact.accessEpoch,
        factType: memoryAssertionType,
        kind: 'observation',
        status: 'learner-corrected',
        text: legacy.text,
        scope: legacy.scope,
        sticky: true,
        ttl: legacy.scope.validUntil ?? null,
        review: 'unknown',
        basis,
        actions: {},
      });
    }
  }

  stickyDirectives.sort((left, right) => {
    const diff = BigInt(right.recordedTick) - BigInt(left.recordedTick);
    if (diff !== 0n) return diff > 0n ? 1 : -1;
    return right.id.localeCompare(left.id);
  });

  return { asOf, categories, stickyDirectives, hypotheses, calibration };
}

export async function readActiveMisconceptionConceptIds(
  tx: CompanionReadScope,
  ports: Pick<MemoryOverviewPorts, 'readStorage' | 'isUnavailable' | 'openHypothesisObject' | 'openObjectiveCitations'>,
): Promise<ReadonlySet<string>> {
  const active = new Set<string>();
  const unavailable = (error: unknown) => error instanceof FactNotFoundError || ports.isUnavailable(error);
  const { rows } = await tx.query<{ id: string }>(`
    SELECT f.id FROM facts f JOIN fact_revs r
      ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
      AND r.data->>'version'='2' AND r.data->>'kind'='misconception' AND r.data ? 'belief'
      AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
    ORDER BY f.changed_tick DESC, f.id LIMIT 64`, [tx.learner, memoryAssertionType]);
  for (const row of rows) {
    const id = factId(row.id);
    let fact: FactSnapshot;
    try { fact = await ports.readStorage.fact(id, { mode: 'following' }); }
    catch (error) { if (unavailable(error)) continue; throw error; }
    let data: ExtractedUnderstanding;
    try { data = extractedUnderstanding(fact.value); } catch { continue; }
    if (!data.belief || data.belief.forgotten || data.scope.kind !== 'object') continue;
    if (!await checkMemoryClaimsCurrent(tx, [id], undefined, undefined, true, memoryAssertionType)) continue;
    if (hypothesisStatus(data) === 'disputed') continue;
    if (!await ports.openHypothesisObject(data)) continue;
    const sources = await ports.openObjectiveCitations(data.evidence_refs);
    if (sources.length !== data.evidence_refs.length) continue;
    const reviewed = reviewUnderstanding(fact.ref.id, data, sources);
    if (reviewed.kind === 'value' && reviewed.value.outcome.kind === 'supported') active.add(data.scope.object);
  }
  return active;
}

export async function authorizeResearchTodoSpec(
  rawSpec: unknown,
  ports: {
    readonly settingsId: FactId;
    readonly readResearch: Pick<ReadContext, 'fact'>;
    readonly isUnavailable: (error: unknown) => boolean;
    readonly verifyFact?: (fact: FactSnapshot) => Promise<boolean>;
  },
) {
  if (!rawSpec || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) return undefined;
  const spec = rawSpec as {
    goal?: unknown; workerProfile?: unknown; settingsRevision?: unknown;
    sourceFactRev?: { id: string; revision: number; accessEpoch: string };
    refs?: { id: string; revision: number; accessEpoch: string }[];
  };
  if (typeof spec.goal !== 'string' || typeof spec.workerProfile !== 'string' || !spec.sourceFactRev) return undefined;
  const open = async (id: FactId) => {
    try { return await ports.readResearch.fact(id, { mode: 'following' }); }
    catch (error) { if (error instanceof FactNotFoundError || ports.isUnavailable(error)) return undefined; throw error; }
  };
  const settingsFact = await open(ports.settingsId);
  if (!settingsFact || settingsFact.ref.rev !== spec.settingsRevision) return undefined;
  let parsedSettings;
  try { parsedSettings = researchSettings(settingsFact.value); } catch { return undefined; }
  if (!parsedSettings.enabled) return undefined;
  const refs = [spec.sourceFactRev, ...(Array.isArray(spec.refs) ? spec.refs : [])];
  for (const ref of refs) {
    const opened = await open(factId(ref.id));
    if (!opened || opened.ref.rev !== ref.revision || opened.accessEpoch !== ref.accessEpoch ||
        (ports.verifyFact && !await ports.verifyFact(opened))) return undefined;
  }
  return { goal: spec.goal, workerProfile: spec.workerProfile };
}

export async function listManagedMemory(
  tx: CompanionReadScope,
  before: string | null,
  ports: {
    readonly openClaim: (id: ClaimRef['id']) => Promise<FactSnapshot | undefined>;
    readonly evidenceState: (claim: ReturnType<typeof parseStoredClaim>) => Promise<'current' | 'unavailable' | 'unknown'>;
    readonly openHypothesisObject: (data: ExtractedUnderstanding) => Promise<readonly ObjectWitness[] | undefined>;
    readonly openObjectiveCitations: (refs: ExtractedUnderstanding['evidence_refs']) => Promise<readonly OpenedSource[]>;
    readonly openUnderstandingCitations: (refs: ExtractedUnderstanding['evidence_refs']) => Promise<readonly OpenedSource[]>;
  },
) {
  const witnessOf = (fact: FactSnapshot): ClaimRef => ({ id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch });
  const rows = await queryCurrentMemoryClaims(tx, { learner: true, ...(before ? { before } : {}) });
  const items = [];
  for (const { id, tick } of rows.slice(0, 50)) {
    const fact = await ports.openClaim(id);
    if (!fact) continue;
    const claim = parseStoredClaim(fact.value);
    const ref = witnessOf(fact);
    const evidenceState = await ports.evidenceState(claim);
    items.push({
      ref, recordedTick: tick, state: claim?.version === 1 && claim.action === 'forget' ? 'forgotten' : 'current',
      claim: evidenceState === 'current' || (evidenceState === 'unknown' && claim?.version === 1 && claim.origin === 'learner') ? claim : null,
      evidenceState,
    });
  }
  const { rows: extracted } = await tx.query<{ id: string }>(`SELECT f.id FROM facts f JOIN fact_revs r
    ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.data->>'version'='2'
    ORDER BY f.changed_tick DESC,f.id LIMIT 50`, [tx.learner, memoryAssertionType]);
  const understandings = [];
  for (const { id } of extracted) {
    const fact = await ports.openClaim(factId(id));
    if (!fact) continue;
    const data = extractedUnderstanding(fact.value);
    if (data.belief && !await checkMemoryClaimsCurrent(tx, [id], undefined, undefined, true, memoryAssertionType)) continue;
    const sources = data.belief
      ? (await ports.openHypothesisObject(data) ? await ports.openObjectiveCitations(data.evidence_refs) : [])
      : await ports.openUnderstandingCitations(data.evidence_refs);
    understandings.push({ ref: witnessOf(fact), ...managedUnderstanding(fact.ref.id, data, sources) });
  }
  return { items, understandings, next: rows.length > 50 ? rows[49]!.id : null };
}
