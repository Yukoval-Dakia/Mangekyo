import { FactNotFoundError, FactReadDeniedError, type FactSnapshot, type ReadContext, type ReadTransaction, type Tick } from '@mangekyo/kernel';
import { assetType } from '@mangekyo/module-content/facts/asset-contract';
import { openArithmeticPractice } from '@mangekyo/module-content/facts/arithmetic-practice';
import { knowledgeEdgeType } from '@mangekyo/module-content/facts/knowledge-edge';
import { licensedQuestionCopy, workbookAnswerDisplayCandidates } from './evidence-read.ts';
import {
  arithmeticPracticePaperId, practiceCustodyId, practiceCustodyType, readPracticeCustody,
} from './sealed-practice.ts';
import { isSourceFactId } from './source-values.ts';
import { workbookPaper, type WorkbookSourceQuestionRef } from './workbook-values.ts';
import { workspaceEntry, workspaceEntryType } from './workspace-values.ts';
export const pythonQuestionsScanLimit = 96;
const outputBytes = 12 * 1024;
export type PythonQuestionsTrack = (fact: FactSnapshot, mode?: 'pinned' | 'following') => void;
type Witness = Parameters<PythonQuestionsTrack>;
export type PythonQuestionsMaySend = (fact: FactSnapshot) => boolean;
export type PythonQuestionItem = {
  id: string; rev: number; title: string; prompt: string; kc_ids: string[];
  answer_exposed: boolean | null; practice_id?: string;
};
export type PythonQuestionsArgs = { kc_ids?: unknown; limit?: unknown; answer_exposed?: unknown };
export type StudioPythonQuestionsDeps = {
  readonly purpose: string;
  readonly questionScope: string;
  readonly toolFailure: (code: string, message: string, next: { tool: string; args: unknown }, field?: string) => any;
  readonly isFactNotFound: (error: unknown) => boolean;
  readonly isFactReadDenied: (error: unknown) => boolean;
  readonly createAuthorizedFactReader: (tx: ReadTransaction, purpose: string, maySend: PythonQuestionsMaySend) => Pick<ReadContext, 'fact'>;
  readonly resolveSource: (tx: ReadTransaction, input: unknown, access: unknown) => Promise<any>;
  readonly openKnowledgeEdge: (tx: ReadTransaction, input: string, access: unknown) => Promise<any>;
  readonly checkStudioNotionFact: (tx: ReadTransaction, fact: FactSnapshot, purpose: string, maySend: PythonQuestionsMaySend) => Promise<unknown>;
  readonly questionNegativeCurrent: (tx: ReadTransaction, questionId: string, turn: string, negative: boolean) => Promise<boolean>;
  readonly queryCandidates: (concepts: readonly { id: string; rev: number }[]) => Promise<readonly { id: string }[]>;
  readonly queryEdges: (questionId: string, questionRev: number, concepts: readonly { id: string; rev: number }[]) => Promise<readonly { id: string }[]>;
};
async function practiceExposure(deps: StudioPythonQuestionsDeps, tx: ReadTransaction,
  ref: Parameters<typeof arithmeticPracticePaperId>[0], version: number, maySend: PythonQuestionsMaySend,
  track: PythonQuestionsTrack) {
  const id = await arithmeticPracticePaperId(ref);
  const read = deps.createAuthorizedFactReader(tx, deps.purpose, maySend);
  const record = await readPracticeCustody(read, await practiceCustodyId(id));
  if (!record || record.value.question.id !== ref || record.value.paper.id !== id) return;
  if (record.value.kind === 'sealed' && record.value.question.rev !== version) {
    const licensed = await licensedQuestionCopy(tx, record.value.question, deps.purpose);
    const fact = await read.fact(ref, { mode: 'pinned', rev: licensed.rev });
    if (!await openArithmeticPractice(read, ref, fact)) return;
    track(fact, 'pinned');
  }
  track(record.fact, 'following');
  return { kind: record.value.kind, paperId: id };
}
async function confirmedAnswerDisplay(deps: StudioPythonQuestionsDeps, tx: ReadTransaction,
  source: WorkbookSourceQuestionRef, through: Tick, maySend: PythonQuestionsMaySend,
  track: PythonQuestionsTrack): Promise<true | null> {
  const ids = await workbookAnswerDisplayCandidates(tx, source, through, deps.purpose, 8);
  const read = deps.createAuthorizedFactReader(tx, deps.purpose, maySend);
  for (const row of ids) {
    try {
      const evidence = await Promise.all([row.display_id, row.paper_id, row.attempt_id]
        .map(id => read.fact(id, { mode: 'following' })));
      const material = workbookPaper(evidence[1]!.value).materialId;
      const sources: Witness[] = [];
      if (material && !await deps.resolveSource(tx, material, {
        recipient: 'workspace', maySend, exactReadModes: true, track: (...w: readonly unknown[]) => sources.push(w as Witness),
      })) continue;
      for (const fact of evidence) {
        await deps.checkStudioNotionFact(tx, fact, deps.purpose, maySend);
        sources.push([fact, 'following']);
      }
      for (const witness of sources) track(...witness);
      return true;
    } catch (error) {
      if (!(deps.isFactNotFound(error) || deps.isFactReadDenied(error) ||
          error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
    }
  }
  return null;
}
export async function readStudioPythonQuestions(deps: StudioPythonQuestionsDeps, tx: ReadTransaction,
  args: PythonQuestionsArgs, through: Tick, access: {
    maySend: PythonQuestionsMaySend; track: PythonQuestionsTrack; known(id: string): boolean; turn: string; trackNegative(id: string): void;
  }) {
  const sourceAccess = { recipient: 'workspace', maySend: access.maySend, exactReadModes: true } as const;
  const concepts: { id: string; rev: number; type?: string }[] = [];
  const conceptWitnesses: Witness[] = [];
  for (const id of Array.isArray(args.kc_ids) ? args.kc_ids : []) {
    const source = isSourceFactId(id) ? await deps.resolveSource(tx, id, {
      ...sourceAccess, track: (...w: readonly unknown[]) => conceptWitnesses.push(w as Witness),
    }) : undefined;
    if (source?.kind !== 'concept' || source.sourceRef.fact.type !== workspaceEntryType) {
      return typeof id === 'string' && access.known(id)
        ? deps.toolFailure('access_revoked', '先前打开的知识点已不可用。', { tool: 'read_context', args: { intent: 'tutoring' } })
        : deps.toolFailure('not_found', '请提供当前可读取的知识点 ID。', { tool: 'read_context', args: { intent: 'tutoring' } }, 'kc_ids');
    }
    concepts.push(source.sourceRef.fact);
  }
  const rows = await deps.queryCandidates(concepts);
  const items: PythonQuestionItem[] = [];
  let truncated = rows.length > pythonQuestionsScanLimit;
  let known = 0;
  let unknown = 0;
  let remainingBytes = outputBytes;
  const limit = typeof args.limit === 'number' ? args.limit : 30;
  for (const { id } of rows.slice(0, pythonQuestionsScanLimit)) {
    const witnesses: Witness[] = [];
    const track: PythonQuestionsTrack = (...w) => witnesses.push(w);
    const source = await deps.resolveSource(tx, id, { ...sourceAccess, track });
    const root = witnesses.find(([fact]) => fact.ref.id === id)?.[0];
    if (!isSourceFactId(id) || source?.kind !== 'question' || !root) continue;
    const kcIds = new Set<string>();
    if (concepts.length) {
      const edges = await deps.queryEdges(id, source.rev, concepts);
      truncated ||= edges.length > pythonQuestionsScanLimit;
      for (const edgeId of edges.slice(0, pythonQuestionsScanLimit)) {
        const edge = await deps.openKnowledgeEdge(tx, edgeId.id, sourceAccess);
        if (!edge || edge.value.kind !== 'targets_concept' || edge.from.kind !== 'question' ||
            edge.from.id !== id || edge.from.rev !== source.rev || edge.to.kind !== 'concept' ||
            !concepts.some(kc => kc.id === edge.to.id && kc.rev === edge.to.rev) || kcIds.has(edge.to.id)) continue;
        kcIds.add(edge.to.id);
        witnesses.push(...edge.opened);
      }
      if (!kcIds.size) continue;
    }
    let custody;
    if (root.type === assetType) {
      try { custody = await practiceExposure(deps, tx, root.ref.id, root.ref.rev, access.maySend, track); }
      catch (error) {
        if (!(deps.isFactNotFound(error) || deps.isFactReadDenied(error) ||
            error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
      }
      if (!custody) continue;
    } else if (root.type !== workspaceEntryType) continue;
    const confirmed = await confirmedAnswerDisplay(deps, tx, root.ref, through, access.maySend, track);
    const answerExposed = confirmed ?? (custody?.kind === 'sealed' &&
      await deps.questionNegativeCurrent(tx, root.ref.id, access.turn, true) ? false : null);
    if (answerExposed === null) unknown++;
    else known++;
    if (answerExposed === false) access.trackNegative(id);
    // A row excluded by the answer filter may still determine the coverage status.
    for (const witness of witnesses) access.track(...witness);
    if (args.answer_exposed !== undefined && args.answer_exposed !== answerExposed) continue;
    const prompt = root.type === workspaceEntryType ? workspaceEntry(root.value).body : source.content;
    if (typeof prompt !== 'string') continue;
    const item = { id, rev: source.rev, title: source.title, prompt, kc_ids: [...kcIds].sort(),
      answer_exposed: answerExposed, ...(custody && { practice_id: custody.paperId }) };
    remainingBytes -= Buffer.byteLength(JSON.stringify(item)) + 1;
    if (items.length === limit || remainingBytes < 0) {
      truncated = true;
      break;
    }
    items.push(item);
  }
  for (const witness of conceptWitnesses) access.track(...witness);
  const coverage = unknown || truncated ? (known ? 'partial' : 'unknown') : 'complete';
  return { value: { scope: deps.questionScope, coverage, truncated, items } };
}
