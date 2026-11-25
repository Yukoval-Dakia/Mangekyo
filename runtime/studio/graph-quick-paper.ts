import { factId, isFactUnavailable, readAvailable, snapshotFactReaders, type Db, type FactId, type FactSnapshot } from '../../kernel/src/index.ts';
import { readConceptAttemptEvidence } from '../../modules/activity/concept-evidence.ts';
import { buildNodePracticeInput, collectRedPenQuestionIds, mapQuickPaperDraft, type NodePracticeQuestion } from '../../modules/activity/node-practice-candidates.ts';
import { workspaceEntry } from '../../modules/activity/workspace-values.ts';
import { applyAssetQuestionSolutions, parseAsset, questionPrompt, questionSolutionFields } from '../../modules/content/asset.ts';
import { readAuthorizedKnowledgeGraph } from '../../modules/content/knowledge-graph-overview.ts';
import { projectBatchConceptMastery } from '../../modules/learner/knowledge-mastery.ts';
import { selectQuestionsForConceptNode } from '../../modules/plan/node-practice.ts';
import { storageRead, studioLearner } from './identity.ts';
import { intakeIdFor } from './intake-lifecycle.ts';
import { createKnowledgeGraphAccess } from './knowledge-graph.ts';
import { createNotionReader, notionReadScope } from './notion.ts';
import { RequestError } from './sessions.ts';
import type { openWorkbook } from './workbook.ts';

export async function issueGraphQuickPaperResponse(db: Db, workbook: ReturnType<typeof openWorkbook>, nodeIdValue: string, input: Record<string, unknown>) {
  let nodeId: FactId;
  try { nodeId = factId(nodeIdValue); } catch { throw new RequestError(400, '知识点标识无效。'); }
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw new RequestError(400, '抽题请求标识无效。');
  const count = input.count as number | undefined;
  if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 5))
    throw new RequestError(400, '抽题数量须为 1 到 5。');
  const prepared = await notionReadScope(db, studioLearner, { readOnly: true }).read(async (tx, check) => {
    const read = snapshotFactReaders(tx)('storage', () => true);
    const gated = createNotionReader(tx, { purpose: 'storage', check, remoteOnly: true, base: read });
    const graph = await readAuthorizedKnowledgeGraph(tx, createKnowledgeGraphAccess(tx, gated, 'storage', check, read.preloadFollowing));
    if (!graph.nodes.some(node => node.id === nodeId)) throw new RequestError(404, '找不到这个知识点。');
    const links = graph.questionConceptLinks.filter(l => l.conceptId === nodeId || graph.edges.some(e => e.kind === 'prereq_of' && e.toId === nodeId && e.fromId === l.conceptId));
    const questions: NodePracticeQuestion[] = [], materialIds = new Set<FactId>(), solutions = new Map<FactId, ReturnType<typeof questionSolutionFields>>();
    for (const link of links) {
      const opened = await readAvailable(() => gated.fact(link.questionId, { mode: 'following' }));
      if (!opened) continue;
      if (opened.type === 'content.asset') {
        const asset = parseAsset(opened.value);
        asset.basis?.forEach(source => { if (source.type === 'activity.textMaterial') materialIds.add(source.id); });
        if (asset.kind === 'question' && questionPrompt(asset).trim()) (solutions.set(opened.ref.id, questionSolutionFields(asset)), questions.push({ id: opened.ref.id, rev: opened.ref.rev, kind: 'content.asset', prompt: questionPrompt(asset) }));
      } else if (opened.type === 'activity.workspaceEntry') {
        const value = workspaceEntry(opened.value);
        if (value.kind === 'question' && value.body.trim()) questions.push({ id: opened.ref.id, rev: opened.ref.rev, kind: 'activity.workspaceEntry', prompt: value.body,
          ...(value.answer === undefined ? {} : { answer: value.answer }), ...(value.rubric === undefined ? {} : { rubric: value.rubric }) });
      }
    }
    const redPenQuestionIds = await collectRedPenQuestionIds((await Promise.all([...materialIds].map(id =>
      readAvailable(() => gated.fact(intakeIdFor(id), { mode: 'following' }))))).map(d => d?.value));
    questions.forEach((q, i) => { if (redPenQuestionIds.has(q.id)) questions[i] = { ...q, isRedPenError: true }; });
    const evidence = await readConceptAttemptEvidence(tx, { ...storageRead(tx), fact: gated.fact }, links, isFactUnavailable);
    const mastery = projectBatchConceptMastery({ asOf: new Date().toISOString(), conceptIds: graph.nodes.map(i => i.id), attempts: evidence.attempts, forecasts: [], incompleteConceptIds: evidence.incompleteConceptIds, activeMisconceptionConceptIds: new Set() });
    const selection = selectQuestionsForConceptNode(buildNodePracticeInput({ graph, nodeId, masteryByConcept: mastery, attempts: evidence.attempts, readableQuestions: questions, ...(count === undefined ? {} : { count }) }));
    if (selection.kind === 'empty') return selection;
    const rawDraft = mapQuickPaperDraft({ ...selection, questionRefs: selection.questionRefs.map(factId) }, questions), draft = rawDraft && applyAssetQuestionSolutions(rawDraft, solutions);
    return draft ? { kind: 'ready' as const, selection, draft } : { kind: 'empty' as const, suggestedAction: 'start_classroom' as const, reason: '该知识点尚未收录可自测题，建议先开 10 分钟微课或拍入相关练习。' as const };
  });
  if (prepared.kind !== 'ready') return { status: 200, body: prepared };
  const paper = await workbook.save({ requestId: input.requestId, ...prepared.draft, materialId: null });
  return { status: 201, body: { kind: 'paper', paperId: paper.id, title: prepared.selection.title, questionCount: prepared.draft.questions.length, reason: prepared.selection.reason, href: `/papers/${paper.id}`, basis: prepared.selection.basis } };
}
