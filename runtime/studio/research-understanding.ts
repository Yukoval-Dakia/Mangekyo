import type { WorkerTariff } from '../../executors/teaching/research-worker.ts';
import type { WorkerConsent } from '../../modules/companion/worker-consent.ts';
import { workerCall, workerCap } from '../research/worker-dispatch.ts';
import { independentScoutSource, researchReader } from './research-sources.ts';
import { createHash } from 'node:crypto';
import {
  discoverUnderstandingTodos as discoverUnderstandingTodosSupport,
  eligibleExtraction as eligibleExtractionSupport,
  existingUnderstandings as existingUnderstandingsSupport,
  learnerGovernedSince as learnerGovernedSinceSupport,
  openUnderstandingActivity as openUnderstandingActivitySupport,
  openUnderstandingCitations as openUnderstandingCitationsSupport,
  paidSource as paidSourceSupport,
  readRadarTodo as readRadarTodoSupport,
  type ResearchHostDeps,
} from '../../modules/companion/research-host-support.ts';
import { createAuthorizedFactReader, isFactUnavailable } from './fact-read-helpers.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { cancelWork, failWork, finishWork, readReadyWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { runEffect } from '../../kernel/src/work/effects.ts';
import { completeTodo, endDispatchedTodo, readTodo, type TodoInput, type TodoSpec } from '../../kernel/src/work/todos.ts';
import { readActiveTodos } from '../../kernel/src/work/todo-reads.ts';
import { admittedActivityFragments, activityEvidenceTypes, bindLinkedCitationRead, citeQuestion, hasLinkedAttempt, questionOrigin, turnEvidenceType } from '../../modules/companion/activity-evidence.ts';
import { claimType, ClaimInputError } from '../../modules/companion/claim.ts';
import { memoryAssertionType } from '../../modules/companion/memory-assertion.ts';
import {
  conversationExtractionInstructions, extractionGoal, extractionKey, extractionInstructions, extractorProfile, extractedUnderstanding, extractUnderstandings, opensCitation,
  publishUnderstandingCommand, reviewUnderstanding, type ActivityCitation,
} from '../../modules/companion/understanding.ts';
import { researchPurpose } from '../../modules/companion/research.ts';
import { claimUndoToken, claimWitness } from './memory-claims.ts';
import { studyTurn, turnAllowsBackgroundUnderstanding } from '../../modules/activity/values.ts';
import { workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { posttestSubmissionType } from '../../modules/activity/retention-posttest.ts';
import { textbookPageType } from '../../modules/content/textbook-page.ts';
import { readActivitySubmissionBirth } from '../../modules/activity/learning-attempt-read.ts';
import { notionModelRecipient, purpose, slotType, stableId, studioLearner } from './identity.ts';
import { currentResearchSettings, whenAvailable } from './research-sources.ts';
import { workspaceGrantChecker } from './harness.ts';
import { companionTeachingMethods, completedCompanionTurns } from './research-foreground.ts';
import { textSlice } from './reading.ts';
import { resolveSource, type WorkspaceSourceRecipient } from './source-read.ts';
import type { WorkspaceWitness } from './workspace-agent.ts';
import { openWorkbookQuestionSources } from './workbook-diagnosis.ts';
import { undoTextbookCommand } from './workspace-textbook.ts';
import { createStudioCommandHooks } from './command-hooks.ts';

// A zero-cost host supplies an authorized route. A paid route requires budget admission first.
export type UnderstandingTransport = {
  route: string;
  cost: 0;
  maySend?: WorkspaceSourceRecipient;
  sample(request: { instructions: string; input: string; providerEffectId: string }): Promise<string>;
};
const windowMs = 86_400_000;
const mayResearch: WorkspaceSourceRecipient = fact =>
  fact.type === turnEvidenceType ? turnAllowsBackgroundUnderstanding(fact) : fact.purpose.includes(researchPurpose) || fact.purpose.includes('all');

// The priced route sends only an explicitly granted learner utterance or independently authored attempt.
export const paidExtractionRecipient: WorkspaceSourceRecipient = fact => fact.purpose.includes(researchPurpose) &&
  (fact.type === workbookAttemptType || fact.type === turnEvidenceType && turnAllowsBackgroundUnderstanding(fact));

const getUnderstandingHostDeps = () => ({
  mayResearch, paidExtractionRecipient, claimType, memoryAssertionType, whenAvailable, createAuthorizedFactReader,
  digest: (value: string) => createHash('sha256').update(value).digest('hex'), studyTurn,
  turnAllowsBackgroundUnderstanding, workbookAttemptType, posttestSubmissionType, readActivitySubmissionBirth,
  readActiveTodos: readActiveTodos as unknown as ResearchHostDeps['readActiveTodos'],
  resolveSource, openWorkbookQuestionSources, undoTextbookCommand, textSlice,
  researchReader, independentScoutSource, currentResearchSettings, workspaceGrantChecker, notionModelRecipient,
  teachingPurpose: purpose, teachingSlotType: slotType, companionTeachingMethods, completedCompanionTurns,
}) as unknown as ResearchHostDeps;

async function openUnderstandingActivity(tx: ReadTransaction, id: string, activePurpose = researchPurpose,
  recipient?: WorkspaceSourceRecipient, item?: string) {
  return openUnderstandingActivitySupport(getUnderstandingHostDeps(), tx, id, activePurpose, recipient, item);
}

export async function openUnderstandingCitations(tx: ReadTransaction, refs: readonly ActivityCitation[], activePurpose?: string,
  maySend?: WorkspaceSourceRecipient) {
  return openUnderstandingCitationsSupport(getUnderstandingHostDeps(), tx, refs, activePurpose, maySend);
}

export async function discoverUnderstandingTodos(tx: ReadTransaction, reviewed: Tick, settingsRevision: number, now: number, recipient?: WorkspaceSourceRecipient, budgetCap = 0) {
  return discoverUnderstandingTodosSupport(getUnderstandingHostDeps(), tx, reviewed, settingsRevision, now, recipient, budgetCap);
}

async function paidSource(tx: ReadTransaction, id: string) {
  return paidSourceSupport(getUnderstandingHostDeps(), tx, id);
}

export async function eligibleExtraction(tx: ReadTransaction, spec: TodoSpec, recipient?: WorkspaceSourceRecipient, budgetCap = 0,
  callerPurpose = researchPurpose) {
  return eligibleExtractionSupport(getUnderstandingHostDeps(), tx, spec as any, recipient, budgetCap, callerPurpose);
}

export async function readRadarTodo(tx: ReadTransaction, maySend: WorkspaceSourceRecipient, id?: string) {
  return readRadarTodoSupport(getUnderstandingHostDeps(), tx, maySend, id);
}

async function existingUnderstandings(tx: ReadTransaction, sourceId: string, recipient?: WorkspaceSourceRecipient) {
  return existingUnderstandingsSupport(getUnderstandingHostDeps(), tx, sourceId, recipient);
}
async function learnerGovernedSince(tx: ReadTransaction, tick: string, sourceId: string) {
  return learnerGovernedSinceSupport(getUnderstandingHostDeps(), tx, tick, sourceId);
}

export function openUnderstandingExtraction(db: Db, companion: LoadedModule, transport: UnderstandingTransport | undefined,
  paid?: {grant: WorkerConsent; tariff: WorkerTariff; signal: AbortSignal}) {
  if (!transport && !paid) return;
  const maySend = paid ? paidExtractionRecipient : transport?.maySend;
  const budgetCap = paid ? workerCap(paid.grant, paid.tariff) : 0;
  const route = paid?.grant.route ?? transport!.route;
  if (paid && (!budgetCap || paid.grant.profile !== extractorProfile)) return;
  if (transport && (!transport.route.trim() || transport.cost !== 0 || typeof transport.sample !== 'function'))
    throw new Error('个性化抽取只接受已授权的零成本模型传输。');
  return async function execute(ref: WorkRef, todoId: string, settingsCurrent: (tx: ReadTransaction, rev: number) => Promise<boolean>) {
    const scope = {learner: studioLearner};
    const prepare = async (tx: ReadTransaction) => {
      const todo = await readTodo(tx, todoId);
      if (todo?.state !== 'dispatched' || !await readReadyWork(tx, ref) ||
          !await settingsCurrent(tx, todo.spec.settingsRevision)) return null;
      const source = await eligibleExtraction(tx, todo.spec, maySend, budgetCap);
      if (!source || await learnerGovernedSince(tx, source.born, source.ref.id)) return null;
      const prior = paid || source.quoteOnly ? [] : await existingUnderstandings(tx, source.ref.id, maySend);
      const target = prior.map((entry: any) => ({id: entry.ref.id, kind: entry.data.kind, text: entry.data.text, scope: entry.data.scope, ttl: entry.data.ttl, directions: entry.directions}));
      const input = JSON.stringify({source: {ref: source.ref, kind: source.kind, fragments: source.fragments},
        considered_at: new Date(todo.spec.expiresAtMs - windowMs).toISOString(), ...(!source.quoteOnly ? {existing: target} : {})});
      return {todo, source, prior, input};
    };
    const cancel = () => cancelWork(db, ref, tx => endDispatchedTodo(tx, todoId, 'cancelled'));
    const fail = () => failWork(db, ref, tx => endDispatchedTodo(tx, todoId, 'failed'));
    const prepared = await db.snapshot(scope, prepare);
    if (!prepared) {
      const current = await db.snapshot(scope, tx => readTodo(tx, todoId));
      if (current?.state === 'completed') await finishWork(db, ref);
      else await cancel();
      return;
    }
    const matches = async (tx: ReadTransaction) => {
      const current = await prepare(tx);
      if (current?.input !== prepared.input || current.source.basisDigest !== prepared.source.basisDigest ||
          JSON.stringify(current.prior) !== JSON.stringify(prepared.prior))
        throw new ClaimInputError('抽取活动或既有理解已变更。');
    };
    try {
      const {todo, source, prior, input} = prepared;
      const readOutput = (raw: string) => extractUnderstandings(raw, source, todo.spec.expiresAtMs - windowMs, prior);
      const instructions = source.quoteOnly ? conversationExtractionInstructions : extractionInstructions;
      const effect = paid ? {kind:'done' as const, result:readOutput(await workerCall(db, todoId, source.ref.id, paid.grant,
        paid.tariff, matches, paid.signal).call('extract', instructions, input))} : await runEffect(db, {...scope, ownerKind: 'derivation', ownerId: todoId, stepKey: 'extraction-v1',
        label: 'model:' + route, input: {instructions, input,
          ...(source.basisDigest ? {basis: source.basisDigest} : {})}}, async (providerEffectId, checkDispatch) => {
        // Protect admission and starting the send, then release the learner lock while the host awaits the reply.
        const {response} = await db.tx(scope, async tx => {
          await lockLearner(tx, tx.learner);
          await checkDispatch(tx);
          await matches(tx);
          const response = transport!.sample({instructions, input, providerEffectId});
          void response.catch(() => {});
          return {response};
        });
        return readOutput(await response);
      }, matches);
      if (effect.kind !== 'done') return void await fail();
      const parsed = readOutput(JSON.stringify({entries: (effect.result as ReturnType<typeof extractUnderstandings>)
        .map(({target, data}) => ({target, ...data}))}));
      if (!parsed.length) return void await cancel();

      const command = commandId(stableId('publish-understanding-v1', todoId));
      const entries = parsed.map(({target, data}, index) => {
        const previous = target && prior.find((entry: any) => entry.ref.id === target);
        const id = factId(target ?? stableId('extracted-understanding-v1', source.ref.id, String(source.ref.rev),
          ...(todo.spec.sourceFactRev.anchor ? [todo.spec.sourceFactRev.anchor] : []), String(index)));
        return {id, prior: previous ? previous.ref : null, data: {...data, version: 2 as const, sticky: false,
          evidence_refs: [...(previous ? previous.data.evidence_refs : []), ...data.evidence_refs.map(ref =>
            source.basisDigest ? {...ref, basis_digest: source.basisDigest,
              ...questionOrigin(source, ref.anchor, route)} : ref)],
          undo_token: previous ? previous.data.undo_token : factId(claimUndoToken(command, id))}};
      });

      const handle = createCommandHandler(db, {modules: [companion],
        bindCommandRead: (tx, _, base) => bindLinkedCitationRead(base, async citation => {
          if (citation.question_evidence && citation.question_evidence.recipient !== route) return;
          if (!(await openUnderstandingCitations(tx, [citation], researchPurpose, maySend)).length) return;
          return {teaching: !!(await openUnderstandingCitations(tx, [citation], 'teaching', maySend)).length};
        }), hooks: createStudioCommandHooks({ async afterFactsChanged(tx, tick) {
        // The command has already written its revisions. Revalidate source/consent without rereading revised targets.
        const current = await readTodo(tx, todoId);
        const citations = entries.flatMap(entry => entry.data.evidence_refs);
        if (current?.revision !== todo.revision || !await readReadyWork(tx, ref) ||
            !await settingsCurrent(tx, todo.spec.settingsRevision) || !await eligibleExtraction(tx, todo.spec, maySend, budgetCap) ||
            (await openUnderstandingCitations(tx, citations, researchPurpose, maySend)).length !== citations.length ||
            await learnerGovernedSince(tx, source.born, source.ref.id) ||
            !await completeTodo(tx, tick, ref, current, entries[0]!.id)) throw new ClaimInputError('抽取工作已失效。');
      } }) });
      await handle({...scope, id: command, type: publishUnderstandingCommand, actor: 'companion',
        purpose: researchPurpose, input: {entries}});
      await finishWork(db, ref);
    } catch (error) {
      if (!(error instanceof ClaimInputError || isFactUnavailable(error) ||
          error instanceof Error && error.message === 'Effect identity already used with different input')) throw error;
      await cancel();
    }
  };
}
