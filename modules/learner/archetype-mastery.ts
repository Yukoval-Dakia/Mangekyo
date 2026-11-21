import type { BusWitness } from '@mangekyo/kernel';
import { evidenceTime } from './memory-evidence.ts';
import {
  isLocalMasteryWitness, masteryWitnessKey, readConceptMastery,
  type TextbookMasteryEvidenceBatch, type TextbookMasteryScope,
  type TextbookMasterySources,
} from './textbook-mastery.ts';
import type { CognitionOutput, PythonRetentionMethod } from './retention.ts';

export type ArchetypeFoldingMember = {
  readonly question: BusWitness;
  readonly anchor?: unknown;
  readonly origin?: 'original' | 'non-paper';
  readonly basis: readonly BusWitness[];
  readonly practice?: { readonly question: BusWitness; readonly anchor?: unknown };
  readonly practiceBasis?: readonly BusWitness[];
};

export type ArchetypeFoldingCluster = {
  readonly kind?: 'archetype';
  readonly archetype: BusWitness;
  readonly title?: string;
  readonly representative?: unknown;
  readonly members: readonly ArchetypeFoldingMember[];
  readonly coveredQuestionCount?: number;
  readonly variationDimensions?: unknown;
};

export type ArchetypeMasteryRequest = TextbookMasteryScope & {
  readonly clusters: readonly ArchetypeFoldingCluster[];
};

export type ArchetypeMasterySources = Omit<TextbookMasterySources, 'readEvidence'> & {
  readEvidence(scope: TextbookMasteryScope, questions: readonly BusWitness[]):
    Promise<TextbookMasteryEvidenceBatch | null>;
};

export type ArchetypeQuestionState = 'steady' | 'due' | 'weak' | 'unknown';

export type ArchetypeQuestionMastery = {
  readonly question: BusWitness;
  readonly state: ArchetypeQuestionState;
};

export type ArchetypeMasteryMember = ArchetypeQuestionMastery;

export type ArchetypeMasteryCluster = {
  readonly archetype: BusWitness;
  readonly title?: string;
  readonly coveredQuestionCount: number;
  readonly counts: { readonly steady: number; readonly due: number; readonly weak: number; readonly unknown: number };
  readonly members: readonly ArchetypeMasteryMember[];
  readonly representative?: ArchetypeMasteryMember;
};

export type ArchetypeMasteryView = {
  readonly asOf: string;
  readonly clusters: readonly ArchetypeMasteryCluster[];
};

type MemberCandidate = {
  readonly question: BusWitness;
  readonly paths: readonly (readonly BusWitness[])[];
  readonly practiceBasis: readonly (readonly BusWitness[])[];
};

type PreparedCluster = {
  readonly archetype: BusWitness;
  readonly title?: string;
  readonly members: readonly MemberCandidate[];
};

const questionStates = { steady: 'steady', decaying: 'due', fragile: 'weak' } as const;
const representativeOrder: Readonly<Record<Exclude<ArchetypeQuestionState, 'steady'>, number>> =
  { weak: 0, due: 1, unknown: 2 };

function fixedQuestionKey(ref: BusWitness) {
  return JSON.stringify([ref.learner, ref.id, ref.rev]);
}

export function archetypeQuestionConceptId(ref: BusWitness) {
  return `archetype-mastery/${ref.id}/${ref.rev}`;
}

function validPath(path: readonly BusWitness[], scope: TextbookMasteryScope) {
  return path.length > 0 && path.every(ref => isLocalMasteryWitness(ref, scope));
}

function prepareCluster(cluster: ArchetypeFoldingCluster, scope: TextbookMasteryScope): PreparedCluster | undefined {
  if (!cluster.title?.trim() || !isLocalMasteryWitness(cluster.archetype, scope)) return;
  const members = new Map<string, MemberCandidate | null>();
  for (const member of cluster.members) {
    const key = fixedQuestionKey(member.question);
    const prior = members.get(key);
    if (prior === null) continue;
    const sameQuestion = !prior || masteryWitnessKey(member.question) === masteryWitnessKey(prior.question);
    const paths = [...(prior?.paths ?? []), member.basis].filter(path => validPath(path, scope));
    const practiceBasis = [...(prior?.practiceBasis ?? []), ...(member.practiceBasis ? [member.practiceBasis] : [])]
      .filter(path => validPath(path, scope));
    if (member.question.mode !== 'pinned' || !sameQuestion || !paths.length) members.set(key, null);
    else members.set(key, { question: member.question, paths, practiceBasis });
  }
  const authorized = [...members.values()].filter((member): member is MemberCandidate => member !== null);
  return authorized.length ? { archetype: cluster.archetype, title: cluster.title, members: authorized } : undefined;
}

function anchorWitnesses(batch: TextbookMasteryEvidenceBatch, questions: ReadonlyMap<string, BusWitness>,
  scope: TextbookMasteryScope) {
  return batch.anchors.flatMap(anchor => {
    const question = questions.get(fixedQuestionKey(anchor.question));
    if (!question || masteryWitnessKey(anchor.question) !== masteryWitnessKey(question) ||
        ![anchor.submission, anchor.question, ...anchor.basis].every(ref => isLocalMasteryWitness(ref, scope))) return [];
    return [anchor.submission, anchor.question, ...anchor.basis];
  });
}

function clusterWitnesses(cluster: PreparedCluster) {
  return [
    cluster.archetype,
    ...cluster.members.flatMap(member => [
      member.question,
      ...member.paths.flat(),
      ...member.practiceBasis.flat(),
    ]),
  ];
}

function stateOrder(left: ArchetypeMasteryMember, right: ArchetypeMasteryMember) {
  return (representativeOrder[left.state as Exclude<ArchetypeQuestionState, 'steady'>] ?? 3) -
    (representativeOrder[right.state as Exclude<ArchetypeQuestionState, 'steady'>] ?? 3) ||
    fixedQuestionKey(left.question).localeCompare(fixedQuestionKey(right.question));
}

function eligiblePractice(member: MemberCandidate, allowed: (ref: BusWitness) => boolean) {
  return member.practiceBasis.some(basis => basis.length > 0 && basis.every(allowed));
}

function projectCluster(cluster: PreparedCluster, states: ReadonlyMap<string, ArchetypeQuestionState>,
  allowed: (ref: BusWitness) => boolean): ArchetypeMasteryCluster | undefined {
  if (!allowed(cluster.archetype)) return;
  const candidates = new Map(cluster.members.map(member => [fixedQuestionKey(member.question), member] as const));
  const members = cluster.members.flatMap(member => {
    if (!member.paths.some(path => path.every(allowed)) || !allowed(member.question)) return [];
    const state = states.get(fixedQuestionKey(member.question)) ?? 'unknown';
    return [{ question: member.question, state }];
  });
  if (!members.length) return;
  const counts = { steady: 0, due: 0, weak: 0, unknown: 0 };
  for (const member of members) counts[member.state] += 1;
  const representative = members
    .filter(member => member.state !== 'steady' && eligiblePractice(candidates.get(fixedQuestionKey(member.question))!, allowed))
    .sort(stateOrder)[0];
  return {
    archetype: cluster.archetype,
    ...(cluster.title ? { title: cluster.title } : {}),
    coveredQuestionCount: members.length,
    counts,
    members,
    ...(representative ? { representative } : {}),
  };
}

export async function projectArchetypeMastery(request: ArchetypeMasteryRequest,
  sources: ArchetypeMasterySources): Promise<ArchetypeMasteryView> {
  const { clusters, ...scope } = request;
  if (!Number.isFinite(evidenceTime(scope.asOf)) || !scope.purpose.trim() || !scope.recipientId.trim() ||
      !/^(0|[1-9][0-9]*)$/.test(scope.clockWatermark)) return { asOf: scope.asOf, clusters: [] };

  const prepared = clusters.map(cluster => prepareCluster(cluster, scope)).filter((cluster): cluster is PreparedCluster =>
    cluster !== undefined);
  const questions = new Map(prepared.flatMap(cluster => cluster.members.map(member =>
    [fixedQuestionKey(member.question), member.question] as const)));
  const evidence = questions.size ? await sources.readEvidence(scope, [...questions.values()]) : null;
  if (questions.size && !evidence) return { asOf: scope.asOf, clusters: [] };
  const byConcept = new Map([...questions.values()].map(question =>
    [archetypeQuestionConceptId(question), question] as const));
  const textbookSources: TextbookMasterySources = {
    ...(sources.methodVersion ? { methodVersion: sources.methodVersion } : {}),
    readEvidence: async (_scope, conceptIds) => {
      const requested = conceptIds.map(concept => byConcept.get(concept));
      return requested.length === questions.size && requested.every(question => question !== undefined) &&
        requested.every(question => questions.get(fixedQuestionKey(question!)) === question) ? evidence : null;
    },
    derive: (_scope: TextbookMasteryScope, method: PythonRetentionMethod, slice: Parameters<ArchetypeMasterySources['derive']>[2],
      witnesses: readonly BusWitness[]) => sources.derive(_scope, method, slice, witnesses),
    reopen: sources.reopen,
  };
  const displayWitnesses = [
    ...prepared.flatMap(clusterWitnesses),
    ...(evidence ? anchorWitnesses(evidence, questions, scope) : []),
  ];
  const { allowed, concept } = await readConceptMastery(scope, new Set(byConcept.keys()), displayWitnesses, textbookSources);
  const states = new Map([...questions].map(([key, question]) => {
    const mastery = concept(archetypeQuestionConceptId(question));
    const state = mastery.state in questionStates ? questionStates[mastery.state as keyof typeof questionStates] : 'unknown';
    return [key, state] as const;
  }));
  return { asOf: scope.asOf, clusters: prepared.flatMap(cluster => {
    const projected = projectCluster(cluster, states, allowed);
    return projected ? [projected] : [];
  }) };
}
