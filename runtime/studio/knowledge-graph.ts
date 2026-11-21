import { createAuthorizedFactReader, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { sourceReference, type SourceRefV1 } from '../../modules/activity/source-values.ts';
import {
  KnowledgeEdgeBasisError, knowledgeEdgeEvidenceType, knowledgeEdgeType, knowledgeUseKey,
  matchingKnowledgeEdgeEvidence, parseEdgeEvidence, parseKnowledgeEdge, workspaceEntryType,
  type KnowledgeEdge, type KnowledgeEdgeKind,
} from '../../modules/content/knowledge-edge.ts';
import {
  resolveSource, sourceMaySend, sourcePurpose, type SourceAccess, type SourceTrack,
} from './source-read.ts';

const whole = { kind: 'whole' } as const;
const graphLimit = 64;
export type WorkspaceSource = NonNullable<Awaited<ReturnType<typeof resolveSource>>>;
export type GraphQuery = {
  conceptId: string;
  hops: number;
  direction: 'inbound' | 'outbound' | 'both';
  edgeKinds: readonly KnowledgeEdgeKind[];
  conceptsOnly?: boolean;
};

function versionKey(id: string, rev: number): string {
  return `${id}:${rev}`;
}

export async function readKnowledgeSources(tx: ReadTransaction, edge: KnowledgeEdge, access: SourceAccess) {
  const reader = createAuthorizedFactReader(tx, sourcePurpose(access), fact => sourceMaySend(access, fact));
  const sources = new Map<string, WorkspaceSource>();
  const opened: Parameters<SourceTrack>[] = [];
  for (const use of edge.sourceUses) {
    const snapshot = await reader.reopen({ ...use, mode: 'pinned' });
    const source = await resolveSource(tx, sourceReference(snapshot, whole), {
      ...access, track: (...witness) => opened.push(witness),
    });
    if (!source) throw new KnowledgeEdgeBasisError('来源或其依据当前不可用。');
    sources.set(knowledgeUseKey(use), source);
  }
  const from = sources.get(knowledgeUseKey(edge.from.sourceUse));
  const to = sources.get(knowledgeUseKey(edge.to.sourceUse));
  if (!from || !to || from.sourceRef.fact.type !== workspaceEntryType || to.sourceRef.fact.type !== workspaceEntryType ||
      from.kind !== edge.from.kind || to.kind !== edge.to.kind)
    throw new KnowledgeEdgeBasisError('概念或题目端点类型不符。');
  return {from, to, sources: [...sources.values()].map(source => source.sourceRef), opened};
}

function graphReadUnavailable(error: unknown) {
  return error instanceof FactNotFoundError || error instanceof FactReadDeniedError || error instanceof KnowledgeEdgeBasisError;
}

export async function openKnowledgeEdgeEvidence(tx: ReadTransaction, input: string | SourceRefV1, access: SourceAccess) {
  if (typeof input !== 'string' &&
      (input.fact.type !== knowledgeEdgeEvidenceType || input.anchor.kind !== 'whole' || input.textFact)) return;
  const id = factId(typeof input === 'string' ? input : input.fact.id);
  const reader = createAuthorizedFactReader(tx, sourcePurpose(access), fact => sourceMaySend(access, fact));
  try {
    const proof = await reader.fact(id, typeof input === 'string'
      ? {mode:'following'} : {mode:'pinned', rev:input.fact.rev as Revision});
    if (proof.type !== knowledgeEdgeEvidenceType) return;
    const {method, edge} = parseEdgeEvidence(proof.value);
    const {from,to,sources,opened} = await readKnowledgeSources(tx,edge,access);
    for (const witness of opened) access.track?.(...witness);
    access.track?.(proof,'pinned');
    return {id, rev:proof.ref.rev, sourceRef:sourceReference(proof,whole), title:'有向边核验证明',
      method, kind:edge.kind, scope:edge.scope, from:from.sourceRef, to:to.sourceRef, sources,
      ...(edge.variant ? {variant:edge.variant} : {})};
  } catch (error) {
    if (graphReadUnavailable(error)) return;
    throw error;
  }
}

export async function openKnowledgeEdge(tx: ReadTransaction, input: string | SourceRefV1, access: SourceAccess) {
  if (typeof input !== 'string' && (input.fact.type !== knowledgeEdgeType || input.anchor.kind !== 'whole' || input.textFact)) return;
  const reader = createAuthorizedFactReader(tx, sourcePurpose(access), fact => sourceMaySend(access, fact));
  const id = factId(typeof input === 'string' ? input : input.fact.id);
  try {
    const fact = await reader.fact(id, typeof input === 'string'
      ? { mode: 'following' } : { mode: 'pinned', rev: input.fact.rev as Revision });
    if (fact.type !== knowledgeEdgeType) return;
    let edge;
    try { edge = parseKnowledgeEdge(fact.value); }
    catch { return; }

    const {from,to,sources,opened} = await readKnowledgeSources(tx,edge,access);

    let verification;
    if (edge.verification) {
      const use = edge.verification;
      const proof = await reader.reopen({ ...use, mode: 'pinned', type: knowledgeEdgeEvidenceType });
      const { verification: _, ...claim } = edge;
      let evidence;
      try { evidence = matchingKnowledgeEdgeEvidence(proof,claim); }
      catch { return; }
      if (!evidence) return;
      verification = { method: evidence.method, sourceRef: sourceReference(proof, whole) };
      opened.push([proof, 'pinned']);
    }
    const { rows: [birth] } = await tx.query<{ author: string }>(
      'SELECT author FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=1', [tx.learner, id],
    );
    opened.push([fact, typeof input === 'string' ? 'following' : 'pinned']);
    return {
      value: {
        id, rev: fact.ref.rev, sourceRef: sourceReference(fact, whole), kind: edge.kind, scope: edge.scope,
        author: birth?.author ?? 'unknown', from: from.sourceRef, to: to.sourceRef,
        sources,
        ...(edge.variant ? { variant: edge.variant } : {}),
        ...(verification ? { verification } : {}),
      },
      from, to, opened,
    };
  } catch (error) {
    if (graphReadUnavailable(error)) return;
    throw error;
  }
}

export type EdgeHit = NonNullable<Awaited<ReturnType<typeof openKnowledgeEdge>>>['value'] & {
  hop: number;
  traversal: 'forward' | 'reverse';
};
type TraversedEdge = { hit: EdgeHit; opened: Parameters<SourceTrack>[] };
type FrontierRecord = { source: WorkspaceSource; path: readonly TraversedEdge[] };

export async function readKnowledgeGraph<Result>(
  tx: ReadTransaction, query: GraphQuery, access: SourceAccess,
  select: (source: WorkspaceSource, fact: FactSnapshot, hop: number) => Result | undefined,
  fits?: (edge: EdgeHit, node: Result) => boolean,
) {
  const rootWitnesses: Parameters<SourceTrack>[] = [];
  const concept = await resolveSource(tx, query.conceptId, { ...access, track: (...witness) => rootWitnesses.push(witness) });
  const root = rootWitnesses.find(([fact]) => fact.ref.id === query.conceptId)?.[0];
  if (concept?.kind !== 'concept' || root?.type !== workspaceEntryType) return;
  for (const witness of rootWitnesses) access.track?.(...witness);
  const edges = new Map<string, EdgeHit>();
  const results: Result[] = [];
  const selected = select(concept, root, 0);
  if (selected !== undefined) results.push(selected);
  const conceptKey = versionKey(root.ref.id, root.ref.rev);
  const visited = new Set([conceptKey]);
  const seenEdges = new Set<string>();
  let frontier = new Map<string, FrontierRecord>([[conceptKey, { source: concept, path: [] }]]);
  const output = (truncated: boolean) => ({
    conceptRef: concept.sourceRef, results, edges: [...edges.values()].sort((left, right) => left.hop - right.hop), truncated,
  });
  for (let hop = 1; hop <= query.hops && frontier.size; hop++) {
    const endpoints = [...frontier.values()].map(record => record.source.sourceRef.fact);
    const { rows } = await tx.query<{ id: string }>(
      `SELECT f.id FROM facts f JOIN fact_revs r
         ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
       WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.kind='value'
         AND f.purpose && ARRAY[$3,'all']::text[] AND r.purpose && ARRAY[$3,'all']::text[]
         AND (cardinality($4::text[])=0 OR r.data->>'kind'=ANY($4))
         AND (NOT $7::boolean OR (r.data#>>'{from,kind}'='concept' AND r.data#>>'{to,kind}'='concept'))
         AND EXISTS (SELECT 1 FROM jsonb_to_recordset($5::jsonb) AS n(id text, rev integer)
           WHERE ($6<>'inbound' AND r.data#>>'{from,sourceUse,id}'=n.id AND r.data#>>'{from,sourceUse,rev}'=n.rev::text)
              OR ($6<>'outbound' AND r.data#>>'{to,sourceUse,id}'=n.id AND r.data#>>'{to,sourceUse,rev}'=n.rev::text))
       ORDER BY f.id`,
      [tx.learner, knowledgeEdgeType, sourcePurpose(access), query.edgeKinds, JSON.stringify(endpoints), query.direction, query.conceptsOnly === true],
    );
    const next = new Map<string, FrontierRecord>();
    for (const { id } of rows) {
      if (seenEdges.has(id)) continue;
      const edge = await openKnowledgeEdge(tx, id, access);
      if (!edge) continue;
      const from = edge.value.from.fact;
      const to = edge.value.to.fact;
      const forward = query.direction === 'inbound' ? undefined : frontier.get(versionKey(from.id, from.rev));
      const origin = forward ?? (query.direction === 'outbound' ? undefined : frontier.get(versionKey(to.id, to.rev)));
      if (!origin) continue;
      const target = forward ? edge.to : edge.from;
      const { id: targetId, rev } = target.sourceRef.fact;
      if (query.conceptsOnly && targetId === root.ref.id) continue;
      const fact = edge.opened.find(([item]) => item.ref.id === targetId && item.ref.rev === rev)?.[0];
      if (!fact) continue;
      if (seenEdges.size === graphLimit) return output(true);
      seenEdges.add(id);
      const path: TraversedEdge[] = [...origin.path, {
        hit: { ...edge.value, hop, traversal: forward ? 'forward' : 'reverse' }, opened: edge.opened,
      }];
      const key = versionKey(targetId, rev);
      const match = select(target, fact, hop);
      if (match !== undefined) {
        if (fits && !fits(path[path.length - 1]!.hit, match)) return output(true);
        for (const step of path) {
          if (edges.has(step.hit.id)) continue;
          edges.set(step.hit.id, step.hit);
          for (const witness of step.opened) access.track?.(...witness);
        }
        if (!visited.has(key)) results.push(match);
      }
      if (!visited.has(key)) {
        visited.add(key);
        next.set(key, { source: target, path });
      }
    }
    frontier = next;
  }
  return output(false);
}
