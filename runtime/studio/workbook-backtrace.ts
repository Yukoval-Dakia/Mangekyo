import { FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { ReadContext } from '../../kernel/src/declarations/types.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { readPosttestIssuanceBirth, workbookLinkCandidates, workbookWitnessesBy } from '../../modules/activity/evidence-read.ts';
import {
  workbookTraceConceptProofs, sharedWorkbookTraceConcepts, earlierWorkbookTraceAttempts, isFrozenWorkbookFollowup, readWorkbookFollowupForecast, workbookTraceCutoff as cutoff,
  workbookWitnessReader as collect, workbookTraceOtherQuestion, WorkbookTraceReadError, type WorkbookTraceProof, type WorkbookTraceQuestionRef as Ref,
} from '../../modules/activity/workbook-backtrace-values.ts';
import { memoWorkbookRead } from '../../modules/activity/workbook-context-read.ts';
import { workbookAttempt } from '../../modules/activity/workbook-values.ts';
import { knowledgeEdgeType } from '../../modules/content/knowledge-edge.ts';
import { backtrace, type TraceAttempt } from '../../modules/learner/retention-backtrace.ts';
import { forecastType, readAnyRetentionMethod, type RetentionForecast } from '../../modules/learner/retention.ts';
import { scopedKnowledgeEdges } from './knowledge-graph.ts';
import { openRetentionTarget, readItemConceptLinks, retentionPurpose, retentionWorkbookEvidence } from './retention-workbook.ts';
import { posttestAttemptFor, posttestIdFor, readPosttestIssuance } from './retention-posttest.ts';
import { retentionHistoryValid } from './retention.ts';
import { RequestError } from './sessions.ts';

type Input = { paper: Ref; itemId: string; question: Ref; attemptRef?: Ref };
type Reader = Pick<ReadContext, 'fact'>;
function unavailable(error: unknown) {
  return error instanceof FactNotFoundError || error instanceof FactReadDeniedError ||
    error instanceof WorkbookTraceReadError || error instanceof RequestError;
}

type Opened = Awaited<ReturnType<typeof openRetentionTarget>>;
async function delayedSitting(tx: ReadTransaction, read: Reader, earlier: TraceAttempt, later: TraceAttempt,
  readIssuance: typeof readPosttestIssuance) {
  const submission = await read.fact(later.submission.id, { mode: 'following' });
  const { issuance, fact } = await readIssuance(tx, read, factId(workbookAttempt(submission.value).paperId));
  if (fact.ref.id !== posttestIdFor(issuance.forecastId) || later.submission.id !== posttestAttemptFor(fact.ref.id)) return false;
  const row = await readWorkbookFollowupForecast<RetentionForecast['input'],RetentionForecast['method']>(tx,issuance,forecastType);
  if (!row?.input || !row.method || !readAnyRetentionMethod(row.method.id + '@' + row.method.version) ||
      !isFrozenWorkbookFollowup(row.input, issuance, earlier, later)) return false;
  const manifest = parseManifest(row.manifest);
  if (manifest.purpose !== retentionPurpose || (await revalidateManifest(tx, manifest)).kind !== 'valid' ||
      !await retentionHistoryValid(tx, issuance.forecastId)) return false;
  for (const input of manifest.inputs) {
    if (input.kind !== 'fact') return false;
    const current = await read.fact(input.id, input.mode === 'pinned' ? { mode: 'pinned', rev: input.rev as Revision } : { mode: 'following' });
    if (current.ref.rev !== input.rev || current.accessEpoch !== input.accessEpoch) return false;
  }
  return true;
}

async function stableQuestion(item: Opened, edgeId: string, read: Reader, open: ReturnType<typeof scopedKnowledgeEdges>,
  attempts: (ref: Ref) => ReturnType<typeof earlierWorkbookTraceAttempts>) {
  const edge = await open(edgeId);
  if (!edge || edge.value.kind !== 'variant_of' || edge.value.variant?.spoilsNext !== 'none') return;
  for (const [fact, mode] of edge.opened) {
    const opened = await read.fact(fact.ref.id, mode === 'following' ? { mode } : { mode: 'pinned', rev: fact.ref.rev });
    if (opened.ref.rev !== fact.ref.rev || opened.accessEpoch !== fact.accessEpoch) return;
  }
  const oldQuestion = workbookTraceOtherQuestion(edge.value.from.fact,edge.value.to.fact,item.question.sourceQuestionRef!);
  return oldQuestion && {oldQuestion,rows:await attempts(oldQuestion)};
}

function workbookBacktraceReads(tx: ReadTransaction, reader: Reader, facts: Parameters<typeof scopedKnowledgeEdges>[2]) {
  const open = scopedKnowledgeEdges(tx,{recipient:'workspace',purpose:retentionPurpose,maySend:() => true,
    readNotionWitness: fact => reader.fact(fact.ref.id,{mode:'pinned',rev:fact.ref.rev})},facts);
  const birth = memoWorkbookRead((id: FactId) => readPosttestIssuanceBirth(tx,id));
  const readIssuance: typeof readPosttestIssuance = (_,read,id) => readPosttestIssuance(tx,read,id,(_,id) => birth(id));
  const {readWorkbookEvidence} = retentionWorkbookEvidence(readIssuance);
  const oldTarget = memoWorkbookRead(async (paper: FactId,item: string) => {
    const proof = collect(reader,tx);
    const old = await openRetentionTarget(tx,proof.read,paper,item);
    return {old,basis:proof.witnesses()};
  });
  // The old submissions are checked under this snapshot. Each new mount still
  // applies its own matching concepts, candidate set and frozen cutoff.
  const observations = memoWorkbookRead(async (paper: FactId,item: string,attempts: readonly string[]) => {
    const {old} = await oldTarget(paper,item);
    const proof = collect(reader,tx);
    const results = [];
    for (const id of attempts) results.push(await readWorkbookEvidence(tx,proof.read,old,factId(id)));
    return {results,basis:proof.witnesses()};
  });
  const followup = memoWorkbookRead(async (earlier: TraceAttempt,later: TraceAttempt) => {
    const proof = collect(reader,tx);
    const valid = await delayedSitting(tx,proof.read,earlier,later,readIssuance);
    return {valid,basis:proof.witnesses()};
  });
  return {open,oldTarget,observations,followup};
}

export function workbookBacktrace(tx: ReadTransaction, reader: Reader, facts: Parameters<typeof scopedKnowledgeEdges>[2]) {
  const reads = workbookBacktraceReads(tx,reader,facts);
  return (input: Input) => findWorkbookBacktrace(tx,input,reader,reads);
}

async function findWorkbookBacktrace(tx: ReadTransaction, input: Input, reader: Reader,
  {open,oldTarget,observations,followup}: ReturnType<typeof workbookBacktraceReads>) {
  const root = collect(reader, tx);
  try {
    const item = await openRetentionTarget(tx, root.read, factId(input.paper.id), input.itemId);
    if (item.source.ref.rev !== input.paper.rev || item.question.sourceQuestionRef?.id !== input.question.id ||
        item.question.sourceQuestionRef.rev !== input.question.rev) return null;
    const through = await cutoff(tx, item, input.attemptRef, root.read);
    if (!through) return null;
    const source = item.question.sourceQuestionRef;
    const links = memoWorkbookRead((ref: typeof source)=>readItemConceptLinks(tx,ref,through.observedThrough,open));
    const attempts = memoWorkbookRead((ref: Ref)=>earlierWorkbookTraceAttempts(tx,ref,through.observedThrough));
    const concepts = await links(source);
    if (!concepts.length) return null;
    const edges = await workbookLinkCandidates(tx, knowledgeEdgeType, source, through.observedThrough, ['variant_of'],'unspoiled-variant');
    const proofs: WorkbookTraceProof[] = [];
    for (const { id } of edges) {
      const graph = collect(reader, tx);
      const related = await stableQuestion(item,id,graph.read,open,attempts).catch(error => {
        if (!unavailable(error)) throw error;
      });
      if (!related) continue;
      for (const row of related.rows) {
        try {
          const paper = factId(row.paper);
          const {old,basis:targetBasis} = await oldTarget(paper,row.item);
          const ref = old.question.sourceQuestionRef;
          if (ref?.id !== related.oldQuestion.id || ref.rev !== related.oldQuestion.rev || old.question.prompt === item.question.prompt) continue;
          const shared = sharedWorkbookTraceConcepts(concepts,await links(ref));
          if (!shared.length) continue;
          const conceptIds = shared.map(({id})=>id);
          const {results,basis:observationBasis} = await observations(paper,row.item,row.attempts);
          const history: TraceAttempt[] = results.map(({observation,process}) => ({
            submission: { learner: tx.learner, ...observation.submission }, item: { paper: old.source.ref, itemId: row.item },
            images: [], help: process.exposure.kind === 'exposed' ? process.exposure.refs.map(ref => ({ learner: tx.learner, ...ref })) : [],
            occurredAt: observation.submittedAt, admittedAt: observation.admittedAt, conceptIds, mechanismIds: [],
            methodIds: [], outcome: observation.result, helpLevel: process.helpLevel,
          }));
          const candidate = [...graph.witnesses(),...targetBasis,...observationBasis];
          const { independentSuccesses: [later, earlier] } = backtrace({ learner: tx.learner, conceptIds, mechanismIds: [], methodIds: [], ...through }, history, candidate);
          if (!later || !earlier) continue;
          const {valid,basis:followupBasis} = await followup(earlier,later);
          const basis = collect(reader,tx,[...candidate,...followupBasis]).witnesses();
          if (!valid || !await workbookWitnessesBy(tx,basis,through.observedThrough)) continue;
          for (const concept of await workbookTraceConceptProofs(tx,reader,shared,unavailable)) {
            const witnesses = collect(reader,tx,[...root.witnesses(),...basis,...concept]).witnesses();
            proofs.push({text:old.question.prompt,content:{id:factId(ref.id),rev:ref.rev},witnesses});
          }
        } catch (error) {
          if (!unavailable(error)) throw error;
        }
      }
    }
    return proofs;
  } catch (error) {
    if (unavailable(error)) return null;
    throw error;
  }
}
