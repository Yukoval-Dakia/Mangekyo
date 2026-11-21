import type { BusWitness, EvidenceEventV1 } from '@mangekyo/kernel';
import { evidenceTime } from './memory-evidence.ts';
import {
  isLocalMasteryWitness, masteryWitnessKey, readConceptMastery,
  type TextbookMasteryEvidenceBatch, type TextbookMasteryScope,
  type TextbookMasterySources,
} from './textbook-mastery.ts';
import { defaultRetentionMethod, readPythonRetentionMethod, type PythonRetentionMethod } from './retention.ts';

export type ArchetypeFoldingMemberProof =
  | { readonly membership: BusWitness; readonly basis: readonly BusWitness[] }
  | { readonly memberships: readonly BusWitness[]; readonly basis: readonly BusWitness[] };

export type ArchetypeFoldingMember = {
  readonly question: BusWitness;
  readonly anchor?: unknown;
  readonly origin?: 'original' | 'non-paper';
  readonly basis?: readonly BusWitness[];
  readonly proof?: ArchetypeFoldingMemberProof;
  readonly practice?: unknown;
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

type PracticePath = {
  readonly paths: readonly (readonly BusWitness[])[];
  readonly basis: readonly BusWitness[];
};

type MemberCandidate = {
  readonly question: BusWitness;
  readonly paths: readonly (readonly BusWitness[])[];
  readonly practicePaths: readonly PracticePath[];
};

type PreparedCluster = {
  readonly archetype: BusWitness;
  readonly title?: string;
  readonly members: readonly MemberCandidate[];
  readonly conflictedKeys: readonly string[];
};

const questionStates = { steady: 'steady', decaying: 'due', fragile: 'weak' } as const;
const representativeOrder: Readonly<Record<Exclude<ArchetypeQuestionState, 'steady'>, number>> =
  { weak: 0, due: 1, unknown: 2 };

function fixedQuestionKey(ref: BusWitness) {
  return JSON.stringify([ref.learner, ref.id, ref.rev]);
}

export function archetypeQuestionConceptId(ref: BusWitness) {
  return `archetype-mastery/${encodeURIComponent(ref.id)}/${ref.rev}`;
}

function validPath(path: readonly BusWitness[], scope: TextbookMasteryScope) {
  return path.length > 0 && path.every(ref => isLocalMasteryWitness(ref, scope));
}

function memberPaths(member: ArchetypeFoldingMember) {
  const paths: BusWitness[][] = member.basis ? [[...member.basis]] : [];
  if (member.proof) {
    if ('membership' in member.proof) paths.unshift([member.proof.membership, ...member.proof.basis]);
    else if (member.proof.memberships.length) paths.unshift([...member.proof.memberships, ...member.proof.basis]);
  }
  return paths;
}

function prepareCluster(cluster: ArchetypeFoldingCluster, scope: TextbookMasteryScope): PreparedCluster | undefined {
  if (!isLocalMasteryWitness(cluster.archetype, scope)) return;
  const title = cluster.title?.trim() || undefined;
  const members = new Map<string, MemberCandidate | null>();
  const conflictedKeys = new Set<string>();
  for (const member of cluster.members) {
    const key = fixedQuestionKey(member.question);
    const prior = members.get(key);
    if (prior === null) continue;
    if (member.question.mode !== 'pinned' || !isLocalMasteryWitness(member.question, scope)) {
      members.set(key, null);
      continue;
    }
    if (prior && masteryWitnessKey(member.question) !== masteryWitnessKey(prior.question)) {
      members.set(key, null);
      conflictedKeys.add(key);
      continue;
    }
    const currentPaths = memberPaths(member).filter(path => validPath(path, scope));
    const paths = [...(prior?.paths ?? []), ...currentPaths];
    const practicePaths = currentPaths.length && member.practiceBasis && validPath(member.practiceBasis, scope)
      ? [...(prior?.practicePaths ?? []), { paths: currentPaths, basis: member.practiceBasis }]
      : (prior?.practicePaths ?? []);
    members.set(key, { question: member.question, paths, practicePaths });
  }
  const authorized = [...members.values()].filter((member): member is MemberCandidate =>
    member !== null && member.paths.length > 0);
  return authorized.length || conflictedKeys.size
    ? { archetype: cluster.archetype, ...(title === undefined ? {} : { title }),
        members: authorized, conflictedKeys: [...conflictedKeys] }
    : undefined;
}

type BoundEvidence = {
  readonly batch: TextbookMasteryEvidenceBatch;
  readonly safeConcepts: ReadonlySet<string>;
};

function evidenceQuestionKey(ref: BusWitness) {
  return JSON.stringify([ref.learner, ref.id, ref.rev, ref.accessEpoch]);
}

function bindEvidence(batch: TextbookMasteryEvidenceBatch, questions: ReadonlyMap<string, BusWitness>,
  scope: TextbookMasteryScope): BoundEvidence {
  const cutoff = Date.parse(scope.asOf);
  const byConcept = new Map([...questions.values()].map(question =>
    [archetypeQuestionConceptId(question), question] as const));
  const byFixedQuestion = new Map([...questions.values()].map(question =>
    [evidenceQuestionKey(question), archetypeQuestionConceptId(question)] as const));
  const anchorsByEvent = new Map<string, TextbookMasteryEvidenceBatch['anchors'][number][]>();
  for (const anchor of batch.anchors) {
    const key = JSON.stringify([anchor.submission.id, anchor.submission.rev]);
    anchorsByEvent.set(key, [...(anchorsByEvent.get(key) ?? []), anchor]);
  }
  const seenEvents = new Map<string, EvidenceEventV1>();
  const conflictingEvents = new Set<string>();
  for (const event of batch.slice.events) {
    const key = JSON.stringify([event.ref, event.rev]);
    const prior = seenEvents.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) conflictingEvents.add(key);
    else seenEvents.set(key, event);
  }
  const omitted = new Set(batch.slice.omissions?.map(({ ref }) => JSON.stringify([ref.id, ref.rev])));

  const unsafe = new Set<string>();
  const boundEvents: { readonly key: string; readonly event: EvidenceEventV1; readonly conceptIds: readonly string[];
    readonly anchor: TextbookMasteryEvidenceBatch['anchors'][number] }[] = [];
  for (const event of batch.slice.events) {
    const key = JSON.stringify([event.ref, event.rev]);
    const eventAnchors = anchorsByEvent.get(key) ?? [];
    const anchor = eventAnchors.length === 1 && !conflictingEvents.has(key) ? eventAnchors[0] : undefined;
    const eventConcepts = new Set(event.concept_ids);
    if (Date.parse(event.occurred_at) <= cutoff &&
        (omitted.has(key) || (event.help_level === 'independent' && !event.exam_pacing && !event.exam_pacing_item))) {
      for (const candidate of eventAnchors) {
        const anchoredConcept = byFixedQuestion.get(evidenceQuestionKey(candidate.question));
        if (anchoredConcept && (!anchor || !eventConcepts.has(anchoredConcept))) unsafe.add(anchoredConcept);
      }
    }
    const conceptIds: string[] = [];
    for (const concept of eventConcepts) {
      if (!byConcept.has(concept)) continue;
      if (!anchor || evidenceQuestionKey(anchor.question) !== evidenceQuestionKey(byConcept.get(concept)!) ||
          ![anchor.submission, anchor.question, ...anchor.basis].every(ref => isLocalMasteryWitness(ref, scope))) {
        unsafe.add(concept);
        continue;
      }
      conceptIds.push(concept);
    }
    if (conceptIds.length && anchor) boundEvents.push({ key, event, conceptIds, anchor });
  }

  const safeConcepts = new Set([...byConcept.keys()].filter(concept => !unsafe.has(concept)));
  const retainedAnchors = new Map<string, TextbookMasteryEvidenceBatch['anchors'][number]>();
  const events = boundEvents.flatMap(({ key, event, conceptIds, anchor }) => {
    const kept = conceptIds.filter(concept => safeConcepts.has(concept));
    if (kept.length) {
      retainedAnchors.set(key, anchor);
      return [{ ...event, concept_ids: kept } as EvidenceEventV1];
    }
    return omitted.has(key) ? [{ ...event, concept_ids: conceptIds } as EvidenceEventV1] : [];
  });
  return {
    batch: {
      ...batch,
      slice: { ...batch.slice, events },
      anchors: [...retainedAnchors.values()],
      ...(batch.completeConceptIds === undefined
        ? {}
        : { completeConceptIds: batch.completeConceptIds.filter(concept => safeConcepts.has(concept)) }),
    },
    safeConcepts,
  };
}

function clusterWitnesses(cluster: PreparedCluster) {
  return [
    cluster.archetype,
    ...cluster.members.flatMap(member => [
      member.question,
      ...member.paths.flat(),
      ...member.practicePaths.flatMap(({ basis }) => basis),
    ]),
  ];
}

function stateOrder(left: ArchetypeMasteryMember, right: ArchetypeMasteryMember) {
  return (representativeOrder[left.state as Exclude<ArchetypeQuestionState, 'steady'>] ?? 3) -
    (representativeOrder[right.state as Exclude<ArchetypeQuestionState, 'steady'>] ?? 3) ||
    fixedQuestionKey(left.question).localeCompare(fixedQuestionKey(right.question));
}

function eligiblePractice(member: MemberCandidate, allowed: (ref: BusWitness) => boolean) {
  return member.practicePaths.some(({ paths, basis }) =>
    paths.some(path => path.every(allowed)) && basis.length > 0 && basis.every(allowed));
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
  const candidates = prepared.flatMap(cluster => cluster.members);
  const firstByKey = new Map<string, BusWitness>();
  const conflicted = new Set(prepared.flatMap(cluster => cluster.conflictedKeys));
  for (const member of candidates) {
    const key = fixedQuestionKey(member.question);
    const prior = firstByKey.get(key);
    if (!prior) firstByKey.set(key, member.question);
    else if (masteryWitnessKey(prior) !== masteryWitnessKey(member.question)) conflicted.add(key);
  }
  const acceptedClusters = prepared.flatMap(cluster => {
    const members = cluster.members.filter(member => !conflicted.has(fixedQuestionKey(member.question)));
    return members.length ? [{ archetype: cluster.archetype, ...(cluster.title === undefined ? {} : { title: cluster.title }),
      members, conflictedKeys: [] }] : [];
  });
  const questions = new Map(acceptedClusters.flatMap(cluster => cluster.members.map(member =>
    [fixedQuestionKey(member.question), member.question] as const)));
  if (!questions.size) return { asOf: scope.asOf, clusters: [] };
  if (readPythonRetentionMethod(sources.methodVersion ?? defaultRetentionMethod)) {
    sources.prepareEvidence?.(scope, [...questions.values()].map(archetypeQuestionConceptId));
  }
  const evidence = await sources.readEvidence(scope, [...questions.values()]);
  if (!evidence) return { asOf: scope.asOf, clusters: [] };
  const bound = bindEvidence(evidence, questions, scope);
  const safeQuestions = [...questions.values()].filter(question =>
    bound.safeConcepts.has(archetypeQuestionConceptId(question)));
  const byConcept = new Map(safeQuestions.map(question =>
    [archetypeQuestionConceptId(question), question] as const));
  const textbookSources: TextbookMasterySources = {
    ...(sources.methodVersion ? { methodVersion: sources.methodVersion } : {}),
    readEvidence: async (_scope, conceptIds) => {
      const requested = conceptIds.map(concept => byConcept.get(concept));
      return requested.length === byConcept.size && requested.every(question => question !== undefined) &&
        requested.every(question => safeQuestions.includes(question!)) ? bound.batch : null;
    },
    derive: (_scope: TextbookMasteryScope, method: PythonRetentionMethod, slice: Parameters<ArchetypeMasterySources['derive']>[2],
      witnesses: readonly BusWitness[]) => sources.derive(_scope, method, slice, witnesses),
    reopen: sources.reopen,
  };
  const displayWitnesses = acceptedClusters.flatMap(clusterWitnesses);
  const { allowed, concept } = await readConceptMastery(scope, new Set(byConcept.keys()), displayWitnesses, textbookSources);
  const masteryStates = new Map(safeQuestions.map(question => {
    const mastery = concept(archetypeQuestionConceptId(question));
    const state = mastery.state in questionStates ? questionStates[mastery.state as keyof typeof questionStates] : 'unknown';
    return [fixedQuestionKey(question), state] as const;
  }));
  const states = new Map(acceptedClusters.flatMap(cluster => cluster.members.map(member =>
    [fixedQuestionKey(member.question), masteryStates.get(fixedQuestionKey(member.question)) ?? 'unknown'] as const)));
  return { asOf: scope.asOf, clusters: acceptedClusters.flatMap(cluster => {
    const projected = projectCluster(cluster, states, allowed);
    return projected ? [projected] : [];
  }) };
}
