import { factId, FactReadDeniedError, isFactUnavailable, snapshotFactReaders, type Db, type FactId, type FactSnapshot, type ReadContext } from '../../kernel/src/index.ts';
import { readConceptAttemptEvidence } from '../../modules/activity/concept-evidence.ts';
import { buildNodePracticeInput, collectRedPenQuestionIds, mapQuickPaperDraft, type NodePracticeQuestion } from '../../modules/activity/node-practice-candidates.ts';
import { verifyWorkspaceEntryBasis, workspaceEntry } from '../../modules/activity/workspace-values.ts';
import { captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { applyAssetQuestionSolutions, parseAsset, questionPrompt, questionSolutionFields } from '../../modules/content/asset.ts';
import { readAuthorizedKnowledgeGraph } from '../../modules/content/knowledge-graph-overview.ts';
import { projectBatchConceptMastery } from '../../modules/learner/knowledge-mastery.ts';
import { selectQuestionsForConceptNode } from '../../modules/plan/node-practice.ts';
import { storageRead } from './fact-read-helpers.ts';
import { studioLearner } from './identity.ts';
import { intakeIdFor } from './intake-lifecycle.ts';
import { checkStudioNotionFact, notionReadScope } from './notion.ts';
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
    const read = snapshotFactReaders(tx)('storage', () => true), isNotion = (s: FactSnapshot) => s.type === captureSourceType && sourceEnvelope(s.value).kind === 'notion';
    const fact: ReadContext['fact'] = async (...[id, options]) => {
      const opened = await read.fact(id, options) as FactSnapshot;
      if (!isNotion(opened)) return opened as never;
      const authorized = await checkStudioNotionFact(tx, opened, 'storage', 'learner');
      if (!authorized) throw new FactReadDeniedError('recipient', '来源当前不可读取。');
      if (process.env.MANGEKYO_NOTION_TEST_ORIGIN || process.env.MANGEKYO_NOTION_TOKEN) await check(authorized);
      return authorized as never;};
    const gated = { ...read, fact };
    const graph = await readAuthorizedKnowledgeGraph(tx, {
      learner: tx.learner, purpose: 'storage', recipient: tx.learner, read: gated, isUnavailable: isFactUnavailable, preloadFollowing: read.preloadFollowing,
      verifyLegacyBasis: async (id, source) => verifyWorkspaceEntryBasis(gated, id, workspaceEntry(source.value).basis).then(() => true, () => false),
      reopenLegacyQuestion: async ref => {
        const opened = await gated.fact(ref.id, { mode: 'pinned', rev: ref.rev });
        return opened.accessEpoch === ref.accessEpoch && verifyWorkspaceEntryBasis(gated, ref.id, workspaceEntry(opened.value).basis).then(() => true, () => false);
      },
      openNotionSource: async source => isNotion(source) ? checkStudioNotionFact(tx, source, 'storage', 'learner') : source,
    });
    if (!graph.nodes.some(node => node.id === nodeId)) throw new RequestError(404, '找不到这个知识点。');
    const links = graph.questionConceptLinks.filter(l => l.conceptId === nodeId || graph.edges.some(e => e.kind === 'prereq_of' && e.toId === nodeId && e.fromId === l.conceptId));
    const questions: NodePracticeQuestion[] = [], materialIds = new Set<FactId>(), solutions = new Map<FactId, ReturnType<typeof questionSolutionFields>>();
    for (const link of links) {
      const opened = await gated.fact(link.questionId, { mode: 'following' }).catch(e => isFactUnavailable(e) ? undefined : Promise.reject(e)) as FactSnapshot | undefined;
      if (!opened) continue;
      if (opened.type === 'content.asset') { const asset = parseAsset(opened.value);
        asset.basis?.forEach(source => { if (source.type === 'activity.textMaterial') materialIds.add(source.id); });
        if (asset.kind === 'question' && questionPrompt(asset).trim()) (solutions.set(opened.ref.id, questionSolutionFields(asset)), questions.push({ id: opened.ref.id, rev: opened.ref.rev, kind: 'content.asset', prompt: questionPrompt(asset) }));
      } else if (opened.type === 'activity.workspaceEntry') { const value = workspaceEntry(opened.value);
        if (value.kind === 'question' && value.body.trim()) questions.push({ id: opened.ref.id, rev: opened.ref.rev, kind: 'activity.workspaceEntry', prompt: value.body,
          ...(value.answer === undefined ? {} : { answer: value.answer }), ...(value.rubric === undefined ? {} : { rubric: value.rubric }) });
      }
    }
    const redPenQuestionIds = await collectRedPenQuestionIds((await Promise.all([...materialIds].map(id =>
      gated.fact(intakeIdFor(id), { mode: 'following' }).catch(e => isFactUnavailable(e) ? undefined : Promise.reject(e))))).map(d => d?.value));
    questions.forEach((q, i) => { if (redPenQuestionIds.has(q.id)) questions[i] = { ...q, isRedPenError: true }; });
    const evidence = await readConceptAttemptEvidence(tx, { ...storageRead(tx), fact }, links, isFactUnavailable);
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
