import {
  FactNotFoundError, FactReadDeniedError, factId, parseManifest, revalidateManifest,
  type FactId, type FactSnapshot, type ReadContext, type ReadTransaction, type Revision,
} from '@mangekyo/kernel';
import { forecastType, readAnyRetentionMethod, type RetentionForecast } from '@mangekyo/module-learner/facts/retention';
import { knowledgeEdgeType } from '@mangekyo/module-content/facts/knowledge-edge';
import { readPosttestIssuanceBirth, workbookLinkCandidates, workbookWitnessesBy, type FactReadChecks } from './evidence-read.ts';
import {
  workbookTraceConceptProofs, sharedWorkbookTraceConcepts, earlierWorkbookTraceAttempts,
  isFrozenWorkbookFollowup, readWorkbookFollowupForecast, workbookTraceCutoff as cutoff,
  workbookWitnessReader as collect, workbookTraceOtherQuestion, WorkbookTraceReadError,
  type WorkbookTraceProof, type WorkbookTraceQuestionRef as Ref,
} from './workbook-backtrace-values.ts';
import { memoWorkbookRead } from './workbook-context-read.ts';
import { workbookAttempt, type WorkbookSourceQuestionRef } from './workbook-values.ts';
import { posttestAttemptFor, posttestIdFor, readPosttestIssuance } from './retention-host-support.ts';
type Reader = Pick<ReadContext, 'fact'>;
export type StudioBacktraceDeps = FactReadChecks & {
  readonly retentionPurpose: string; readonly isRequestError: (error: unknown) => boolean;
  readonly openRetentionTarget: (tx: ReadTransaction, read: Reader, paper: unknown, itemId: string) => Promise<any>;
  readonly readItemConceptLinks: (tx: ReadTransaction, ref: unknown, through: unknown, open: unknown) => Promise<readonly any[]>;
  readonly readWorkbookEvidence: (tx: ReadTransaction, read: Reader, old: any, attemptId: FactId) => Promise<any>;
  readonly scopedKnowledgeEdges: (tx: ReadTransaction, access: unknown, facts: unknown) => (id: string) => Promise<any>;
  readonly retentionHistoryValid: (tx: ReadTransaction, id: unknown, observation?: any) => Promise<boolean>;
  readonly backtrace: (input: unknown, history: readonly any[], candidate: readonly unknown[]) => { independentSuccesses: readonly any[] };
};
function unavailable(deps: StudioBacktraceDeps, error: unknown) {
  return deps.isFactNotFound(error) || deps.isFactReadDenied(error) ||
    error instanceof FactNotFoundError || error instanceof FactReadDeniedError ||
    error instanceof WorkbookTraceReadError || deps.isRequestError(error);
}
type Opened = {
  source: { ref: { id: string; rev: number } };
  question: { sourceQuestionRef?: WorkbookSourceQuestionRef; prompt: string };
  target: { paper: { id: string; rev: number } }; paper: { savedAt: string };
};
async function delayedSitting(deps: StudioBacktraceDeps, tx: ReadTransaction, read: Reader, earlier: any, later: any,
  readIssuance: typeof readPosttestIssuance) {
  const submission = await read.fact(later.submission.id, { mode: 'following' });
  const { issuance, fact } = await readIssuance(tx, read, factId(workbookAttempt(submission.value).paperId));
  if (fact.ref.id !== posttestIdFor(issuance.forecastId) || later.submission.id !== posttestAttemptFor(fact.ref.id)) return false;
  const row = await readWorkbookFollowupForecast<RetentionForecast['input'], RetentionForecast['method']>(tx, issuance, forecastType);
  if (!row?.input || !row.method || !readAnyRetentionMethod(row.method.id + '@' + row.method.version) ||
      !isFrozenWorkbookFollowup(row.input, issuance, earlier, later)) return false;
  const manifest = parseManifest(row.manifest);
  if (manifest.purpose !== deps.retentionPurpose || (await revalidateManifest(tx, manifest)).kind !== 'valid' ||
      !await deps.retentionHistoryValid(tx, issuance.forecastId)) return false;
  for (const input of manifest.inputs) {
    if (input.kind !== 'fact') return false;
    const current = await read.fact(input.id, input.mode === 'pinned' ? { mode: 'pinned', rev: input.rev as Revision } : { mode: 'following' });
    if (current.ref.rev !== input.rev || current.accessEpoch !== input.accessEpoch) return false;
  }
  return true;
}
async function stableQuestion(deps: StudioBacktraceDeps, item: Opened, edgeId: string, read: Reader,
  open: ReturnType<StudioBacktraceDeps['scopedKnowledgeEdges']>,
  attempts: (ref: Ref) => ReturnType<typeof earlierWorkbookTraceAttempts>) {
  const edge = await open(edgeId);
  if (!edge || edge.value.kind !== 'variant_of' || edge.value.variant?.spoilsNext !== 'none') return;
  for (const [fact, mode] of edge.opened as readonly [FactSnapshot, 'pinned' | 'following' | undefined][]) {
    const opened = await read.fact(fact.ref.id, mode === 'following' ? { mode } : { mode: 'pinned', rev: fact.ref.rev });
    if (opened.ref.rev !== fact.ref.rev || opened.accessEpoch !== fact.accessEpoch) return;
  }
  const oldQuestion = workbookTraceOtherQuestion(edge.value.from.fact, edge.value.to.fact, item.question.sourceQuestionRef!);
  return oldQuestion && { oldQuestion, rows: await attempts(oldQuestion) };
}
function workbookBacktraceReads(deps: StudioBacktraceDeps, tx: ReadTransaction, reader: Reader, facts: unknown) {
  const open = deps.scopedKnowledgeEdges(tx, { recipient: 'workspace', purpose: deps.retentionPurpose, maySend: () => true,
    readNotionWitness: (fact: FactSnapshot) => reader.fact(fact.ref.id, { mode: 'pinned', rev: fact.ref.rev }) }, facts);
  const birth = memoWorkbookRead((id: FactId) => readPosttestIssuanceBirth(tx, id));
  const readIssuance: typeof readPosttestIssuance = (innerTx, read, id) => readPosttestIssuance(tx, read, id, (_unused, issuedId) => birth(issuedId));
  const readWorkbookEvidence = deps.readWorkbookEvidence;
  const oldTarget = memoWorkbookRead(async (paper: FactId, item: string) => {
    const proof = collect(reader, tx);
    const old = await deps.openRetentionTarget(tx, proof.read, paper, item);
    return { old, basis: proof.witnesses() };
  });
  const observations = memoWorkbookRead(async (paper: FactId, item: string, attempts: readonly string[]) => {
    const { old } = await oldTarget(paper, item);
    const proof = collect(reader, tx);
    const results = [];
    for (const id of attempts) results.push(await readWorkbookEvidence(tx, proof.read, old, factId(id)));
    return { results, basis: proof.witnesses() };
  });
  const followup = memoWorkbookRead(async (earlier: any, later: any) => {
    const proof = collect(reader, tx);
    const valid = await delayedSitting(deps, tx, proof.read, earlier, later, readIssuance);
    return { valid, basis: proof.witnesses() };
  });
  return { open, oldTarget, observations, followup };
}
export type StudioBacktraceInput = { paper: Ref; itemId: string; question: Ref; attemptRef?: Ref };
export function studioWorkbookBacktrace(deps: StudioBacktraceDeps, tx: ReadTransaction, reader: Reader, facts: unknown) {
  const reads = workbookBacktraceReads(deps, tx, reader, facts);
  return (input: StudioBacktraceInput) => findWorkbookBacktrace(deps, tx, input, reader, reads);
}
async function findWorkbookBacktrace(deps: StudioBacktraceDeps, tx: ReadTransaction, input: StudioBacktraceInput,
  reader: Reader, { open, oldTarget, observations, followup }: ReturnType<typeof workbookBacktraceReads>) {
  const root = collect(reader, tx);
  try {
    const item: Opened = await deps.openRetentionTarget(tx, root.read, factId(input.paper.id), input.itemId);
    if (item.source.ref.rev !== input.paper.rev || item.question.sourceQuestionRef?.id !== input.question.id ||
        item.question.sourceQuestionRef.rev !== input.question.rev) return null;
    const through = await cutoff(tx, item as never, input.attemptRef, root.read);
    if (!through) return null;
    const source = item.question.sourceQuestionRef;
    const links = memoWorkbookRead((ref: typeof source) => deps.readItemConceptLinks(tx, ref, through.observedThrough, open));
    const attempts = memoWorkbookRead((ref: Ref) => earlierWorkbookTraceAttempts(tx, ref, through.observedThrough));
    const concepts = await links(source);
    if (!concepts.length) return null;
    const edges = await workbookLinkCandidates(tx, knowledgeEdgeType, source, through.observedThrough, ['variant_of'], 'unspoiled-variant');
    const proofs: WorkbookTraceProof[] = [];
    for (const { id } of edges) {
      const graph = collect(reader, tx);
      const related = await stableQuestion(deps, item, id, graph.read, open, attempts).catch(error => {
        if (!unavailable(deps, error)) throw error;
      });
      if (!related) continue;
      for (const row of related.rows) {
        try {
          const paper = factId(row.paper);
          const { old, basis: targetBasis } = await oldTarget(paper, row.item);
          const ref = old.question.sourceQuestionRef;
          if (ref?.id !== related.oldQuestion.id || ref.rev !== related.oldQuestion.rev || old.question.prompt === item.question.prompt) continue;
          const shared = sharedWorkbookTraceConcepts(concepts, await links(ref));
          if (!shared.length) continue;
          const conceptIds = shared.map(({ id }) => id);
          const { results, basis: observationBasis } = await observations(paper, row.item, row.attempts);
          const history = results.map(({ observation, process }: any) => ({
            submission: { learner: tx.learner, ...observation.submission }, item: { paper: old.source.ref, itemId: row.item },
            images: [], help: process.exposure.kind === 'exposed' ? process.exposure.refs.map((ref: any) => ({ learner: tx.learner, ...ref })) : [],
            occurredAt: observation.submittedAt, admittedAt: observation.admittedAt, conceptIds, mechanismIds: [],
            methodIds: [], outcome: observation.result, helpLevel: process.helpLevel,
          }));
          const candidate = [...graph.witnesses(), ...targetBasis, ...observationBasis];
          const { independentSuccesses: [later, earlier] } = deps.backtrace(
            { learner: tx.learner, conceptIds, mechanismIds: [], methodIds: [], ...through }, history, candidate);
          if (!later || !earlier) continue;
          const { valid, basis: followupBasis } = await followup(earlier, later);
          const basis = collect(reader, tx, [...candidate, ...followupBasis]).witnesses();
          if (!valid || !await workbookWitnessesBy(tx, basis, through.observedThrough)) continue;
          for (const concept of await workbookTraceConceptProofs(tx, reader, shared, error => unavailable(deps, error))) {
            const witnesses = collect(reader, tx, [...root.witnesses(), ...basis, ...concept]).witnesses();
            proofs.push({ text: old.question.prompt, content: { id: factId(ref.id), rev: ref.rev }, witnesses });
          }
        } catch (error) {
          if (!unavailable(deps, error)) throw error;
        }
      }
    }
    return proofs;
  } catch (error) {
    if (unavailable(deps, error)) return null;
    throw error;
  }
}
