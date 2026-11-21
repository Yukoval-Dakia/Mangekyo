import type { WorkerTariff } from '../../executors/teaching/research-worker.ts';
import type { WorkerConsent } from '../../modules/companion/worker-consent.ts';
import { workerCall, workerCap } from '../research/worker-dispatch.ts';
import { independentScoutSource, researchReader } from './research-sources.ts';
import { createHash } from 'node:crypto';
import { createAuthorizedFactReader, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
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
import { readActivitySubmissionBirth } from './learning-attempt-read.ts';
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

async function openUnderstandingActivity(tx: ReadTransaction, id: string, purpose = researchPurpose,
  recipient?: WorkspaceSourceRecipient, item?: string) {
  const maySend = recipient ?? mayResearch;
  const allows = Object.assign((fact: Parameters<WorkspaceSourceRecipient>[0]) => mayResearch(fact) && maySend(fact),
    {notionRecipientId: maySend.notionRecipientId ?? ''});
  const reader = createAuthorizedFactReader(tx, purpose, allows);
  const fact = await whenAvailable(() => reader.fact(factId(id), {mode: 'following'}));
  if (!fact) return null;
  // A permission change keeps the body, and an undo restores the body from its recorded revision.
  const {rows: [provenance]} = await tx.query<{ author: string | null; born: Tick }>(`
    SELECT CASE WHEN origin.type=$4 THEN NULL ELSE last.author END AS author,f.created_tick::text AS born
    FROM facts f JOIN LATERAL (
      WITH RECURSIVE body AS (
        SELECT rev,data,author,command_id FROM fact_revs
        WHERE (learner_id,fact_id,rev)=(f.learner_id,f.id,f.current_rev)
        UNION ALL
        SELECT previous.rev,previous.data,previous.author,previous.command_id FROM body
        LEFT JOIN commands c ON (c.learner_id,c.id)=(f.learner_id,body.command_id)
        JOIN fact_revs previous ON (previous.learner_id,previous.fact_id)=(f.learner_id,f.id)
          AND previous.rev=CASE WHEN c.type=$4 THEN (c.input#>>'{input,priorRev}')::int ELSE body.rev-1 END
        WHERE f.type=$3 AND previous.rev<body.rev AND previous.kind='value' AND previous.data=body.data
      ) SELECT author,command_id FROM body ORDER BY rev LIMIT 1
    ) last ON true
    LEFT JOIN commands origin ON (origin.learner_id,origin.id)=(f.learner_id,last.command_id)
    WHERE f.learner_id=$1 AND f.id=$2`, [tx.learner, id, textbookPageType, undoTextbookCommand]);
  if (provenance?.author !== 'learner') return null;
  const ref = claimWitness(fact);
  const basis: WorkspaceWitness[] = [{id: ref.id, rev: ref.rev, epoch: ref.accessEpoch, type: fact.type, mode:'following'}];
  const track = (source: typeof fact, mode: 'following' | 'pinned' = 'following') => {
    if (source.ref.id !== ref.id || source.ref.rev !== ref.rev)
      basis.push({id:source.ref.id, rev:source.ref.rev, epoch:source.accessEpoch, type:source.type, mode});
  };
  const access = {purpose, maySend:allows, track};
  if (fact.type === textbookPageType && !await resolveSource(tx, id, {recipient:'workspace', ...access}, 'following')) return null;
  // Research defines the stable citation basis. Every subsequent caller also opens the chain for its own purpose.
  const explicit = Object.assign((dependency: typeof fact) => dependency.purpose.includes(researchPurpose) && maySend(dependency),
    {notionRecipientId: maySend.notionRecipientId ?? ''});
  const opened = item && recipient && fact.purpose.includes(researchPurpose) && fact.purpose.includes(purpose) && hasLinkedAttempt(fact)
    ? await openWorkbookQuestionSources(tx, fact, {purpose: researchPurpose, maySend: explicit, track}, item) : undefined;
  if (item && !opened) return null;
  const dependencies = basis.slice(1);
  if (opened && purpose !== researchPurpose) {
    basis.splice(1);
    if (!await openWorkbookQuestionSources(tx, fact, {purpose, maySend, track}, item)) return null;
  }
  if (dependencies.length) {
    // A pinned snapshot exposes its historical purposes. Research also requires a current grant.
    const ids = [...new Set(dependencies.map(witness => witness.id))];
    const {rowCount} = await tx.query(`
      SELECT id FROM facts WHERE learner_id=$1 AND id=ANY($2::text[])
        AND retracted_rev IS NULL AND CASE WHEN $4 THEN purpose @> ARRAY[$3,$5] ELSE purpose && ARRAY[$3,'all'] END`,
      [tx.learner, ids, researchPurpose, !!opened, purpose]);
    if (rowCount !== ids.length) return null;
  }
  const basisDigest = dependencies.length
    ? createHash('sha256').update(JSON.stringify(dependencies)).digest('hex')
    : undefined;
  const activity = admittedActivityFragments(fact, item);
  if (!activity) return null;
  if ((fact.type === workbookAttemptType || fact.type === posttestSubmissionType) &&
      !await readActivitySubmissionBirth(tx, fact.ref, fact.type)) return null;
  const fragments = activity.quoteOnly ? activity.fragments.map(fragment => ({
    ...fragment, text: textSlice(fragment.text, 0, 1200).content,
  })) : activity.fragments;
  return {...activity, fact, ref, basis, basisDigest, fragments, paper: opened?.paper, ...provenance};
}

export async function openUnderstandingCitations(tx: ReadTransaction, refs: readonly ActivityCitation[], purpose?: string,
  maySend?: WorkspaceSourceRecipient) {
  const recipient = maySend ?? (purpose === 'storage' ? () => true : undefined);
  const sources = await Promise.all(refs.map(ref => openUnderstandingActivity(tx, ref.id, purpose, recipient, ref.question_evidence ? ref.anchor : undefined)));
  return sources.flatMap((source, index) => {
    const ref = refs[index]!;
    if (source && JSON.stringify(citeQuestion(source, ref.anchor, ref.question_evidence?.recipient ?? '')) !==
        JSON.stringify(ref.question_evidence)) return [];
    return source && source.basisDigest === ref.basis_digest && opensCitation(source, ref) ? [source] : [];
  });
}

export async function discoverUnderstandingTodos(tx: ReadTransaction, reviewed: Tick, settingsRevision: number, now: number, recipient?: WorkspaceSourceRecipient, budgetCap = 0) {
  const {rows} = await tx.query<{ id: string; anchor: string | null }>(`
    SELECT f.id, item.anchor FROM facts f
    JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    CROSS JOIN LATERAL (SELECT NULL::text AS anchor UNION ALL
      SELECT q->>'id' FROM jsonb_array_elements(r.data#>'{paper,questions}') q WHERE f.type=$8 AND q ? 'sourceQuestionRef') item
    LEFT JOIN (${completedCompanionTurns}) done ON f.type=$7 AND done.id=f.id
    WHERE f.learner_id=$1 AND f.type=ANY($4::text[]) AND f.retracted_rev IS NULL
      AND f.purpose && ARRAY[$5,'all'] AND (f.type<>$7 OR
        (done.id IS NOT NULL AND r.data->'allowBackgroundUnderstanding'='true'::jsonb AND $5=ANY(f.purpose)))
      AND (GREATEST(f.changed_tick,done.effective_tick)>$6::bigint OR item.anchor IS NOT NULL AND EXISTS (
        SELECT 1 FROM facts dep WHERE dep.learner_id=f.learner_id AND dep.changed_tick>$6::bigint
          AND (dep.id=r.data->>'paperId' OR jsonb_path_exists(r.data,
            '$.paper.questions[*].sourceQuestionRef.id ? (@ == $id)', jsonb_build_object('id',dep.id)))))
      AND NOT EXISTS (SELECT 1 FROM work t WHERE t.family='todo' AND t.learner_id=f.learner_id
        AND t.dedup_key='understanding:'||f.id||':'||CASE WHEN f.type=$7 THEN 1 ELSE f.current_rev END||COALESCE(':question:'||item.anchor,''))
    ORDER BY GREATEST(f.changed_tick,done.effective_tick),f.id,item.anchor`,
    [tx.learner, slotType, companionTeachingMethods, activityEvidenceTypes, researchPurpose, reviewed, turnEvidenceType, workbookAttemptType]);
  const todos: TodoInput[] = [];
  for (const row of rows) {
    const source = await openUnderstandingActivity(tx, row.id, researchPurpose, recipient, row.anchor ?? undefined);
    if (!source || budgetCap && !await paidSource(tx, row.id)) continue;
    todos.push({dedupKey: extractionKey(source.ref.id, source.quoteOnly ? 1 : source.ref.rev, row.anchor ?? undefined), trigger: {kind: 'immediate'},
      workerProfile: extractorProfile, goal: extractionGoal, refs: [],
      sourceFactRev: {id: source.ref.id, revision: source.ref.rev, accessEpoch: source.ref.accessEpoch, ...(row.anchor ? {anchor: row.anchor} : {})},
      autonomyTier: 2, budgetCap, settingsRevision, expiresAtMs: now + windowMs});
    if (todos.length === 12) break;
  }
  return todos;
}

async function paidSource(tx: ReadTransaction, id: string) {
  const fact = await whenAvailable(() => researchReader(tx).fact(factId(id), {mode:'following'}));
  return fact && paidExtractionRecipient(fact) && (fact.type !== workbookAttemptType || await independentScoutSource(tx, fact));
}

export async function eligibleExtraction(tx: ReadTransaction, spec: TodoSpec, recipient?: WorkspaceSourceRecipient, budgetCap = 0,
  callerPurpose = researchPurpose) {
  const {id, revision, accessEpoch} = spec.sourceFactRev;
  const item = spec.sourceFactRev.anchor;
  if (spec.workerProfile !== extractorProfile || spec.goal !== extractionGoal || spec.budgetCap !== budgetCap || budgetCap && !await paidSource(tx, id) ||
      spec.autonomyTier !== 2 || spec.expiresAtMs <= Date.now()) return null;
  const source = await openUnderstandingActivity(tx, id, callerPurpose, recipient, item);
  if (source?.ref.rev !== revision || source.ref.accessEpoch !== accessEpoch || spec.dedupKey !== extractionKey(id, source.quoteOnly ? 1 : revision, item)) return null;
  if (source.kind === 'conversation' && (!source.quoteOnly ||
      !(await tx.query(`${completedCompanionTurns} AND s.slot_key=$4`, [tx.learner, slotType, companionTeachingMethods, id])).rowCount)) return null;
  return source;
}

export async function readRadarTodo(tx: ReadTransaction, maySend: WorkspaceSourceRecipient, id?: string) {
  const recipient = maySend.notionRecipientId;
  if (!recipient) return;
  const settings = await currentResearchSettings(tx);
  if (!settings?.enabled) return;
  const grantCurrent = workspaceGrantChecker();
  const teachingRecipient: WorkspaceSourceRecipient = fact => {
    if (fact.type !== turnEvidenceType || !fact.purpose.includes(purpose) || !maySend(fact)) return false;
    const turn = studyTurn(fact.value);
    return Boolean(turn.accountRevision && turn.providerId && turn.protocol && turn.workspaceRevision &&
      notionModelRecipient(turn.providerId, turn.baseUrl, turn.protocol, turn.model, turn.workspaceRevision) === recipient);
  };
  for await (const {spec, ...work} of readActiveTodos(tx, extractorProfile, id)) {
    const source = spec.sourceFactRev;
    if (spec.settingsRevision !== settings.revision || spec.trigger.kind !== 'immediate' ||
        spec.refs.length || source.anchor || spec.parentTodoId) continue;
    const eligible = await eligibleExtraction(tx, spec, teachingRecipient, 0, purpose);
    if (eligible?.kind !== 'conversation' || !await grantCurrent(studyTurn(eligible.fact.value))) continue;
    return {fact:eligible.fact, basis:{...work, source, settingsRev:settings.revision, settingsEpoch:settings.accessEpoch, recipient},
      view:{state:'available', item:{kind:extractorProfile, state:work.state}}};
  }
  return undefined;
}

async function existingUnderstandings(tx: ReadTransaction, sourceId: string, recipient?: WorkspaceSourceRecipient) {
  const {rows} = await tx.query<{id: string}>(`
    SELECT f.id FROM facts f JOIN fact_revs r
      ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND NOT f.sticky
      AND f.purpose && ARRAY[$3,'all'] AND r.data->>'version'='2' AND r.data->>'sticky'='false'
      AND (r.data->'scope'->>'kind'='general' OR r.data->'scope'->>'object'=$4)
    ORDER BY f.changed_tick DESC,f.id LIMIT 6`, [tx.learner, memoryAssertionType, researchPurpose, sourceId]);
  const entries = [];
  for (const row of rows) {
    const fact = await whenAvailable(() => createAuthorizedFactReader(tx, researchPurpose, recipient ?? mayResearch).fact(factId(row.id), {mode: 'following'}));
    if (!fact) continue;
    const data = extractedUnderstanding(fact.value);
    if (data.ttl && data.ttl <= new Date().toISOString()) continue;
    const sources = await openUnderstandingCitations(tx, data.evidence_refs, researchPurpose, recipient);
    if (sources.length !== data.evidence_refs.length) continue;
    const review = reviewUnderstanding(fact.ref.id, data, sources);
    const directions = review.kind === 'value' ? review.value.findings : null;
    entries.push({ref: claimWitness(fact), data, directions});
  }
  return entries;
}

async function learnerGovernedSince(tx: ReadTransaction, tick: string, sourceId: string) {
  // A delayed activity must not recreate a learner-managed understanding by paraphrasing it.
  // Use the existing revision audit, including retractions and teaching-purpose corrections.
  const {rowCount} = await tx.query(`
    SELECT 1 FROM facts f JOIN fact_revs r
    ON (f.learner_id,f.id,f.current_rev)=(r.learner_id,r.fact_id,r.rev)
    WHERE f.learner_id=$1 AND f.type=ANY($2::text[])
      AND ((r.author='learner' AND f.changed_tick>$3::bigint)
        OR (f.type=$4 AND r.data#>>'{evidence_refs,0,id}'=$5))
    LIMIT 1`, [tx.learner, [claimType, memoryAssertionType, 'learner.preference'], tick, claimType, sourceId]);
  return Boolean(rowCount);
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
      const target = prior.map(({ref, data: {kind, text, scope, ttl}, directions}) => ({id: ref.id, kind, text, scope, ttl, directions}));
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
        const previous = target && prior.find(entry => entry.ref.id === target);
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
      if (!(error instanceof ClaimInputError || error instanceof FactNotFoundError || error instanceof FactReadDeniedError ||
          error instanceof Error && error.message === 'Effect identity already used with different input')) throw error;
      await cancel();
    }
  };
}
