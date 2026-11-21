import type { BusWitness, Hypothesis } from '@mangekyo/kernel';
import { beliefsAsOf } from './belief-view.ts';
import { evidenceTime, witnessIdentity, type Witness } from './memory-evidence.ts';
import {
  isLocalMasteryWitness, masteryWitnessKey, readConceptMastery,
  type TextbookMasteryScope, type TextbookMasterySources,
} from './textbook-mastery.ts';

export type PrerequisiteRadarRequest = TextbookMasteryScope & {
  readonly concepts: readonly BusWitness[];
};

type PrerequisiteRelation = {
  readonly root: BusWitness;
  readonly prerequisite: BusWitness;
  readonly edge: BusWitness;
  readonly basis: readonly BusWitness[];
};

type Misconception = {
  readonly ref: BusWitness;
  readonly concept: BusWitness;
  readonly value: Hypothesis<unknown, Witness>;
  readonly basis: readonly BusWitness[];
};

export type PrerequisiteRadarSources = TextbookMasterySources & {
  // Bind the question or block at the host and use Content's authorized inbound
  // prereq_of reader. Each proof includes its own source and locating edge.
  readPrerequisites(scope: TextbookMasteryScope, concepts: readonly BusWitness[]):
    Promise<readonly PrerequisiteRelation[] | undefined>;
  // Read the owner-projected status and its full concept-link and lifecycle
  // evidence in the same scope. An unavailable hypothesis contributes nothing.
  readMisconceptions(scope: TextbookMasteryScope, concepts: readonly BusWitness[]):
    Promise<readonly Misconception[]>;
};

export type PrerequisiteRadarChip = {
  readonly concept: BusWitness;
  readonly state: 'fading' | 'fragile';
  // Server-side join keys for the authorized Content rows. Recompute on open.
  readonly relations: readonly Pick<PrerequisiteRelation, 'root' | 'edge'>[];
};

const conceptWitness = (ref: BusWitness) => ref.mode === 'following' &&
  (ref.type === 'content.asset' || ref.type === 'activity.workspaceEntry');
const relationWitnesses = ({ root, prerequisite, edge, basis }: PrerequisiteRelation) => [root, prerequisite, edge, ...basis];
const hypothesisWitnesses = ({ ref, concept, basis }: Misconception) => [ref, concept, ...basis];

export async function projectPrerequisiteRadar(request: PrerequisiteRadarRequest, sources: PrerequisiteRadarSources):
Promise<readonly PrerequisiteRadarChip[]> {
  const { concepts, ...scope } = request;
  const now = evidenceTime(scope.asOf);
  if (!Number.isFinite(now) || !scope.recipientId.trim() || !scope.purpose.trim()) return [];
  const local = (ref: BusWitness) => isLocalMasteryWitness(ref, scope);
  const roots = new Map(concepts.filter(ref => conceptWitness(ref) && local(ref)).map(ref => [masteryWitnessKey(ref), ref]));
  if (!roots.size) return [];

  const found = await sources.readPrerequisites(scope, [...roots.values()]);
  const relations = (found ?? []).filter(rel => roots.has(masteryWitnessKey(rel.root))
    && rel.root.id !== rel.prerequisite.id && conceptWitness(rel.prerequisite)
    && rel.edge.type === 'content.knowledgeEdge' && rel.edge.mode === 'following'
    && rel.basis.length > 0 && relationWitnesses(rel).every(local));
  if (!relations.length) return [];
  const candidates = new Map(relations.map(rel => [masteryWitnessKey(rel.prerequisite), rel.prerequisite]));
  const at = new Date(now).toISOString();
  const misconceptions = (await sources.readMisconceptions(scope, [...candidates.values()])).filter(row => {
    const { ref, concept, value, basis } = row;
    if (!candidates.has(masteryWitnessKey(concept)) || ref.type !== 'companion.memoryAssertion' ||
      ref.mode !== 'following' || value.category !== 'hypothesis' || value.kind !== 'misconception' ||
      (value.status !== 'supported' && value.status !== 'relapsed') || !hypothesisWitnesses(row).every(local) ||
      !value.evidence_refs.length) return false;
    const openedBasis = new Set(basis.map(witnessIdentity));
    return value.evidence_refs.every(ref => openedBasis.has(witnessIdentity(ref))) &&
      beliefsAsOf([value], { validAt: at, knownAt: at }).length > 0;
  });
  const { allowed, concept } = await readConceptMastery(scope, new Set([...candidates.values()].map(ref => ref.id)),
    [...relations.flatMap(relationWitnesses), ...misconceptions.flatMap(hypothesisWitnesses)], sources);
  const active = new Set(misconceptions.filter(row => hypothesisWitnesses(row).every(allowed))
    .map(row => masteryWitnessKey(row.concept)));

  const chips = new Map<string, Omit<PrerequisiteRadarChip, 'relations'> & {
    relations: Pick<PrerequisiteRelation, 'root' | 'edge'>[];
  }>();
  for (const rel of relations) {
    if (!relationWitnesses(rel).every(allowed)) continue;
    const { prerequisite, root, edge } = rel;
    const mastery = concept(prerequisite.id);
    if (mastery.state === 'unknown') continue;
    const fragile = mastery.state === 'fragile' || active.has(masteryWitnessKey(prerequisite));
    if (!fragile && mastery.state !== 'decaying') continue;
    const existing = chips.get(prerequisite.id);
    if (existing) existing.relations.push({ root, edge });
    else chips.set(prerequisite.id, { concept: prerequisite, state: fragile ? 'fragile' : 'fading', relations: [{ root, edge }] });
  }
  return [...chips.values()].sort((a, b) => (a.state === b.state ? 0 : a.state === 'fragile' ? -1 : 1)
    || a.concept.id.localeCompare(b.concept.id)).slice(0, 2);
}
