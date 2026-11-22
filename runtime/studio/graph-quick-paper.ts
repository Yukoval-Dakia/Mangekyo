import { createCommandReadContext, FactNotFoundError, FactReadDeniedError, snapshotFactReaders } from '../../kernel/src/commands/reads.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, ReadContext } from '../../kernel/src/declarations/types.ts';
import { readConceptAttemptEvidence } from '../../modules/activity/concept-evidence.ts';
import { verifyWorkspaceEntryBasis, workspaceEntry } from '../../modules/activity/workspace-values.ts';
import { buildNodePracticeInput, mapQuickPaperDraft, type NodePracticeQuestion } from '../../modules/activity/node-practice-candidates.ts';
import { readAuthorizedKnowledgeGraph } from '../../modules/content/knowledge-graph-overview.ts';
import { projectBatchConceptMastery } from '../../modules/learner/knowledge-mastery.ts';
import { selectQuestionsForConceptNode } from '../../modules/plan/node-practice.ts';
import { captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { checkStudioNotionFact, notionReadScope, type CheckNotionRead } from './notion.ts';
import { stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';
import type { openWorkbook } from './workbook.ts';

const unavailable = (error: unknown) => error instanceof FactNotFoundError || error instanceof FactReadDeniedError;
export async function issueGraphQuickPaperResponse(db: Db, workbook: ReturnType<typeof openWorkbook>, nodeIdValue: string, input: Record<string, unknown>) {
  let nodeId: FactId;
  try { nodeId = factId(nodeIdValue); } catch { throw new RequestError(400, '知识点标识无效。'); }
  if (input.requestId === undefined || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) {
    throw new RequestError(400, '抽题请求标识无效。');
  }
  const rawCount = input.count;
  if (rawCount !== undefined && (typeof rawCount !== 'number' || !Number.isSafeInteger(rawCount) || rawCount < 1 || rawCount > 5)) throw new RequestError(400, '抽题数量须为 1 到 5。');
  const count = rawCount as number | undefined;
  const body = await notionReadScope(db, studioLearner, { readOnly: true }).read(async (tx, check) => {
    const read = snapshotFactReaders(tx)('storage', () => true);
    const teachingRead = snapshotFactReaders(tx)('teaching', () => true);
    const rawFact = read.fact;
    const fact: ReadContext['fact'] = async (...[id, options]) => {
      const opened = await rawFact(id, options) as FactSnapshot;
      if (opened.type !== captureSourceType || sourceEnvelope(opened.value).kind !== 'notion') return opened as never;
      const authorized = await checkStudioNotionFact(tx, opened, 'storage', 'learner');
      if (!authorized) throw new FactReadDeniedError('recipient', '来源当前不可读取。');
      if (process.env.MANGEKYO_NOTION_TEST_ORIGIN || process.env.MANGEKYO_NOTION_TOKEN) await check(authorized);
      return authorized as never;
    };
    const gated = { ...read, fact };
    const graph = await readAuthorizedKnowledgeGraph(tx, {
      learner: tx.learner, purpose: 'storage', recipient: tx.learner, read: gated, isUnavailable: unavailable,
      preloadFollowing: read.preloadFollowing,
      verifyLegacyBasis: async (id, source) => {
        try { await verifyWorkspaceEntryBasis(gated, id, workspaceEntry(source.value).basis); return true; } catch { return false; }
      },
      reopenLegacyQuestion: async ref => {
        const opened = await gated.fact(ref.id, { mode: 'pinned', rev: ref.rev });
        try { if (opened.accessEpoch !== ref.accessEpoch) return false; await verifyWorkspaceEntryBasis(gated, ref.id, workspaceEntry(opened.value).basis); return true; } catch { return false; }
      },
      openNotionSource: async source => source.type !== captureSourceType || sourceEnvelope(source.value).kind !== 'notion'
        ? source
        : await checkStudioNotionFact(tx, source, 'storage', 'learner'),
    });
    const node = graph.nodes.find(node => node.id === nodeId);
    if (!node) throw new RequestError(404, '找不到这个知识点。');
    const links = graph.questionConceptLinks.filter(link => link.conceptId === nodeId || graph.edges.some(edge => edge.kind === 'prereq_of' && edge.toId === nodeId && edge.fromId === link.conceptId));
    const questions: NodePracticeQuestion[] = [];
    for (const link of links) {
      try {
        const opened = await teachingRead.fact(link.questionId, { mode: 'following' }) as FactSnapshot;
        if (opened.type === 'content.asset') questions.push({ id: opened.ref.id, rev: opened.ref.rev, kind: 'content.asset' });
        else if (opened.type === 'activity.workspaceEntry') {
          const value = workspaceEntry(opened.value);
          if (value.kind === 'question' && value.body.trim()) questions.push({ id: opened.ref.id, rev: opened.ref.rev, kind: 'activity.workspaceEntry', prompt: value.body, ...(value.answer === undefined ? {} : { answer: value.answer }), ...(value.rubric === undefined ? {} : { rubric: value.rubric }) });
        }
      } catch (error) { if (!unavailable(error)) throw error; }
    }
    const storageRead = { ...createCommandReadContext(tx, 'storage'), fact };
    const evidence = await readConceptAttemptEvidence(tx, storageRead, links, unavailable);
    const mastery = projectBatchConceptMastery({ asOf: new Date().toISOString(), conceptIds: graph.nodes.map(item => item.id), attempts: evidence.attempts, forecasts: [], incompleteConceptIds: evidence.incompleteConceptIds, activeMisconceptionConceptIds: new Set() });
    const selection = selectQuestionsForConceptNode(buildNodePracticeInput({ graph, nodeId, masteryByConcept: mastery, attempts: evidence.attempts, readableQuestions: questions, ...(count === undefined ? {} : { count }) }));
    if (selection.kind === 'empty') return selection;
    const draft = mapQuickPaperDraft({ ...selection, questionRefs: selection.questionRefs.map(factId) }, questions);
    if (!draft) return { kind: 'empty', suggestedAction: 'start_classroom', reason: '该知识点尚未收录可自测题，建议先开 10 分钟微课或拍入相关练习。' } as const;
    const paper = await workbook.save({ requestId: input.requestId, ...draft, materialId: null });
    return { kind: 'paper', paperId: paper.id, title: selection.title, questionCount: selection.questionRefs.length, reason: selection.reason, href: `/papers/${paper.id}`, basis: selection.basis };
  });
  return { status: body.kind === 'paper' ? 201 : 200, body };
}
