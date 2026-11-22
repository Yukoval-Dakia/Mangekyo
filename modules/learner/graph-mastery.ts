import type { BusWitness, FactId, Revision } from '@mangekyo/kernel';
import { evidenceTime } from './memory-evidence.ts';
import {
  isLocalMasteryWitness, readConceptMastery, type TextbookMasteryScope, type TextbookMasterySources,
} from './textbook-mastery.ts';

export type GraphConceptNodeInput = {
  readonly conceptId: string;
  readonly witness?: BusWitness;
  readonly basis?: readonly BusWitness[];
  /** Direct compatibility with Content's KnowledgeGraphNode.proof witnesses. */
  readonly proof?: readonly BusWitness[];
};

export type GraphConceptMasteryRequest = TextbookMasteryScope & {
  readonly concepts: readonly GraphConceptNodeInput[];
};

export type GraphConceptMasterySources = TextbookMasterySources;

export type GraphConceptEvidenceRef = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly occurredAt: string;
  readonly itemId: string;
  readonly href: string;
};

export type GraphConceptMasteryNode = {
  readonly conceptId: string;
  readonly status: 'solid' | 'fading' | 'weak' | 'unknown';
  readonly retrievability: number | null;
  readonly independentAttempts: number;
  readonly lastEvidenceAt: string | null;
  readonly recentEvidenceRefs: readonly GraphConceptEvidenceRef[];
};

export type GraphConceptMasteryView = {
  readonly asOf: string;
  readonly concepts: readonly GraphConceptMasteryNode[];
};

const decimalTick = /^(0|[1-9][0-9]*)$/u;
const statusByState = { steady: 'solid', decaying: 'fading', fragile: 'weak' } as const;

const emptyNode = (conceptId: string): GraphConceptMasteryNode => ({
  conceptId, status: 'unknown', retrievability: null, independentAttempts: 0, lastEvidenceAt: null, recentEvidenceRefs: [],
});

/** Batch-decorates knowledge graph concept nodes with authorized read-time mastery. */
export async function projectGraphConceptMastery(
  request: GraphConceptMasteryRequest,
  sources: GraphConceptMasterySources,
): Promise<GraphConceptMasteryView> {
  const { concepts: input, ...scope } = request;
  const nodes = new Map<string, BusWitness[]>();
  for (const node of input) {
    if (typeof node.conceptId !== 'string' || !node.conceptId.trim() || node.conceptId.includes('\0')) continue;
    const witnesses = [node.witness, ...(node.basis ?? []), ...(node.proof ?? [])].filter(Boolean) as BusWitness[];
    if (witnesses.length) nodes.set(node.conceptId, [...(nodes.get(node.conceptId) ?? []), ...witnesses]);
    else if (!nodes.has(node.conceptId)) nodes.set(node.conceptId, []);
  }
  const ids = [...nodes.keys()];
  const empty = { asOf: scope.asOf, concepts: ids.map(emptyNode) };
  if (!ids.length || !scope.purpose.trim() || !scope.recipientId.trim() ||
      !Number.isFinite(evidenceTime(scope.asOf)) || !decimalTick.test(scope.clockWatermark)) return empty;

  const localNodes = new Map([...nodes].map(([conceptId, witnesses]) =>
    [conceptId, witnesses.every(ref => isLocalMasteryWitness(ref, scope)) ? witnesses : null] as const));
  const validIds = ids.filter(conceptId => localNodes.get(conceptId) !== null);
  if (!validIds.length) return empty;
  const validSet = new Set(validIds);
  const displayWitnesses = validIds.flatMap(conceptId => localNodes.get(conceptId) ?? []);
  const read = await readConceptMastery(scope, validSet, displayWitnesses, sources);
  return { asOf: scope.asOf, concepts: ids.map(conceptId => {
    const witnesses = localNodes.get(conceptId);
    if (!witnesses?.every(read.allowed)) return emptyNode(conceptId);
    const projection = read.concept(conceptId);
    const detail = read.detail(conceptId);
    if (projection.state === 'unknown' || !detail) return emptyNode(conceptId);
    const attempts = [...detail.attempts].sort((left, right) =>
      evidenceTime(right.event.occurred_at) - evidenceTime(left.event.occurred_at) ||
      left.event.ref.localeCompare(right.event.ref));
    return {
      conceptId, status: statusByState[projection.state], retrievability: detail.retrievability,
      independentAttempts: attempts.length,
      lastEvidenceAt: attempts[0]?.event.occurred_at ?? null,
      recentEvidenceRefs: attempts.slice(0, 3).map(({ event, anchor }) => ({
        id: anchor.submission.id, rev: anchor.submission.rev, occurredAt: event.occurred_at,
        itemId: anchor.itemId, href: anchor.href,
      })),
    };
  }) };
}
