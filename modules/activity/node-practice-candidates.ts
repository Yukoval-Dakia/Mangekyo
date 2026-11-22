import type { FactId } from '@mangekyo/kernel';
import type { ConceptEvidenceRow } from './concept-evidence.ts';
import type { AuthorizedKnowledgeGraph } from '@mangekyo/module-content/facts/knowledge-graph-overview';
import type { ConceptMasteryState, NodePracticeCandidate, SelectNodePracticeInput } from '@mangekyo/module-plan/facts/node-practice';

export type NodePracticeQuestion =
  | { readonly id: FactId; readonly rev: number; readonly kind: 'content.asset' }
  | {
    readonly id: FactId; readonly rev: number; readonly kind: 'activity.workspaceEntry';
    readonly prompt: string; readonly answer?: string | undefined; readonly rubric?: string | undefined;
  };

const masteryStates: Readonly<Record<string, ConceptMasteryState>> = {
  steady: 'solid', fading: 'fading', fragile: 'weak', unknown: 'unknown',
};

export function buildNodePracticeInput(input: {
  graph: Pick<AuthorizedKnowledgeGraph, 'nodes' | 'edges' | 'questionConceptLinks'>;
  nodeId: FactId;
  masteryByConcept: ReadonlyMap<FactId, { status: string }>;
  attempts: readonly ConceptEvidenceRow[];
  readableQuestions: readonly NodePracticeQuestion[];
  count?: number;
}): SelectNodePracticeInput {
  const node = input.graph.nodes.find(node => node.id === input.nodeId)!;
  const directPrerequisiteIds = input.graph.edges
    .filter(edge => edge.kind === 'prereq_of' && edge.toId === input.nodeId)
    .map(edge => edge.fromId);
  const readableIds = new Set(input.readableQuestions.map(question => question.id));
  const latestByQuestion = new Map<string, ConceptEvidenceRow>();
  for (const attempt of input.attempts) {
    if (!readableIds.has(attempt.questionId)) continue;
    const held = latestByQuestion.get(attempt.questionId);
    if (!held || Date.parse(attempt.occurredAt) >= Date.parse(held.occurredAt)) latestByQuestion.set(attempt.questionId, attempt);
  }
  const candidates: NodePracticeCandidate[] = input.graph.questionConceptLinks
    .filter(link => readableIds.has(link.questionId) && (link.conceptId === input.nodeId || directPrerequisiteIds.includes(link.conceptId)))
    .map(link => {
      const attempt = latestByQuestion.get(link.questionId);
      return {
        questionRef: link.questionId,
        conceptId: link.conceptId,
        lastOutcome: attempt?.outcome ?? null,
        helpLevel: attempt ? (attempt.exposure === 'independent' ? 'independent' : attempt.exposure === 'exposed' ? 'hinted' : 'unknown') : null,
        lastAttemptedAt: attempt?.occurredAt ?? null,
        isRedPenError: false,
        evidenceRef: attempt?.submission.id ?? `${link.questionId}:${link.questionRev}`,
      };
    });
  return {
    node: {
      id: node.id,
      title: node.title,
      masteryState: masteryStates[input.masteryByConcept.get(input.nodeId)?.status ?? 'unknown'] ?? 'unknown',
      directPrerequisiteIds,
    },
    candidates,
    ...(input.count === undefined ? {} : { limit: input.count }),
  };
}

export function mapQuickPaperDraft(selection: { title: string; questionRefs: readonly FactId[] }, questions: readonly NodePracticeQuestion[]) {
  const byId = new Map<FactId, NodePracticeQuestion>(
    questions.map((question): [FactId, NodePracticeQuestion] => [question.id, question]),
  );
  const selected = selection.questionRefs.map(id => byId.get(id)).filter(Boolean) as NodePracticeQuestion[];
  const useBank = selected.some(question => question.kind === 'content.asset');
  const usable = selected.filter((question): question is Extract<NodePracticeQuestion, { kind: 'activity.workspaceEntry' }> =>
    question.kind === (useBank ? 'never' : 'activity.workspaceEntry'));
  if (!usable.length) return null;
  return {
    title: selection.title,
    questions: useBank
      ? usable.map(question => ({ sourceQuestionRef: { id: question.id, rev: question.rev } }))
      : usable.map(question => question.answer !== undefined
        ? { kind: 'exact', prompt: question.prompt, answers: [question.answer], sourceQuestionRef: { id: question.id, rev: question.rev } }
        : { kind: 'rubric', prompt: question.prompt, rubric: question.rubric ?? '请独立完成并核对原题评分标准。', sourceQuestionRef: { id: question.id, rev: question.rev } }),
  };
}
