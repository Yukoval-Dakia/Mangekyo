import { traverseKnowledgeGraph, type Traversed } from '../../modules/content/knowledge-traversal.ts';
import { createAuthorizedFactReader, isFactUnavailable, snapshotFactReaders } from './fact-read-helpers.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { memoWorkbookRead } from '../../modules/activity/workbook-context-read.ts';
import { assetType } from '../../modules/content/asset.ts';
import { sourceReference, type SourceRefV1 } from '../../modules/activity/source-values.ts';
import {
  KnowledgeEdgeBasisError, knowledgeEdgeEvidenceType, knowledgeEdgeType, knowledgeUseKey,
  matchingKnowledgeEdgeEvidence, parseEdgeEvidence, parseKnowledgeEdge, workspaceEntryType,
  type KnowledgeEdge, type KnowledgeEdgeKind,
} from '../../modules/content/knowledge-edge.ts';
import { resolveSource, sourceMaySend, sourcePurpose, type SourceAccess, type SourceTrack } from './source-read.ts';

const whole = { kind: 'whole' } as const;
export type WorkspaceSource = NonNullable<Awaited<ReturnType<typeof resolveSource>>>;
export type GraphQuery = {
  conceptId: string;
  hops: number;
  direction: 'inbound' | 'outbound' | 'both';
  edgeKinds: readonly KnowledgeEdgeKind[];
  conceptsOnly?: boolean;
};

function graphReads(tx: ReadTransaction, access: SourceAccess, scoped?: ReturnType<typeof snapshotFactReaders>) {
  const purpose = sourcePurpose(access), recipient = (fact: FactSnapshot) => sourceMaySend(access,fact);
  const reader = scoped ? scoped(purpose,recipient) : createAuthorizedFactReader(tx,purpose,recipient);
  const source = async (ref: SourceRefV1) => {
    const opened: Parameters<SourceTrack>[] = [];
    return {source:await resolveSource(tx,ref,{...access,track:(...witness)=>opened.push(witness)},'pinned',reader),opened};
  };
  return {reader,source:scoped ? memoWorkbookRead(source) : source};
}

export function scopedKnowledgeEdges(tx: ReadTransaction, access: SourceAccess, facts: ReturnType<typeof snapshotFactReaders>) {
  const reads = graphReads(tx,access,facts);
  return memoWorkbookRead((id: string)=>openKnowledgeEdge(tx,id,access,reads));
}

export async function readKnowledgeSources(tx: ReadTransaction, edge: KnowledgeEdge, access: SourceAccess, reads = graphReads(tx,access)) {
  const sources = new Map<string, WorkspaceSource>();
  const opened: Parameters<SourceTrack>[] = [];
  const external: SourceRefV1[] = [];
  for (const use of edge.sourceUses) {
    const snapshot = await reads.reader.reopen({ ...use, mode: 'pinned' });
    if (access.readNotionWitness && snapshot.type === captureSourceType && sourceEnvelope(snapshot.value).kind === 'notion') {
      const authorized = await access.readNotionWitness(snapshot);
      if (authorized.ref.id !== use.id || authorized.ref.rev !== use.rev || authorized.accessEpoch !== use.accessEpoch)
        throw new KnowledgeEdgeBasisError('Notion 关系依据已变化。');
      opened.push([authorized,'pinned']);
      external.push(sourceReference(authorized,whole));
      continue;
    }
    const resolved = await reads.source(sourceReference(snapshot,whole));
    opened.push(...resolved.opened);
    const {source} = resolved;
    if (!source) throw new KnowledgeEdgeBasisError('来源或其依据当前不可用。');
    sources.set(knowledgeUseKey(use), source);
  }
  const from = sources.get(knowledgeUseKey(edge.from.sourceUse));
  const to = sources.get(knowledgeUseKey(edge.to.sourceUse));
  if (!from || !to || ![workspaceEntryType,assetType].includes(from.sourceRef.fact.type) ||
      ![workspaceEntryType,assetType].includes(to.sourceRef.fact.type) ||
      from.kind !== edge.from.kind || to.kind !== edge.to.kind)
    throw new KnowledgeEdgeBasisError('概念或题目端点类型不符。');
  return {from, to, sources: [...[...sources.values()].map(source => source.sourceRef), ...external], opened};
}

function graphReadUnavailable(error: unknown) {
  return isFactUnavailable(error) || error instanceof KnowledgeEdgeBasisError;
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

export async function openKnowledgeEdge(tx: ReadTransaction, input: string | SourceRefV1, access: SourceAccess, reads = graphReads(tx,access)) {
  if (typeof input !== 'string' && (input.fact.type !== knowledgeEdgeType || input.anchor.kind !== 'whole' || input.textFact)) return;
  const {reader} = reads;
  const id = factId(typeof input === 'string' ? input : input.fact.id);
  try {
    const fact = await reader.fact(id, typeof input === 'string'
      ? { mode: 'following' } : { mode: 'pinned', rev: input.fact.rev as Revision });
    if (fact.type !== knowledgeEdgeType) return;
    let edge;
    try { edge = parseKnowledgeEdge(fact.value); }
    catch { return; }

    const {from,to,sources,opened} = await readKnowledgeSources(tx,edge,access,reads);

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

type OpenedEdgeValue = NonNullable<Awaited<ReturnType<typeof openKnowledgeEdge>>>['value'];
export type EdgeHit = Traversed<OpenedEdgeValue>;

export async function readKnowledgeGraph<Result>(
  tx: ReadTransaction, query: GraphQuery, access: SourceAccess,
  select: (source: WorkspaceSource, fact: FactSnapshot, hop: number) => Result | undefined,
  fits?: (edge: EdgeHit, node: Result) => boolean,
) {
  const rootWitnesses: Parameters<SourceTrack>[] = [];
  const concept = await resolveSource(tx, query.conceptId, { ...access, track: (...witness) => rootWitnesses.push(witness) });
  const root = rootWitnesses.find(([fact]) => fact.ref.id === query.conceptId)?.[0];
  if (concept?.kind !== 'concept' || !root || ![workspaceEntryType,assetType].includes(root.type)) return;
  for (const witness of rootWitnesses) access.track?.(...witness);
  return traverseKnowledgeGraph<WorkspaceSource, OpenedEdgeValue, Parameters<SourceTrack>, Result>(query, concept, root, {
    async candidates(endpoints) {
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
      return rows.map(row => row.id);
    },
    open: id => openKnowledgeEdge(tx,id,access),
    select, ...(fits ? {fits} : {}), track: witness => access.track?.(...witness),
  });
}
