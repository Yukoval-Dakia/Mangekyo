import type { FactSnapshot } from '@mangekyo/kernel';

type Version = { readonly id: string; readonly rev: number };
type Reference = { readonly fact: Version };
type Node = { readonly sourceRef: Reference };
type EdgeValue = { readonly id: string; readonly from: Reference; readonly to: Reference };
export type Traversed<Value> = Value & { hop: number; traversal: 'forward' | 'reverse' };

type Frontier<Source, Value, Witness> = {
  readonly source: Source;
  readonly path: readonly { hit: Traversed<Value>; opened: readonly Witness[] }[];
};

const versionKey = (id: string, rev: number) => `${id}:${rev}`;
const graphLimit = 64;

/** Walk only authorized edges. Commit the proof of each selected path in order. */
export async function traverseKnowledgeGraph<Source extends Node, Value extends EdgeValue, Witness extends readonly [FactSnapshot, ...unknown[]], Result>(
  query: { hops: number; direction: 'inbound' | 'outbound' | 'both'; conceptsOnly?: boolean },
  concept: Source, root: FactSnapshot,
  {
    candidates, open, select, track, fits,
  }: {
    candidates: (endpoints: readonly Source['sourceRef']['fact'][]) => Promise<readonly string[]>;
    open: (id: string) => Promise<{value: Value; from: Source; to: Source; opened: readonly Witness[]} | undefined>;
    select: (source: Source, fact: FactSnapshot, hop: number) => Result | undefined;
    track: (witness: Witness) => void;
    fits?: (edge: Traversed<Value>, node: Result) => boolean;
  },
) {
  const edges = new Map<string, Traversed<Value>>();
  const results: Result[] = [];
  const selected = select(concept, root, 0);
  if (selected !== undefined) results.push(selected);
  const conceptKey = versionKey(root.ref.id, root.ref.rev);
  const visited = new Set([conceptKey]);
  const seenEdges = new Set<string>();
  let frontier = new Map<string, Frontier<Source, Value, Witness>>([[conceptKey, { source: concept, path: [] }]]);
  const output = (truncated: boolean) => ({
    conceptRef: concept.sourceRef, results, edges: [...edges.values()].sort((left, right) => left.hop - right.hop), truncated,
  });
  for (let hop = 1; hop <= query.hops && frontier.size; hop++) {
    const endpoints = [...frontier.values()].map(record => record.source.sourceRef.fact);

    const ids = await candidates(endpoints);
    const next = new Map<string, Frontier<Source, Value, Witness>>();
    for (const id of ids) {
      if (seenEdges.has(id)) continue;
      const edge = await open(id);
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
      const path: Frontier<Source, Value, Witness>['path'] = [...origin.path, {
        hit: { ...edge.value, hop, traversal: forward ? 'forward' : 'reverse' }, opened: edge.opened,
      }];
      const key = versionKey(targetId, rev);
      const match = select(target, fact, hop);
      if (match !== undefined) {
        if (fits && !fits(path[path.length - 1]!.hit, match)) {
          visited.add(key);
          continue;
        }
        for (const step of path) {
          if (edges.has(step.hit.id)) continue;
          edges.set(step.hit.id, step.hit);
          for (const witness of step.opened) track(witness);
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
