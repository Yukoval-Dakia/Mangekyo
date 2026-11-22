import type { BusWitness, FactId, ReadContext, Revision } from '@mangekyo/kernel';
import { activityEvidenceSlice } from './evidence-slice.ts';
import { readConceptAttemptEvidence, type ConceptEvidenceRow } from './concept-evidence.ts';
import type { KnowledgeGraphMastery } from '@mangekyo/module-content/facts/knowledge-graph-overview';
import { posttestSubmissionType } from './retention-posttest.ts';
import { projectGraphConceptMastery, type GraphConceptMasteryView } from '@mangekyo/module-learner/facts/graph-mastery';
import type { CognitionOutput, PythonRetentionMethod } from '@mangekyo/module-learner/facts/retention';
import type { TextbookMasteryScope, TextbookMasterySources } from '@mangekyo/module-learner/facts/textbook-mastery';

type EvidenceRead = Pick<ReadContext, 'fact'>;
type PythonHost = { derive(deriver: string, payload: unknown): Promise<unknown> };

export type GraphMasteryEvidenceInput = {
  readonly tx: Parameters<typeof readConceptAttemptEvidence>[0];
  readonly links: Parameters<typeof readConceptAttemptEvidence>[2];
  readonly read: EvidenceRead;
  readonly python: PythonHost;
  readonly reopen: (refs: readonly BusWitness[]) => Promise<readonly BusWitness[]>;
  readonly isUnavailable: (error: unknown) => boolean;
};

const href = (question: FactId) => `/materials/records/${question}?ref=${encodeURIComponent(JSON.stringify({
  v: 1, fact: {id: question, type: 'content.asset'}, anchor: {kind: 'question', itemId: 'question'},
}))}`;

async function pinnedWitness(read: EvidenceRead, ref: {id: FactId; rev: Revision}, mode: BusWitness['mode']) {
  const fact = await read.fact(ref.id, {mode: 'pinned', rev: ref.rev});
  return {...fact.ref, type: fact.type, accessEpoch: fact.accessEpoch, mode} satisfies BusWitness;
}

async function anchorFor(read: EvidenceRead, attempt: ConceptEvidenceRow) {
  const submission = await pinnedWitness(read, attempt.submission, 'following');
  const question = await pinnedWitness(read, {id: attempt.questionId, rev: attempt.questionRev}, 'pinned');
  const basis: BusWitness[] = [];
  for (const ref of attempt.basisRefs) basis.push(await pinnedWitness(read, ref, 'pinned'));
  return {
    submission, question, itemId: attempt.questionId, href: href(attempt.questionId),
    recordedAt: attempt.recordedTick, basis: [...basis, question],
  };
}

export function graphMasterySources(input: GraphMasteryEvidenceInput): TextbookMasterySources {
  return {
    methodVersion: 'cognition@3',
    async readEvidence(scope: TextbookMasteryScope, conceptIds: readonly string[]) {
      const requested = new Set(conceptIds);
      const links = input.links.filter(link => requested.has(link.conceptId));
      const {attempts, incompleteConceptIds} = await readConceptAttemptEvidence(
        input.tx, input.read as never, links, input.isUnavailable);
      const grouped = new Map<string, {attempt: ConceptEvidenceRow; concepts: string[]}>();
      for (const attempt of attempts) {
        const key = `${attempt.submission.id}:${attempt.questionId}`;
        const row = grouped.get(key) ?? {attempt, concepts: []};
        if (!row.concepts.includes(attempt.conceptId)) row.concepts.push(attempt.conceptId);
        grouped.set(key, row);
      }
      const rows = [...grouped.values()];
      const anchors: Awaited<ReturnType<typeof anchorFor>>[] = [];
      for (const row of rows) anchors.push(await anchorFor(input.read, row.attempt));
      const incomplete = new Set(incompleteConceptIds);
      for (const row of rows) if (row.attempt.exposure === 'unknown') row.concepts.forEach(id => incomplete.add(id));
      const observations = rows.map(row => ({
        submission: row.attempt.submission, occurredAt: row.attempt.occurredAt, concepts: row.concepts,
        novelty: 'same' as const, helpLevel: row.attempt.exposure === 'independent' ? 'independent' as const : 'unknown' as const,
        result: row.attempt.outcome,
      }));
      return {
        slice: activityEvidenceSlice(scope.clockWatermark, scope.asOf, undefined, observations),
        anchors,
        completeConceptIds: conceptIds.filter(id => !incomplete.has(id)),
      };
    },
    async derive(_scope: TextbookMasteryScope, method: PythonRetentionMethod, payload: unknown, refs: readonly BusWitness[]) {
      if ((await input.reopen(refs)).length !== refs.length) return null;
      const result = await input.python.derive(method.deriver, payload) as
        {kind: 'ok'; outcome: {kind: 'value'; value: unknown}} | {kind: 'ok'; outcome: {kind: 'error'}} | {kind: 'failed'};
      return result.kind === 'ok' && result.outcome.kind === 'value' ? result.outcome.value as CognitionOutput : null;
    },
    reopen: (_scope, refs) => input.reopen(refs),
  };
}

export async function projectGraphMastery(input: GraphMasteryEvidenceInput & {
  readonly scope: Omit<Parameters<typeof projectGraphConceptMastery>[0], 'concepts'>;
  readonly concepts: readonly FactId[];
  readonly activeMisconceptionConceptIds?: ReadonlySet<string>;
}) {
  const {attempts} = await readConceptAttemptEvidence(input.tx, input.read as never, input.links, input.isUnavailable);
  const view = await projectGraphConceptMastery({...input.scope, concepts: input.concepts.map(conceptId => ({conceptId}))},
    graphMasterySources(input));
  return {view, mastery: mapGraphConceptMastery(view, attempts, input.activeMisconceptionConceptIds)};
}

export function mapGraphConceptMastery(
  view: GraphConceptMasteryView, attempts: readonly ConceptEvidenceRow[], activeMisconceptionConceptIds?: ReadonlySet<string>,
) {
  const types = new Map(attempts.map(attempt => [`${attempt.submission.id}:${attempt.submission.rev}`, attempt.submission.type]));
  const statuses = {solid: 'steady', fading: 'fading', weak: 'fragile'} as const;
  return new Map<FactId, KnowledgeGraphMastery>(view.concepts.map(node => [node.conceptId as FactId, {
    status: node.status === 'unknown' ? 'unknown' as const
      : activeMisconceptionConceptIds?.has(node.conceptId) ? 'fragile' as const : statuses[node.status],
    retrievability: node.retrievability,
    independentCount: node.independentAttempts,
    basisRefs: node.recentEvidenceRefs.map(ref => ({
      id: ref.id, rev: ref.rev, type: types.get(`${ref.id}:${ref.rev}`) ?? posttestSubmissionType,
    })),
    ...(node.status === 'unknown' ? {reason: 'no-independent-evidence' as const} : {}),
  }]));
}
