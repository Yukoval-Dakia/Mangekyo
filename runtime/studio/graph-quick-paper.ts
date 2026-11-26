import { factId, isFactUnavailable, readAvailable, readLearnerClock, snapshotFactReaders,
  type Db, type FactId, type FactSnapshot } from '../../kernel/src/index.ts';
import { readConceptAttemptEvidence } from '../../modules/activity/concept-evidence.ts';
import { buildNodePracticeInput, collectRedPenQuestionIds, mapQuickPaperDraft, type NodePracticeQuestion } from '../../modules/activity/node-practice-candidates.ts';
import { workspaceEntry } from '../../modules/activity/workspace-values.ts';
import { applyAssetQuestionSolutions, parseAsset, questionPrompt, questionSolutionFields } from '../../modules/content/asset.ts';
import { readAuthorizedKnowledgeGraph } from '../../modules/content/knowledge-graph-overview.ts';
import { projectBatchConceptMastery } from '../../modules/learner/knowledge-mastery.ts';
import { buildSelectionEvidenceSlice, buildUnifiedExposureLocks, finalizeQuestionSelection, recallSelectionCandidates,
  type QuestionSelectionPlan } from '../../modules/learner/question-selection.ts';
import { selectQuestionsForConceptNode } from '../../modules/plan/node-practice.ts';
import type { PythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { storageRead, studioLearner } from './identity.ts';
import { intakeIdFor } from './intake-lifecycle.ts';
import { createKnowledgeGraphAccess } from './knowledge-graph.ts';
import { createNotionReader, notionReadScope } from './notion.ts';
import { loadAuthorizedRecordFlowSnapshot } from './record-flow.ts';
import { loadExposedQuestionIds, selectionEvidenceRows } from './iqdb.ts';
import { RequestError } from './sessions.ts';
import type { openWorkbook } from './workbook.ts';

export async function issueGraphQuickPaperResponse(
  db: Db, workbook: ReturnType<typeof openWorkbook>, nodeIdValue: string, input: Record<string, unknown>, pythonHost?: PythonDeriverHost,
) {
  let nodeId: FactId;
  try { nodeId = factId(nodeIdValue); } catch { throw new RequestError(400, '知识点标识无效。'); }
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw new RequestError(400, '抽题请求标识无效。');
  const count = input.count as number | undefined;
  if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 5))
    throw new RequestError(400, '抽题数量须为 1 到 5。');
  const durationMinutes = input.durationMinutes as number | undefined;
  if (durationMinutes !== undefined && (typeof durationMinutes !== 'number' || !Number.isSafeInteger(durationMinutes) ||
      durationMinutes < 1 || durationMinutes > 240)) throw new RequestError(400, '练习时长无效。');
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
    const legacyInput = buildNodePracticeInput({ graph, nodeId, masteryByConcept: mastery, attempts: evidence.attempts,
      readableQuestions: questions, ...(count === undefined ? {} : { count }) });
    const selection = selectQuestionsForConceptNode(legacyInput);
    const { snap } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose: 'storage' });
    const candidates = recallSelectionCandidates({ conceptIds: [nodeId] }, { snap, questions: questions.map(q => ({ id: q.id, rev: q.rev,
      title: q.prompt.slice(0, 80), prompt: q.prompt, conceptIds: links.filter(link => link.questionId === q.id).map(link => link.conceptId) })) });
    const exposureLocks = buildUnifiedExposureLocks({ snap, exposedQuestionIds: await loadExposedQuestionIds(tx) });
    const evidenceRows = selectionEvidenceRows(evidence.attempts);
    const slice = buildSelectionEvidenceSlice({ clockWatermark: String(await readLearnerClock(tx)),
      asOfAt: new Date().toISOString(), events: evidenceRows.events, omissions: evidenceRows.omissions, exposureLocks, candidates, snap,
      ...(durationMinutes === undefined ? {} : { budgetMin: durationMinutes }) });
    const selectionInput = { snap, candidates, exposureLocks, slice: slice.slice };
    if (selection.kind === 'empty') return { kind: 'empty' as const, suggestedAction: 'start_classroom' as const, reason: selection.reason,
      selectionInput, questions, solutions };
    const rawDraft = mapQuickPaperDraft({ ...selection, questionRefs: selection.questionRefs.map(factId) }, questions), draft = rawDraft && applyAssetQuestionSolutions(rawDraft, solutions);
    return draft ? { kind: 'ready' as const, selection, draft, selectionInput, questions, solutions, legacyInput }
      : { kind: 'empty' as const, suggestedAction: 'start_classroom' as const,
        reason: '该知识点尚未收录可自测题，建议先开 10 分钟微课或拍入相关练习。', selectionInput, questions, solutions };
  });
  let selectionPlan: QuestionSelectionPlan | undefined;
  if ('selectionInput' in prepared && pythonHost) {
    const derived = await pythonHost.derive('plan/information-gain@1', prepared.selectionInput.slice);
    const infoGain = derived?.kind === 'ok' && derived.outcome.kind === 'value'
      ? derived.outcome.value as Parameters<typeof finalizeQuestionSelection>[0]['infoGain']
      : { kind: 'unavailable' as const, reason: derived?.kind === 'failed' ? derived.reason
          : derived?.outcome.kind === 'unknown' ? derived.outcome.reason : '未配置信息增益推导器。' };
    selectionPlan = finalizeQuestionSelection({ request: { conceptIds: [nodeId], ...(durationMinutes === undefined ? {} : { durationMinutes }) },
      candidates: prepared.selectionInput.candidates, exposureLocks: prepared.selectionInput.exposureLocks,
      infoGain, snap: prepared.selectionInput.snap, ...(count === undefined ? {} : { maxSelected: count }) });
  }
  if (prepared.kind !== 'ready') return { status: 200, body: { kind: 'empty', suggestedAction: prepared.suggestedAction,
    reason: prepared.reason, ...(selectionPlan ? { selectionPlan } : {}) } };
  const exposureLockIds = new Set(prepared.selectionInput.exposureLocks.lockIds);
  const locked = (id: string) => exposureLockIds.has(id);
  const exposureEliminated = selectionPlan?.eliminated.every(entry => ['exposed_attempted', 'exposed_posttest', 'exposed_help', 'variant_spoiled']
    .includes(entry.reasonCode)) ?? false;
  const allExposureLocked = Boolean(selectionPlan && !selectionPlan.selected.length && selectionPlan.eliminated.length > 0 && exposureEliminated);
  const linked = (id: string) => prepared.legacyInput.candidates.some(candidate => candidate.questionRef === id);
  let chosen: string[];
  if (selectionPlan?.selected.length) {
    const engine = selectionPlan.selected.map(item => item.id).filter(linked);
    const redPen = prepared.questions.filter(q => q.isRedPenError && !locked(q.id));
    const ordered = [...redPen.map(q => q.id as string), ...engine.filter(id => !redPen.some(q => q.id === id))];
    chosen = [...new Set(ordered)].slice(0, count ?? 5);
  } else if (allExposureLocked) chosen = [];
  else if (selectionPlan) chosen = [...prepared.selection.questionRefs.filter(id => !locked(id))];
  else chosen = [...prepared.selection.questionRefs];
  const consistent = selectQuestionsForConceptNode({ ...prepared.legacyInput,
    candidates: prepared.legacyInput.candidates.filter(item => chosen.includes(item.questionRef)), limit: Math.max(1, chosen.length) });
  const fallbackBasis = prepared.selection.basis.filter(item => chosen.includes(item.questionRef));
  const basisSource = consistent.kind === 'ready' ? consistent.basis : fallbackBasis;
  const basisItems = [...basisSource].sort((a, b) => chosen.indexOf(a.questionRef) - chosen.indexOf(b.questionRef));
  const selection = { title: prepared.selection.title, questionRefs: chosen,
    reason: consistent.kind === 'ready' ? consistent.reason : (chosen.length ? prepared.selection.reason
      : '该知识点下的题目均已曝光，无法独立检验，建议先补拍新题或生成安全变式。'),
    basis: basisItems };
  const rawDraft = mapQuickPaperDraft({ title: selection.title, questionRefs: chosen.map(factId) }, prepared.questions);
  const draft = rawDraft && applyAssetQuestionSolutions(rawDraft, prepared.solutions);
  if (!draft) return { status: 200, body: { kind: 'empty', suggestedAction: 'start_classroom',
    reason: selection.reason, ...(selectionPlan ? { selectionPlan } : {}) } };
  const paper = await workbook.save({ requestId: input.requestId, ...draft, materialId: null });
  return { status: 201, body: { kind: 'paper', paperId: paper.id, title: selection.title,
    questionCount: draft.questions.length, reason: selection.reason, href: `/papers/${paper.id}`, basis: selection.basis,
    ...(selectionPlan ? { selectionPlan } : {}) } };
}
