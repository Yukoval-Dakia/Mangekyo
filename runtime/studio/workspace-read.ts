import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import type {FactSnapshot} from '../../kernel/src/declarations/types.ts';
import {createCommandReadContext, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import type {Revision} from '../../kernel/src/declarations/ids.ts';
import {parseManifest, type ManifestInput} from '../../kernel/src/derivations/manifest.ts';
import {isSourceFactId, sourceRefV1} from '../../modules/activity/source-values.ts';
import {workbookAttempt, workbookAttemptType, workbookFormalAssessmentType, workbookPaperType, workbookRubricAssessmentType} from '../../modules/activity/workbook-values.ts';
import {knowledgeEdgeKinds, knowledgeEdgeType} from '../../modules/content/knowledge-edge.ts';
import {resolveSource, type SourceAccess, type SourceTrack, type WorkspaceSourceRecipient} from './source-read.ts';
import {displayOf, syntheticStudyRecords} from './workspace-access.ts';
import {purpose} from './identity.ts';
import {readTeachingAttemptAssessments} from './learning-attempt-read.ts';
import {textSlice} from './reading.ts';
import {readLearningOverview} from './learning-overview.ts';
import {openKnowledgeEdge, readKnowledgeGraph} from './knowledge-graph.ts';
import {
  parseWorkspaceSearch, queryStrings, searchWorkspaceRecords, unappliedWorkspaceFilters, WorkspaceSearchError,
  workspaceRecordKind, workspaceResult, type WorkspaceCandidateChannel,
} from './workspace-search.ts';

type Arguments = Record<string, unknown>;
export const workspaceSourceUnavailable = JSON.stringify({error: '未找到可用于教学的记录。可用 search_workspace 查找当前可读的 id。'});
export type AssessmentSlot = Extract<ManifestInput, {kind: 'slot'}>;
export type WorkspaceAssessmentBasis = {slot: AssessmentSlot; facts: Extract<ManifestInput, {kind: 'fact'}>[]};

export function isWorkspaceAssessmentSlot(type: string) {
  return type === workbookRubricAssessmentType || type === workbookFormalAssessmentType;
}

export async function workspaceAssessmentBasis(tx: ReadTransaction, slot: AssessmentSlot, maySend: WorkspaceSourceRecipient): Promise<WorkspaceAssessmentBasis | undefined> {
  if (!isWorkspaceAssessmentSlot(slot.slotType) || slot.mode !== 'following') return;
  const {rows: [current]} = await tx.query<{manifest: unknown; attempt_id: string; paper_id: string}>(
    `SELECT d.manifest,COALESCE(d.scope_keys->>'attemptId',s.scope_keys->'submissionRef'->>'id') AS attempt_id,
       COALESCE(d.scope_keys->>'paperId',s.scope_keys->'releaseRef'->>'id') AS paper_id
     FROM slot_state s JOIN derivations d
       ON (d.learner_id,d.slot_type,d.slot_key,d.id)=(s.learner_id,s.slot_type,s.slot_key,s.current_id)
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3 AND s.current_id=$4
       AND d.lifecycle='effective' AND NOT d.is_shadow AND d.invalidated_tick IS NULL
       AND d.selection_ended_tick IS NULL AND d.effective_tick >= d.gather_tick`,
    [tx.learner, slot.slotType, slot.slotKey, slot.derivationId]);
  if (!current) return;
  let manifest;
  try { manifest = parseManifest(current.manifest); }
  catch { return; }
  if (manifest.learner !== tx.learner) return;
  const reader = createCommandReadContext(tx, purpose);
  const facts: WorkspaceAssessmentBasis['facts'] = [];
  try {
    for (const input of manifest.inputs) {
      // The workbook publisher licenses direct fact inputs. Other input shapes need their own recipient policy.
      if (input.kind !== 'fact' || syntheticStudyRecords.has(input.id)) return;
      const mode = input.id === current.attempt_id ? 'following' : input.mode;
      const fact = await reader.fact(input.id, mode === 'following' ? {mode} : {mode, rev: input.rev as Revision});
      if (fact.ref.rev !== input.rev || fact.accessEpoch !== input.accessEpoch || !maySend(fact)) return;
      if ((input.id === current.attempt_id && fact.type !== workbookAttemptType) ||
          (input.id === current.paper_id && fact.type !== workbookPaperType)) return;
      facts.push(mode === input.mode ? input : {...input, mode});
    }
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return;
    throw error;
  }
  if (!facts.some(fact => fact.id === current.attempt_id) || !facts.some(fact => fact.id === current.paper_id)) return;
  return {slot, facts};
}

export async function readWorkspaceAttemptAssessments(tx: ReadTransaction, attempt: FactSnapshot,
  maySend: WorkspaceSourceRecipient, track: (basis: WorkspaceAssessmentBasis) => void) {
  const assessments = [];
  for (const {ref, attempt: _attempt, ...assessment} of await readTeachingAttemptAssessments(tx, attempt, {purpose, recipientEligible: maySend(attempt)})) {
    const basis = await workspaceAssessmentBasis(tx, ref, maySend);
    if (!basis) continue;
    track(basis);
    assessments.push(assessment);
  }
  return assessments;
}

function referenceFromId(input: unknown) {
  if (isSourceFactId(input)) return input;
  let value = input;
  if (typeof input === 'string') {
    if (!input.trimStart().startsWith('{')) return;
    try { value = JSON.parse(input); }
    catch { return; }
  }
  return sourceRefV1(value);
}

export async function workspaceQuery(tx: ReadTransaction, args: Arguments, access: SourceAccess, semantic?: WorkspaceCandidateChannel) {
  try {
    const fields = ['query', 'kind', 'kinds', 'tags', 'since', 'exposureFilter', 'related', 'cursor',
      'conceptId', 'hops', 'direction', 'edgeKinds'];
    const unsupported = Object.keys(args).filter(key => !fields.includes(key));
    if (unsupported.length) return {results:[], truncated:false, unappliedFilters:
      unsupported.map(field => ({field, reason:'unsupported', message:'此查询入口暂不支持该筛选。'}))};
    const criteria = parseWorkspaceSearch(args);
    const {conceptId, hops = 2, direction = 'both'} = args;
    if (conceptId === undefined) {
      if (args.hops !== undefined || args.direction !== undefined || args.edgeKinds !== undefined) {
        throw new WorkspaceSearchError('多跳查询需要 conceptId。');
      }
      return await searchWorkspaceRecords(tx, criteria, access, semantic);
    }
    if (!isSourceFactId(conceptId) || (hops !== 0 && hops !== 1 && hops !== 2) ||
        (direction !== 'both' && direction !== 'inbound' && direction !== 'outbound')) {
      throw new WorkspaceSearchError('conceptId 须为概念 id，hops 可选 0、1、2，direction 可选 inbound、outbound、both。');
    }
    if (criteria.query || criteria.related || criteria.cursor) {
      throw new WorkspaceSearchError('概念图查询使用 conceptId、hops、edgeKinds 及记录过滤。');
    }
    const requested = queryStrings(args.edgeKinds, 'edgeKinds', knowledgeEdgeKinds);
    const edgeKinds = knowledgeEdgeKinds.filter(kind => requested.includes(kind));
    const graph = await readKnowledgeGraph(tx, {conceptId, hops, direction, edgeKinds}, access, (source, fact, hop) => {
      const match = workspaceResult(source, fact, criteria);
      return match ? {...match, hop} : undefined;
    });
    if (graph) return {...graph, unappliedFilters: unappliedWorkspaceFilters(criteria)};
  } catch (error) {
    if (error instanceof WorkspaceSearchError) return {error: error.message};
    throw error;
  }
  return undefined;
}

export async function workspaceSearch(tx: ReadTransaction, args: Arguments, track: SourceTrack, maySend: WorkspaceSourceRecipient): Promise<string> {
  const result = await workspaceQuery(tx, args, {recipient:'workspace', track, maySend});
  return result ? JSON.stringify(result) : workspaceSourceUnavailable;
}

export async function workspaceRead(tx: ReadTransaction, args: Arguments, track: SourceTrack, maySend: WorkspaceSourceRecipient,
  trackAssessment?: (basis: WorkspaceAssessmentBasis) => void): Promise<string> {
  if (args.id === 'learner') {
    const observations = JSON.parse(await workspaceSearch(tx,{kind:'observation'},track,maySend));
    const attempts = JSON.parse(await workspaceSearch(tx,{kind:'attempt'},track,maySend));
    const overview = await readLearningOverview(tx, {callerPurpose: purpose, maySend: (_, snapshot) => maySend(snapshot), track});
    const goal = overview.goal.state === 'set' ? overview.goal.text : null;
    const tasks = 'items' in overview.tasks ? overview.tasks.items : [];
    return JSON.stringify({id:'learner', title:'学习者模型', observations:observations.results, recentAttempts:attempts.results,
      goal, tasks, prerequisites:{tool:'search_workspace', args:{hops:2, direction:'inbound', edgeKinds:['prereq_of']},
        required:['conceptId']}, note:'观察关联具体作答。按 id 打开依据，未观察到的能力保留未知。'});
  }
  const reference = referenceFromId(args.id);
  if (!reference) return JSON.stringify({error:'id 可传 search_workspace 的记录 id 或读回的 sourceRef JSON 字符串。查看学情概览时传 learner。'});
  const offset = args.offset ?? 0;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return JSON.stringify({error:'offset 须为非负整数。'});
  if (typeof reference !== 'string' && reference.fact.type === knowledgeEdgeType) {
    const edge = await openKnowledgeEdge(tx, reference, {recipient:'workspace', maySend});
    if (!edge) return workspaceSourceUnavailable;
    for (const witness of edge.opened) track(...witness);
    return JSON.stringify(edge.value);
  }
  let attempt: FactSnapshot | undefined;
  const record = await resolveSource(tx, reference, {recipient: 'workspace', maySend, track(fact, mode) {
    track(fact, mode);
    if (fact.type === workbookAttemptType) attempt = fact;
  }});
  if (!record) return workspaceSourceUnavailable;
  const {sourceRef, title, tags, links} = record;
  let original = record.content;
  let assessments: Awaited<ReturnType<typeof readWorkspaceAttemptAssessments>> = [];
  if (attempt && attempt.ref.id === sourceRef.fact.id && sourceRef.anchor.kind === 'whole' && typeof original === 'string') {
    let value;
    try { value = workbookAttempt(attempt.value); }
    catch { return workspaceSourceUnavailable; }
    const {paper, feedback} = value;
    if (paper.questions.some(question => question.kind === 'rubric')) {
      const rubric = '未随作答共享';
      original = displayOf(workbookAttemptType, {...value,
        paper: {...paper, questions: paper.questions.map(question => question.kind === 'rubric'
          ? {...question, rubric, explanation: null} : question)},
        feedback: feedback.map(item => item.expected.kind === 'rubric'
          ? {...item, expected: {...item.expected, rubric}, explanation: null} : item),
      }).text;
      if (trackAssessment) assessments = await readWorkspaceAttemptAssessments(tx, attempt, maySend, trackAssessment);
    }
  }
  const {content, nextOffset} = typeof original === 'string'
    ? textSlice(original, offset) : {content: original, nextOffset: null};
  return JSON.stringify({id: sourceRef.fact.id, rev: sourceRef.fact.rev, kind: record.kind ?? workspaceRecordKind(sourceRef.fact.type),
    title, content, tags, links, sourceRef, ...(record.question ? {question:record.question} : {}), ...(assessments.length ? {assessments} : {}),
    ...(nextOffset === null ? {} : {nextOffset})});
}
