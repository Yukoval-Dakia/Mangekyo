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
import { activityEvidence, activityEvidenceTypes, turnEvidenceType } from '../../modules/companion/activity-evidence.ts';
import { claimType, ClaimInputError } from '../../modules/companion/claim.ts';
import { memoryAssertionType } from '../../modules/companion/memory-assertion.ts';
import {
  conversationExtractionInstructions, extractionGoal, extractionInstructions, extractorProfile, extractedUnderstanding, extractUnderstandings, opensCitation,
  publishUnderstandingCommand, reviewUnderstanding, type ActivityCitation,
} from '../../modules/companion/understanding.ts';
import { researchPurpose } from '../../modules/companion/research.ts';
import { claimUndoToken, claimWitness } from './memory-claims.ts';
import { workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { posttestSubmissionType } from '../../modules/activity/retention-posttest.ts';
import { textbookPageType } from '../../modules/content/textbook-page.ts';
import { readActivitySubmissionBirth } from './learning-attempt-read.ts';
import { methodName, slotType, stableId, studioLearner } from './identity.ts';
import { whenAvailable } from './research-sources.ts';
import { completedCompanionTurns } from './research-foreground.ts';
import { textSlice } from './reading.ts';
import { resolveSource, type WorkspaceSourceRecipient } from './source-read.ts';
import type { WorkspaceWitness } from './workspace-agent.ts';
import { undoTextbookCommand } from './workspace-textbook.ts';

// A zero-cost host supplies an authorized route. A paid route requires budget admission first.
export type UnderstandingTransport = {
  route: string;
  cost: 0;
  sample(request: { instructions: string; input: string; providerEffectId: string }): Promise<string>;
};
const windowMs = 86_400_000;
const mayResearch: WorkspaceSourceRecipient = fact =>
  fact.purpose.includes(researchPurpose) || (fact.type !== turnEvidenceType && fact.purpose.includes('all'));
const sourceReader = (tx: ReadTransaction, purpose: string) => createAuthorizedFactReader(tx, purpose, mayResearch);

async function openUnderstandingActivity(tx: ReadTransaction, id: string, purpose = researchPurpose,
  maySend: WorkspaceSourceRecipient = mayResearch) {
  const allows: WorkspaceSourceRecipient = fact => mayResearch(fact) && maySend(fact);
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
  if (fact.type === textbookPageType) {
    const page = await resolveSource(tx, id, {recipient:'workspace', purpose, maySend:allows, track(source, mode) {
      if (source.ref.id === ref.id && source.ref.rev === ref.rev) return;
      basis.push({id:source.ref.id, rev:source.ref.rev, epoch:source.accessEpoch, type:source.type, mode:mode ?? 'following'});
    }}, 'following');
    if (!page) return null;
  }
  const dependencies = basis.slice(1);
  if (dependencies.length) {
    // A pinned snapshot exposes its historical purposes. Research also requires a current grant.
    const ids = [...new Set(dependencies.map(witness => witness.id))];
    const {rowCount} = await tx.query(`
      SELECT id FROM facts WHERE learner_id=$1 AND id=ANY($2::text[])
        AND retracted_rev IS NULL AND purpose && ARRAY[$3,'all']`, [tx.learner, ids, researchPurpose]);
    if (rowCount !== ids.length) return null;
  }
  const basisDigest = dependencies.length
    ? createHash('sha256').update(JSON.stringify(dependencies)).digest('hex')
    : undefined;
  const activity = activityEvidence(fact);
  if (!activity) return null;
  if ((fact.type === workbookAttemptType || fact.type === posttestSubmissionType) &&
      !await readActivitySubmissionBirth(tx, fact.ref, fact.type)) return null;
  const fragments = activity.fragments.filter(fragment => fragment.text.trim()).slice(0, 12).map(fragment => ({
    ...fragment, text: activity.quoteOnly ? textSlice(fragment.text, 0, 1200).content : fragment.text.slice(0, 1200).toWellFormed(),
    ...(fragment.prompt ? {prompt: fragment.prompt.slice(0, 350).toWellFormed()} : {}),
  }));
  return fragments.length ? {...activity, ref, basis, basisDigest, fragments, ...provenance} : null;
}

export async function openUnderstandingCitations(tx: ReadTransaction, refs: readonly ActivityCitation[], purpose?: string,
  maySend?: WorkspaceSourceRecipient) {
  const sources = await Promise.all(refs.map(ref => openUnderstandingActivity(tx, ref.id, purpose, maySend)));
  return sources.flatMap((source, index) => {
    const ref = refs[index]!;
    return source && source.basisDigest === ref.basis_digest && opensCitation(source, ref) ? [source] : [];
  });
}

function extractionKey(source: NonNullable<Awaited<ReturnType<typeof openUnderstandingActivity>>>) {
  return `understanding:${source.ref.id}:${source.quoteOnly ? 1 : source.ref.rev}`;
}

export async function discoverUnderstandingTodos(tx: ReadTransaction, reviewed: Tick, settingsRevision: number, now: number) {
  const {rows} = await tx.query<{ id: string }>(`
    WITH eligible AS (
      SELECT f.id,CASE WHEN f.type=$7 THEN GREATEST(done.effective_tick,f.changed_tick)
        ELSE f.changed_tick END AS seen FROM facts f
      JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      LEFT JOIN (${completedCompanionTurns}) done ON f.type=$7 AND done.id=f.id
      WHERE f.learner_id=$1 AND f.type=ANY($4::text[]) AND f.retracted_rev IS NULL
        AND f.purpose && ARRAY[$5,'all'] AND (f.type<>$7 OR
          (done.id IS NOT NULL AND r.data->'allowBackgroundUnderstanding'='true'::jsonb AND $5=ANY(f.purpose)))
        AND NOT EXISTS (SELECT 1 FROM work t WHERE t.family='todo' AND t.learner_id=f.learner_id
          AND t.dedup_key='understanding:'||f.id||':'||CASE WHEN f.type=$7 THEN 1 ELSE f.current_rev END)
    ) SELECT id FROM eligible WHERE seen>$6::bigint ORDER BY eligible.seen,id`,
    [tx.learner, slotType, methodName, activityEvidenceTypes, researchPurpose, reviewed, turnEvidenceType]);
  const todos: TodoInput[] = [];
  for (const row of rows) {
    const source = await openUnderstandingActivity(tx, row.id);
    if (!source) continue;
    todos.push({dedupKey: extractionKey(source), trigger: {kind: 'immediate'},
      workerProfile: extractorProfile, goal: extractionGoal, refs: [],
      sourceFactRev: {id: source.ref.id, revision: source.ref.rev, accessEpoch: source.ref.accessEpoch},
      autonomyTier: 2, budgetCap: 0, settingsRevision, expiresAtMs: now + windowMs});
    if (todos.length === 12) break;
  }
  return todos;
}

export async function eligibleExtraction(tx: ReadTransaction, spec: TodoSpec) {
  const {id, revision, accessEpoch} = spec.sourceFactRev;
  if (spec.workerProfile !== extractorProfile || spec.goal !== extractionGoal || spec.budgetCap !== 0 ||
      spec.autonomyTier !== 2 || spec.expiresAtMs <= Date.now()) return null;
  const source = await openUnderstandingActivity(tx, id);
  if (source?.ref.rev !== revision || source.ref.accessEpoch !== accessEpoch || spec.dedupKey !== extractionKey(source)) return null;
  if (source.kind === 'conversation' && (!source.quoteOnly ||
      !(await tx.query(`${completedCompanionTurns} AND s.slot_key=$4`, [tx.learner, slotType, methodName, id])).rowCount)) return null;
  return source;
}

async function existingUnderstandings(tx: ReadTransaction, sourceId: string) {
  const {rows} = await tx.query<{id: string}>(`
    SELECT f.id FROM facts f JOIN fact_revs r
      ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND NOT f.sticky
      AND f.purpose && ARRAY[$3,'all'] AND r.data->>'version'='2' AND r.data->>'sticky'='false'
      AND (r.data->'scope'->>'kind'='general' OR r.data->'scope'->>'object'=$4)
    ORDER BY f.changed_tick DESC,f.id LIMIT 6`, [tx.learner, memoryAssertionType, researchPurpose, sourceId]);
  const entries = [];
  for (const row of rows) {
    const fact = await whenAvailable(() => sourceReader(tx, researchPurpose).fact(factId(row.id), {mode: 'following'}));
    if (!fact) continue;
    const data = extractedUnderstanding(fact.value);
    if (data.ttl && data.ttl <= new Date().toISOString()) continue;
    const sources = await openUnderstandingCitations(tx, data.evidence_refs);
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

export function openUnderstandingExtraction(db: Db, companion: LoadedModule, transport: UnderstandingTransport | undefined) {
  if (!transport) return;
  if (!transport.route.trim() || transport.cost !== 0 || typeof transport.sample !== 'function')
    throw new Error('个性化抽取只接受已授权的零成本模型传输。');
  return async function execute(ref: WorkRef, todoId: string, settingsCurrent: (tx: ReadTransaction, rev: number) => Promise<boolean>) {
    const scope = {learner: studioLearner};
    const prepare = async (tx: ReadTransaction) => {
      const todo = await readTodo(tx, todoId);
      if (todo?.state !== 'dispatched' || !await readReadyWork(tx, ref) ||
          !await settingsCurrent(tx, todo.spec.settingsRevision)) return null;
      const source = await eligibleExtraction(tx, todo.spec);
      if (!source || await learnerGovernedSince(tx, source.born, source.ref.id)) return null;
      const prior = source.quoteOnly ? [] : await existingUnderstandings(tx, source.ref.id);
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
      const effect = await runEffect(db, {...scope, ownerKind: 'derivation', ownerId: todoId, stepKey: 'extraction-v1',
        label: 'model:' + transport.route, input: {instructions, input,
          ...(source.basisDigest ? {basis: source.basisDigest} : {})}}, async providerEffectId => {
        // Protect admission and starting the send, then release the learner lock while the host awaits the reply.
        const {response} = await db.tx(scope, async tx => {
          await lockLearner(tx, tx.learner);
          await matches(tx);
          const response = transport.sample({instructions, input, providerEffectId});
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
        const id = factId(target ?? stableId('extracted-understanding-v1', source.ref.id, String(source.ref.rev), String(index)));
        return {id, prior: previous ? previous.ref : null, data: {...data, version: 2 as const, sticky: false,
          evidence_refs: [...(previous ? previous.data.evidence_refs : []), ...data.evidence_refs.map(ref =>
            source.basisDigest ? {...ref, basis_digest: source.basisDigest} : ref)],
          undo_token: previous ? previous.data.undo_token : factId(claimUndoToken(command, id))}};
      });

      const handle = createCommandHandler(db, {modules: [companion], hooks: {async onFactsChanged(tx, tick) {
        // The command has already written its revisions. Revalidate source/consent without rereading revised targets.
        const current = await readTodo(tx, todoId);
        const citations = entries.flatMap(entry => entry.data.evidence_refs);
        if (current?.revision !== todo.revision || !await readReadyWork(tx, ref) ||
            !await settingsCurrent(tx, todo.spec.settingsRevision) || !await eligibleExtraction(tx, todo.spec) ||
            (await openUnderstandingCitations(tx, citations)).length !== citations.length ||
            await learnerGovernedSince(tx, source.born, source.ref.id) ||
            !await completeTodo(tx, tick, ref, current, entries[0]!.id)) throw new ClaimInputError('抽取工作已失效。');
      }}});
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
