import { FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { ReadContext } from '../../kernel/src/declarations/types.ts';
import type { BusWitness } from '../../kernel/src/pipeline-contracts.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { workbookLinkCandidates, workbookWitnessesBy } from '../../modules/activity/evidence-read.ts';
import {
  confirmWorkbookTraceBasis, earlierWorkbookTraceAttempts, isFrozenWorkbookFollowup, readWorkbookFollowupForecast, workbookTraceCutoff as cutoff,
  workbookWitnessReader as collect, WorkbookTraceReadError,
} from '../../modules/activity/workbook-backtrace-values.ts';
import { workbookAttempt } from '../../modules/activity/workbook-values.ts';
import { knowledgeEdgeType } from '../../modules/content/knowledge-edge.ts';
import { backtrace, type TraceAttempt } from '../../modules/learner/retention-backtrace.ts';
import { forecastType, readAnyRetentionMethod, type RetentionForecast } from '../../modules/learner/retention.ts';
import { openKnowledgeEdge } from './knowledge-graph.ts';
import { openRetentionTarget, readItemDimensions, readWorkbookEvidence, retentionPurpose } from './retention-workbook.ts';
import { posttestAttemptFor, posttestIdFor, readPosttestIssuance } from './retention-posttest.ts';
import { retentionHistoryValid } from './retention.ts';
import { RequestError } from './sessions.ts';

type Ref = { id: string; rev: number };
type Input = { paper: Ref; itemId: string; question: Ref; attemptRef?: Ref };
type Reader = Pick<ReadContext, 'fact'>;
function unavailable(error: unknown) {
  return error instanceof FactNotFoundError || error instanceof FactReadDeniedError ||
    error instanceof WorkbookTraceReadError || error instanceof RequestError;
}

type Opened = Awaited<ReturnType<typeof openRetentionTarget>>;
async function delayedSitting(tx: ReadTransaction, read: Reader, earlier: TraceAttempt, later: TraceAttempt) {
  const submission = await read.fact(later.submission.id, { mode: 'following' });
  const { issuance, fact } = await readPosttestIssuance(tx, read, factId(workbookAttempt(submission.value).paperId));
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

async function stableQuestion(tx: ReadTransaction, item: Opened, edgeId: string, through: NonNullable<Awaited<ReturnType<typeof cutoff>>>,
  read: Reader, open: (id: string) => ReturnType<typeof openKnowledgeEdge>) {
  const edge = await open(edgeId);
  if (!edge || edge.value.kind !== 'variant_of' || edge.value.variant?.spoilsNext !== 'none') return;
  for (const [fact, mode] of edge.opened) {
    const opened = await read.fact(fact.ref.id, mode === 'following' ? { mode } : { mode: 'pinned', rev: fact.ref.rev });
    if (opened.ref.rev !== fact.ref.rev || opened.accessEpoch !== fact.accessEpoch) return;
  }
  const from = edge.value.from.fact, to = edge.value.to.fact, question = item.question.sourceQuestionRef!;
  const same = (ref: Ref) => ref.id === question.id && ref.rev === question.rev;
  const oldQuestion = same(from) ? to : same(to) ? from : undefined;
  if (!oldQuestion || oldQuestion.id === question.id) return;
  return { oldQuestion, rows: await earlierWorkbookTraceAttempts(tx,oldQuestion,through.observedThrough) };
}

export async function workbookBacktrace(tx: ReadTransaction, input: Input, reader: Reader, check: Reader) {
  const open = (id: string) => openKnowledgeEdge(tx,id,{recipient:'workspace',purpose:retentionPurpose,maySend:() => true,
    readNotionWitness: fact => reader.fact(fact.ref.id,{mode:'pinned',rev:fact.ref.rev})});
  const root = collect(reader, tx);
  try {
    const item = await openRetentionTarget(tx, root.read, factId(input.paper.id), input.itemId);
    if (item.source.ref.rev !== input.paper.rev || item.question.sourceQuestionRef?.id !== input.question.id ||
        item.question.sourceQuestionRef.rev !== input.question.rev) return null;
    const through = await cutoff(tx, item, input.attemptRef, root.read);
    if (!through) return null;
    const source = item.question.sourceQuestionRef;
    const conceptIds = await readItemDimensions(tx, root.read, source, through.observedThrough,open);
    if (!conceptIds.length) return null;
    const edges = await workbookLinkCandidates(tx, knowledgeEdgeType, source, through.observedThrough, ['variant_of'],'unspoiled-variant');
    const matches = new Map<string, {text:string; content:{id:FactId; rev:Revision}; witnesses:readonly BusWitness[]}>();
    for (const { id } of edges) {
      const graph = collect(reader, tx);
      const related = await stableQuestion(tx, item, id, through, graph.read, open).catch(error => {
        if (!unavailable(error)) throw error;
      });
      if (!related) continue;
      for (const row of related.rows) {
        const candidate = collect(reader, tx, graph.witnesses());
        try {
          const old = await openRetentionTarget(tx, candidate.read, factId(row.paper), row.item);
          const ref = old.question.sourceQuestionRef;
          if (ref?.id !== related.oldQuestion.id || ref.rev !== related.oldQuestion.rev || old.question.prompt === item.question.prompt) continue;
          const oldConcepts = await readItemDimensions(tx, candidate.read, ref, through.observedThrough,open);
          const history: TraceAttempt[] = [];
          for (const id of row.attempts) {
            const { observation, process } = await readWorkbookEvidence(tx, candidate.read, old, factId(id));
            history.push({ submission: { learner: tx.learner, ...observation.submission }, item: { paper: old.source.ref, itemId: row.item },
              images: [], help: process.exposure.kind === 'exposed' ? process.exposure.refs.map(ref => ({ learner: tx.learner, ...ref })) : [],
              occurredAt: observation.submittedAt, admittedAt: observation.admittedAt, conceptIds: oldConcepts, mechanismIds: [],
              methodIds: [], outcome: observation.result, helpLevel: process.helpLevel });
          }
          const { independentSuccesses: [later, earlier] } = backtrace({ learner: tx.learner, conceptIds, mechanismIds: [], methodIds: [], ...through }, history, candidate.witnesses());
          const key = ref.id + ':' + ref.rev;
          if (matches.has(key) || !later || !earlier || !await delayedSitting(tx,candidate.read,earlier,later) ||
              !await workbookWitnessesBy(tx,candidate.witnesses(),through.observedThrough)) continue;
          const witnesses = await confirmWorkbookTraceBasis(check,tx,root.witnesses(),candidate.witnesses());
          if (witnesses) matches.set(key,{text:old.question.prompt,content:{id:factId(ref.id),rev:ref.rev},witnesses});
        } catch (error) {
          if (!unavailable(error)) throw error;
        }
      }
    }
    return matches.size === 1 ? matches.values().next().value! : null;
  } catch (error) {
    if (unavailable(error)) return null;
    throw error;
  }
}
