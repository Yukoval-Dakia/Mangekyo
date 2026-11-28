import { FactNotFoundError, factId, type BusWitness, type FactId, type FactSnapshot,
  type LearnerId, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import type { ActivityEvidenceObservation } from './evidence-slice.ts';
import { activityEvidenceSlice } from './evidence-slice.ts';
import {
  readActivitySubmissionBirth, workbookLinkCandidates, workbookWitnessesBy, type ActivityEvidenceReadScope,
} from './evidence-read.ts';
import { posttestIssuanceType, posttestSubmissionType, retentionPaperType } from './retention-posttest.ts';
import { workbookAttempt, workbookAttemptType, workbookPaperType, workbookRequestId } from './workbook-values.ts';
import { sourceReference } from './source-values.ts';
import {
  readTextbookBlockConcepts, readTextbookPulseHistory, readTextbookPulseQuestion,
  type TextbookPulseObservation as ContentPulseObservation, type TextbookPulseBlockProof,
} from '@mangekyo/module-content/facts/textbook-mastery-pulse';
import {
  KnowledgeEdgeBasisError, knowledgeEdgeType, knowledgeEndpointKind, openKnowledgeEdgeRevision,
} from '@mangekyo/module-content/facts/knowledge-edge';
import type { KnowledgeReadAccess } from '@mangekyo/module-content/facts/knowledge-reads';
import type { workbookEvidenceReader } from './workbook-evidence-reader.ts';

export type PulseEvidenceWorkbook = ReturnType<typeof workbookEvidenceReader<ActivityEvidenceReadScope>>;
export type PulseEvidenceAnchor = {
  readonly submission: BusWitness; readonly question: BusWitness;
  readonly itemId: string; readonly href: string; readonly recordedAt: Tick; readonly expiresAt?: string;
  readonly basis: readonly BusWitness[];
  readonly priorStable?: { readonly conceptIds: readonly string[]; readonly basis: readonly [BusWitness, ...BusWitness[]] };
};
export type PulseObservation = Omit<ContentPulseObservation, 'priorStable'> & {
  priorStable?: PulseEvidenceAnchor['priorStable'];
};

class PulseReadDenied extends Error {}
export const isTextbookPulseUnavailable = (error: unknown) =>
  error instanceof FactNotFoundError || error instanceof PulseReadDenied || error instanceof KnowledgeEdgeBasisError ||
  (error instanceof Error && error.name === 'FactReadDeniedError');
const unavailable = isTextbookPulseUnavailable;
const witness = (fact: FactSnapshot, mode: BusWitness['mode'] = 'following'): BusWitness =>
  ({ ...fact.ref, type: fact.type, accessEpoch: fact.accessEpoch, mode });
const use = (fact: FactSnapshot) => ({ id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch });

export type PulseSubmissionInventory = {
  readonly id: FactId; readonly rev: number; readonly type: string; readonly granted: boolean;
};

export async function textbookPulseSubmissions(tx: ActivityEvidenceReadScope, watermark: Tick, purpose: string) {
  return (await tx.query<PulseSubmissionInventory>(
    `SELECT f.id,f.current_rev AS rev,f.type,(f.purpose && ARRAY[$3,'all']::text[]) AS granted
       FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      WHERE f.learner_id=$1 AND f.type=ANY($2::text[]) AND f.retracted_rev IS NULL
        AND f.changed_tick<=$4::bigint
        AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id
          AND t.kind='fact' AND t.id=f.id)
      ORDER BY f.created_tick,f.id`,
    [tx.learner, [workbookAttemptType, posttestSubmissionType], purpose, watermark])).rows;
}

export async function pulseSourcePaper(tx: ActivityEvidenceReadScope,
  attempt: ReturnType<typeof workbookAttempt>, controlled: boolean) {
  if (!controlled) {
    const { rows: [paper] } = await tx.query<{ rev: number }>(
      'SELECT current_rev AS rev FROM facts WHERE learner_id=$1 AND id=$2 AND type=$3 AND retracted_rev IS NULL',
      [tx.learner, attempt.paperId, workbookPaperType]);
    return paper && { id: attempt.paperId as FactId, rev: paper.rev };
  }
  const { rows: [issuance] } = await tx.query<{ id: string; rev: number }>(
    `SELECT i.data->'paper'->>'id' AS id,(i.data->'paper'->>'rev')::int AS rev
       FROM fact_revs i JOIN facts f ON (f.learner_id,f.id)=(i.learner_id,i.fact_id)
      WHERE i.learner_id=$1 AND i.fact_id=$2 AND i.rev=1 AND i.kind='value' AND f.type=$3`,
    [tx.learner, attempt.paperId, posttestIssuanceType]);
  return issuance && { id: issuance.id as FactId, rev: issuance.rev };
}

export type PulseGatherResult = {
  readonly events: ActivityEvidenceObservation[]; readonly anchors: PulseEvidenceAnchor[];
  readonly observations: PulseObservation[];
  readonly omissions: { ref: { id: FactId; rev: number }; reason: string }[]; readonly complete: boolean;
};
type PulseOmission = PulseGatherResult['omissions'][number];

export async function gatherTextbookPulseEvidence(
  tx: ActivityEvidenceReadScope, read: Pick<ReadContext, 'fact'>,
  scope: { readonly clockWatermark: Tick; readonly asOf: string; readonly purpose: string },
  inventory: readonly PulseSubmissionInventory[], limit: number,
  evidence: PulseEvidenceWorkbook, concepts: ReadonlySet<FactId>,
  track: { href(question: FactSnapshot): string },
  backtrace: (input: { paper: { id: string; rev: number }; itemId: string; question: { id: string; rev: number } }) =>
    Promise<readonly { content: { id: string; rev: number }; witnesses: readonly BusWitness[] }[] | null>,
): Promise<PulseGatherResult | null> {
  if (inventory.length > limit) return null;
  const events: ActivityEvidenceObservation[] = [];
  const anchors: PulseEvidenceAnchor[] = [];
  const observations: PulseObservation[] = [];
  const omissions: PulseOmission[] = [];
  const omit = (ref: PulseOmission['ref'], reason: string) => omissions.push({ ref, reason });
  const inaccessible = inventory.filter(row => !row.granted);
  for (const row of inaccessible) omit({ id: row.id, rev: row.rev }, 'unavailable-process-witness');
  for (const row of inventory) {
    if (!row.granted) continue;
    try {
      const fact = await read.fact(row.id, { mode: 'following' });
      const attempt = workbookAttempt(fact.value);
      if (fact.type !== row.type || attempt.paper.questions.length !== 1) {
        omit(fact.ref, 'unresolved-item-identity');
        continue;
      }
      const item = attempt.paper.questions[0]!;
      const birth = await readActivitySubmissionBirth(tx, fact.ref, row.type as 'activity.workbookAttempt');
      if (!birth) {
        omit(fact.ref, 'unwitnessed-submission');
        continue;
      }
      const controlled = row.type === posttestSubmissionType;
      const openedControlled = controlled
        ? await evidence.openControlledSubmission(tx as never, read, attempt, birth.tick) : undefined;
      const opened = await evidence.openRetentionTarget(tx as never, read,
        (openedControlled?.source.ref.id ?? attempt.paperId) as FactId, item.id);
      const observed = await evidence.readWorkbookEvidence(tx as never, read, opened, fact.ref.id);
      if (BigInt(observed.recordedAt) > BigInt(scope.clockWatermark) ||
          observed.observation.submittedAt > scope.asOf) {
        omit(fact.ref, 'outside-evidence-window');
        continue;
      }
      const dimensionBasis: BusWitness[] = [];
      const dimensions: FactId[] = [];
      if (item.sourceQuestionRef) {
        const candidates = await workbookLinkCandidates(tx, knowledgeEdgeType, item.sourceQuestionRef, birth.tick, ['targets_concept']);
        for (const { id: edgeId } of candidates) {
          const opened: BusWitness[] = [];
          const localRead = {
            fact: async (...args: Parameters<typeof read.fact>) => {
              const openedFact = await read.fact(...args);
              opened.push(witness(openedFact, args[1].mode));
              return openedFact;
            },
          };
          try {
            const { edge } = await openKnowledgeEdgeRevision({ learner: tx.learner, read: localRead }, edgeId, { mode: 'following' });
            if (edge.kind !== 'targets_concept' || edge.from.blockId !== undefined || edge.to.blockId !== undefined ||
                edge.to.kind !== 'concept') continue;
            if (!await workbookWitnessesBy(tx, opened.map(({ id, rev }) => ({ id, rev })), birth.tick)) continue;
            dimensionBasis.push(...opened);
            dimensions.push(edge.to.sourceUse.id);
          } catch (error) {
            if (!unavailable(error)) throw error;
          }
        }
      }
      const allDimensions = [...new Set(dimensions)], relevant = allDimensions.filter(id => concepts.has(id));
      const question = item.sourceQuestionRef
        ? await read.fact(item.sourceQuestionRef.id as FactId, { mode: 'pinned', rev: item.sourceQuestionRef.rev })
        : undefined;
      if (!question) {
        omit(fact.ref, 'unresolved-item-identity');
        continue;
      }
      events.push({
        submission: { id: fact.ref.id, rev: fact.ref.rev }, occurredAt: observed.observation.submittedAt,
        concepts: relevant.length ? allDimensions : [], novelty: 'same', helpLevel: observed.process.helpLevel, result: observed.observation.result,
        ...(observed.duration === undefined ? {} : { duration: observed.duration }),
      });
      const observation: PulseObservation = {
        conceptIds: relevant, question: use(question), itemId: item.id, submissionAccessEpoch: fact.accessEpoch,
        observation: {
          submission: fact.ref, admittedAt: observed.observation.admittedAt,
          submittedAt: observed.observation.submittedAt, result: observed.observation.result,
          exposure: observed.observation.exposure,
        },
        process: { helpLevel: observed.process.helpLevel },
      };
      observations.push(observation);
      anchors.push({
        submission: witness(fact), question: witness(question, 'pinned'), itemId: item.id,
        href: track.href(question), recordedAt: observed.observation.admittedAt, basis: dimensionBasis,
      });
      if (observed.observation.result === 'correct' && observed.process.helpLevel === 'independent') {
        const paper = await pulseSourcePaper(tx, attempt, controlled);
        const proofs = paper ? await backtrace({
          paper, itemId: item.id, question: { id: question.ref.id, rev: question.ref.rev },
        }) : null;
        const stable = proofs?.find(proof => proof.content.id === question.ref.id && proof.content.rev === question.ref.rev);
        if (stable?.witnesses.length) {
          observation.priorStable = { conceptIds: relevant, basis: stable.witnesses as [BusWitness, ...BusWitness[]] };
          Object.assign(anchors[anchors.length - 1]!, { priorStable: observation.priorStable });
        }
      }
    } catch (error) {
      if (!unavailable(error)) throw error;
      omit({ id: row.id, rev: 1 }, 'unavailable-process-witness');
    }
  }
  return { events, anchors, observations, omissions, complete: inaccessible.length === 0 && omissions.length === 0 };
}

async function observedUpperMs(tx: ActivityEvidenceReadScope, candidateId: FactId,
  watermark: Tick, asOf: string, purpose: string) {
  const { rows } = await tx.query<{ upperMs: number | null }>(
    `WITH direct AS (
       SELECT $2::text AS id, NULL::text AS family_id
       UNION
       SELECT CASE WHEN r.data#>>'{from,sourceUse,id}'=$2
         THEN r.data#>>'{to,sourceUse,id}' ELSE r.data#>>'{from,sourceUse,id}' END,
         r.data#>>'{variant,familyId}'
       FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
       WHERE f.learner_id=$1 AND f.type='content.knowledgeEdge' AND f.retracted_rev IS NULL
         AND f.purpose && ARRAY[$6,'all']::text[]
         AND r.data->>'kind'='variant_of' AND f.changed_tick<=$3::bigint
         AND (r.data#>>'{from,sourceUse,id}'=$2 OR r.data#>>'{to,sourceUse,id}'=$2)
     ), family AS (
       SELECT id FROM direct
       UNION
       SELECT endpoint FROM direct d
       JOIN facts f ON f.learner_id=$1 AND f.type='content.knowledgeEdge' AND f.retracted_rev IS NULL
         AND f.purpose && ARRAY[$6,'all']::text[] AND f.changed_tick<=$3::bigint
       JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
         AND r.data->>'kind'='variant_of' AND r.data#>>'{variant,familyId}'=d.family_id
       CROSS JOIN LATERAL (VALUES (r.data#>>'{from,sourceUse,id}'), (r.data#>>'{to,sourceUse,id}')) AS e(endpoint)
       WHERE d.family_id IS NOT NULL
     ), attempts AS (
       SELECT r.data FROM facts f JOIN fact_revs r
         ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
       JOIN family ON EXISTS (
         SELECT 1 FROM jsonb_array_elements(r.data->'paper'->'questions') q
         WHERE q->'sourceQuestionRef'->>'id'=family.id)
       WHERE f.learner_id=$1 AND f.type=ANY($4::text[]) AND f.retracted_rev IS NULL
         AND f.purpose && ARRAY[$6,'all']::text[]
         AND f.changed_tick<=$3::bigint AND r.data->>'submittedAt'<=$5
         AND jsonb_array_length(r.data->'paper'->'questions')=1
         AND (r.data->>'effectiveDurationMs')~'^[1-9][0-9]*$'
     )
     SELECT max((data->>'effectiveDurationMs')::bigint)::int AS "upperMs" FROM attempts`,
    [tx.learner, candidateId, watermark, [workbookAttemptType, posttestSubmissionType], asOf, purpose]);
  const upperMs = rows[0]?.upperMs;
  return typeof upperMs === 'number' && Number.isSafeInteger(upperMs) && upperMs > 0 && upperMs <= 120_000
    ? upperMs : undefined;
}

async function textbookPulseExposed(tx: ActivityEvidenceReadScope, candidateId: FactId,
  watermark: Tick) {
  const { rows: [hit] } = await tx.query(
    `SELECT 1 FROM fact_revs r JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
       WHERE r.learner_id=$1 AND f.type LIKE 'activity.%' AND r.tick<=$3::bigint
         AND r.data::text LIKE '%' || $2 || '%'
     UNION ALL
     SELECT 1 FROM commands WHERE learner_id=$1 AND type LIKE 'activity.%'
       AND (tick IS NULL OR tick<=$3::bigint)
       AND (input::text LIKE '%' || $2 || '%' OR receipt::text LIKE '%' || $2 || '%')
     UNION ALL
     SELECT 1 FROM effects WHERE learner_id=$1 AND ended_tick<=$3::bigint
       AND result::text LIKE '%' || $2 || '%' LIMIT 1`,
    [tx.learner, candidateId, watermark]);
  return hit ? 'exposed' as const : 'unexposed' as const;
}

export async function textbookPulseKnowledgeEdges(tx: ActivityEvidenceReadScope, purpose: string) {
  return (await tx.query<{ id: FactId; kind: string }>(
    `SELECT f.id,r.data->>'kind' AS kind FROM facts f
       JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type='content.knowledgeEdge' AND f.retracted_rev IS NULL
       AND f.purpose && ARRAY[$2,'all']::text[] ORDER BY f.id`, [tx.learner, purpose])).rows;
}

export type PulseConceptAccess = Omit<KnowledgeReadAccess, 'reopenLegacyQuestion'> & {
  readonly reopenLegacyQuestion?: (pin: { id: string; rev: number }) => Promise<boolean>;
};

export type PulseHistoryActivity = {
  readonly complete: boolean; readonly observations: readonly ContentPulseObservation[];
};

export async function textbookPulseHistory(access: PulseConceptAccess, input: {
  readonly conceptId: FactId; readonly targetEdges: readonly FactId[];
  readonly asOf: string; readonly activity: PulseHistoryActivity;
}) {
  return readTextbookPulseHistory(access as never, {
    conceptId: input.conceptId, targetEdges: { complete: true, edgeIds: input.targetEdges },
    asOf: input.asOf, recentErrorSince: new Date(0).toISOString(), activity: input.activity,
  });
}

export async function textbookPulseCandidate(tx: ActivityEvidenceReadScope, access: PulseConceptAccess, input: {
  readonly conceptId: FactId; readonly read: Pick<ReadContext, 'fact' | 'slot'>;
  readonly releaseUses: readonly string[]; readonly targetEdges: readonly FactId[];
  readonly variantEdgeIds: readonly FactId[]; readonly archetypeEdgeIds: readonly FactId[];
  readonly clockWatermark: Tick; readonly asOf: string;
}) {
  return readTextbookPulseQuestion({
    ...access, releaseUses: input.releaseUses, read: input.read,
    readDuration: async (witness: Parameters<Parameters<typeof readTextbookPulseQuestion>[0]['readDuration']>[0]) => {
      const fact = await input.read.fact(witness.id, { mode: 'pinned', rev: witness.rev });
      if (fact.accessEpoch !== witness.accessEpoch || knowledgeEndpointKind(fact) !== 'question') return;
      const upperMs = await observedUpperMs(tx, witness.id, input.clockWatermark, input.asOf, access.purpose);
      return upperMs && { question: witness, upperMs };
    },
    readExposure: async ({ candidate }: { candidate: { id: FactId } }) => ({
      kind: await textbookPulseExposed(tx, candidate.id, input.clockWatermark),
    }),
  } as never, {
    conceptId: input.conceptId, targetEdges: { complete: true, edgeIds: input.targetEdges },
    complete: true, variantEdgeIds: input.variantEdgeIds, archetypeEdgeIds: input.archetypeEdgeIds,
  });
}

export function parseTextbookPulseClaim(claim: Record<string, unknown>, pageId: string) {
  if (typeof claim.requestId !== 'string' || !claim.requestId) throw new Error('领取请求无效。');
  const requestId = workbookRequestId(claim.requestId);
  if (typeof claim.key !== 'string' || !claim.key) throw new Error('快检题目无效。');
  let target: unknown;
  try { target = JSON.parse(claim.key); }
  catch { throw new Error('快检题目无效。'); }
  if (!Array.isArray(target) || target.length !== 4 || target[0] !== pageId ||
      typeof target[2] !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(target[2]) ||
      typeof target[3] !== 'number' || !Number.isSafeInteger(target[3]) || target[3] < 1)
    throw new Error('快检题目无效。');
  if (typeof claim.deletionWatermark !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(claim.deletionWatermark))
    throw new Error('删除水位无效。');
  return { requestId, key: claim.key, id: factId(target[2]), rev: target[3] as Revision,
    deletionWatermark: claim.deletionWatermark };
}

export function textbookPulseClaimMatches(view: unknown, claim: { readonly key: string }) {
  const mastery = view && typeof view === 'object'
    ? (view as { masteryPulse?: { blocks?: unknown } }).masteryPulse : undefined;
  const blocks = mastery && typeof mastery === 'object' && Array.isArray(mastery.blocks) ? mastery.blocks : [];
  return blocks.some(block => Array.isArray(block.concepts) &&
    (block.concepts as readonly { candidate?: { key?: unknown } }[]).some(
      concept => concept?.candidate?.key === claim.key));
}

export function bindPulseReader<Reader extends { fact(...args: Parameters<ReadContext['fact']>): Promise<FactSnapshot> }>(
  reader: Reader, checkFact: (fact: FactSnapshot) => Promise<void>): Reader {
  return Object.assign(Object.create(Object.getPrototypeOf(reader)), reader, {
    async fact(...args: Parameters<ReadContext['fact']>) {
      const fact = await reader.fact(...args);
      await checkFact(fact);
      return fact;
    },
  });
}

export async function reopenPulseWitnesses(refs: readonly BusWitness[],
  reopen: (ref: BusWitness) => Promise<BusWitness | undefined>) {
  const verified: BusWitness[] = [];
  for (const ref of refs) {
    try {
      const fact = await reopen(ref);
      if (fact) verified.push(ref);
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  return verified;
}

export type PulseMasteryConcept = { readonly conceptId: string } & (
  | { readonly state: 'unknown'; readonly reason?: string }
  | { readonly state: 'steady' | 'decaying' | 'fragile' }
);

export type PulseMasteryView = {
  readonly asOf: string;
  readonly blocks: readonly {
    readonly page: { readonly id: string; readonly rev: number; readonly accessEpoch: string };
    readonly blockId: string; readonly concepts: readonly PulseMasteryConcept[];
  }[];
};

export async function projectTextbookPulse(input: {
  readonly tx: ActivityEvidenceReadScope;
  readonly page: {
    readonly id: string; readonly rev: number; readonly accessEpoch: string; readonly purpose: readonly string[];
    readonly blocks: readonly { readonly id: string }[]; readonly archived?: boolean;
  };
  readonly access: PulseConceptAccess;
  readonly read: { readonly fact: (...args: Parameters<ReadContext['fact']>) => Promise<FactSnapshot> };
  readonly reopen: (scope: { learner: LearnerId; purpose: string; recipientId: string; asOf: string; clockWatermark: Tick },
    refs: readonly BusWitness[]) => Promise<readonly BusWitness[]>;
  readonly resolveLegacyQuestion: (pin: { id: string; rev: number }) => Promise<boolean>;
  readonly slot: ReadContext['slot']; readonly evidence: PulseEvidenceWorkbook;
  readonly backtrace: Parameters<typeof gatherTextbookPulseEvidence>[8];
  readonly derive: (deriver: string, payload: unknown, refs: readonly BusWitness[]) => Promise<unknown>;
  readonly limit: number; readonly project: (request: never, sources: never) => Promise<PulseMasteryView>;
}): Promise<{ masteryPulse: unknown } | Record<string, never>> {
  const { tx, page, access, read, reopen, resolveLegacyQuestion, slot, evidence, backtrace, derive, limit, project } = input;
  const teaching = 'teaching';
  if (page.archived || !page.purpose.some(value => value === teaching || value === 'all')) return {};
  const questionHref = (question: FactSnapshot) => '/materials/records/' + question.ref.id + '?' +
    new URLSearchParams({ ref: JSON.stringify(sourceReference(question, { kind: 'question', itemId: 'question' })) });
  const pagePin = { id: factId(page.id), rev: page.rev as Revision, accessEpoch: page.accessEpoch as Tick };
  const edgeRows = await textbookPulseKnowledgeEdges(tx, teaching);
  const edgeIds = (...kinds: string[]) => edgeRows.filter(row => kinds.includes(row.kind)).map(row => row.id);
  const proofs: TextbookPulseBlockProof[] = [];
  for (const block of page.blocks) {
    await readTextbookBlockConcepts(access, {
      block: { ...pagePin, blockId: block.id },
      edges: { complete: true, edgeIds: edgeIds('explains', 'maps_to_chapter') },
    }, proof => proofs.push(proof));
  }
  if (!proofs.length) return {};
  const { rows: [clock] } = await tx.query<{ clock: string }>(
    'SELECT max(changed_tick)::text AS clock FROM facts WHERE learner_id=$1', [tx.learner]);
  const scope = {
    learner: tx.learner, purpose: teaching, recipientId: tx.learner,
    asOf: new Date().toISOString(), clockWatermark: (clock?.clock ?? '0') as Tick,
  };
  const conceptIds = new Set(proofs.flatMap(proof => proof.concepts.map(link => link.conceptId)));
  const inventory = await textbookPulseSubmissions(tx, scope.clockWatermark, teaching);
  const gathered = await gatherTextbookPulseEvidence(tx, read as never, scope, inventory, limit,
    evidence, conceptIds, { href: questionHref }, backtrace);
  const slice = gathered ? activityEvidenceSlice(scope.clockWatermark, scope.asOf, undefined, gathered.events) : null;
  const unwitnessed = new Set(gathered?.events.flatMap(event => event.helpLevel === 'unknown' ? event.concepts : []) ?? []);
  const completeConceptIds = gathered?.complete ? [...conceptIds].filter(id => !unwitnessed.has(id)) : undefined;
  const mastery = await project({
    ...scope,
    blocks: proofs.map(proof => ({ blockId: proof.blockId, page: proof.page, basis: proof.basis, concepts: proof.concepts })),
  } as never, {
    readEvidence: async () => !slice || !gathered ? null : {
      slice: { ...slice, omissions: [...(slice.omissions ?? []), ...gathered.omissions] },
      anchors: gathered.anchors,
      ...(completeConceptIds ? { completeConceptIds } : {}),
    },
    derive: async (deriveScope: typeof scope, method: { deriver: string }, payload: unknown, refs: readonly BusWitness[]) =>
      (await reopen(deriveScope, refs)).length === refs.length ? derive(method.deriver, payload, refs) : null,
    reopen,
  } as never);
  const observations = (gathered?.observations ?? []) as unknown as readonly ContentPulseObservation[];
  const historyAccess = { ...access, reopenLegacyQuestion: resolveLegacyQuestion };
  const blocks = await Promise.all(mastery.blocks.map(async block => ({
    page: block.page, blockId: block.blockId,
    concepts: await Promise.all(block.concepts.map(async concept => {
      if (concept.state === 'unknown') {
        return { conceptId: concept.conceptId, state: concept.state,
          ...(concept.reason === undefined ? {} : { reason: concept.reason }) };
      }
      const history = await textbookPulseHistory(historyAccess as never, {
        conceptId: factId(concept.conceptId), targetEdges: edgeIds('targets_concept'),
        asOf: scope.asOf, activity: { complete: gathered?.complete === true && !unwitnessed.has(concept.conceptId), observations },
      });
      const question = history
        ? await read.fact(factId(history.question.id), { mode: 'pinned', rev: history.question.rev })
        : undefined;
      const candidate = await textbookPulseCandidate(tx, access, {
        conceptId: factId(concept.conceptId), read: { fact: read.fact as never, slot },
        releaseUses: ['practice'], targetEdges: edgeIds('targets_concept'),
        variantEdgeIds: edgeIds('variant_of'), archetypeEdgeIds: edgeIds('instance_of'),
        clockWatermark: scope.clockWatermark, asOf: scope.asOf,
      });
      return {
        conceptId: concept.conceptId, state: concept.state,
        ...(history && question ? { anchor: {
          kind: history.kind === 'recent-error' ? 'recent-error' : 'prior-stable', href: questionHref(question),
        } } : {}),
        ...(candidate ? { candidate: { key: JSON.stringify([page.id, concept.conceptId, candidate.id, candidate.rev]) } } : {}),
      };
    })),
  })));
  return { masteryPulse: { asOf: scope.asOf, blocks } };
}
