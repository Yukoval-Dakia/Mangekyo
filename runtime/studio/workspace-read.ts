import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import type {FactSnapshot} from '../../kernel/src/declarations/types.ts';
import {createCommandReadContext, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import type {Revision} from '../../kernel/src/declarations/ids.ts';
import {parseManifest, type ManifestInput} from '../../kernel/src/derivations/manifest.ts';
import {isSourceFactId, sourceRefV1} from '../../modules/activity/source-values.ts';
import {workspaceEntryKinds, workspaceEntryType, workspaceAttemptTypes, workspaceShareableTypes} from '../../modules/activity/workspace-values.ts';
import {workbookAttempt, workbookAttemptType, workbookPaperType, workbookRubricAssessmentType} from '../../modules/activity/workbook-values.ts';
import {materialType} from '../../modules/activity/library-values.ts';
import {organizerNoteType} from '../../modules/activity/organizer-values.ts';
import {resolveSource, type SourceTrack, type WorkspaceSourceRecipient} from './source-read.ts';
import {displayOf, syntheticStudyRecords} from './workspace-access.ts';
import {purpose} from './identity.ts';
import {readTeachingAttemptAssessments} from './learning-attempt-read.ts';
import {textSlice} from './reading.ts';
import {readLearningOverview} from './learning-overview.ts';

type Arguments = Record<string, unknown>;
const legacyKinds: Record<string, string[]> = {
  attempt: workspaceAttemptTypes, paper: [workbookPaperType], material: [materialType], note: [organizerNoteType],
};
export const workspaceSourceUnavailable = JSON.stringify({error: '未找到可用于教学的记录。可用 search_workspace 查找当前可读的 id。'});
export type AssessmentSlot = Extract<ManifestInput, {kind: 'slot'}>;
export type WorkspaceAssessmentBasis = {slot: AssessmentSlot; facts: Extract<ManifestInput, {kind: 'fact'}>[]};

export async function workspaceAssessmentBasis(tx: ReadTransaction, slot: AssessmentSlot, maySend: WorkspaceSourceRecipient): Promise<WorkspaceAssessmentBasis | undefined> {
  if (slot.slotType !== workbookRubricAssessmentType || slot.mode !== 'following') return;
  const {rows: [current]} = await tx.query<{manifest: unknown; attempt_id: string; paper_id: string}>(
    `SELECT d.manifest,d.scope_keys->>'attemptId' AS attempt_id,d.scope_keys->>'paperId' AS paper_id
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

function legacyKind(type: string) {
  return Object.keys(legacyKinds).find(kind => legacyKinds[kind]?.includes(type));
}

function referenceFromId(input: unknown) {
  if (isSourceFactId(input)) return input;
  if (typeof input !== 'string' || !input.trimStart().startsWith('{')) return;
  try { return sourceRefV1(JSON.parse(input)); }
  catch { return; }
}

function cursorValue(value: unknown) {
  if (value === undefined) return {tick: null, id: null};
  if (typeof value !== 'string' || !/^\d{1,19}:[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) return;
  const [tick,id] = value.split(':');
  if (!tick || !id || BigInt(tick) > 9223372036854775807n) return;
  return {tick,id};
}

export async function workspaceSearch(tx: ReadTransaction, args: Arguments, track: SourceTrack, maySend: WorkspaceSourceRecipient): Promise<string> {
  const filter = args.kind;
  const type = typeof filter === 'string' && Object.hasOwn(legacyKinds,filter) ? legacyKinds[filter] : undefined;
  const native = workspaceEntryKinds.find(kind => kind === filter);
  if (filter !== undefined && !type && !native) return JSON.stringify({error:'kind 可选 '+[...Object.keys(legacyKinds),...workspaceEntryKinds].join('、')+'；也可省略它按关键词搜索。'});
  const query = args.query ?? '';
  if (typeof query !== 'string' || query.length > 300 || query.includes('\0')) return JSON.stringify({error:'query 请传不超过 300 字的纯文本关键词。'});
  let cursor = cursorValue(args.cursor);
  if (!cursor) return JSON.stringify({error:'请使用上次结果中的 cursor。'});
  const related = args.related;
  let outgoing: readonly string[] = [];
  if (related !== undefined) {
    if (typeof related !== 'string') return workspaceSourceUnavailable;
    const record = await resolveSource(tx, related, {recipient: 'workspace', track, maySend});
    if (!record) return workspaceSourceUnavailable;
    outgoing = record.links ?? [];
  }
  const results: {id:string; rev:number; kind?:string; title:string}[] = [];
  let last: string | undefined;
  for (;;) {
    const {rows}: {rows:readonly {id:string; tick:string}[]} = await tx.query(
      `SELECT f.id,f.created_tick::text AS tick FROM facts f JOIN fact_revs r
       ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
       WHERE f.learner_id=$1 AND f.retracted_rev IS NULL AND f.type=ANY($2::text[])
       AND f.purpose && ARRAY['teaching','all']::text[] AND r.purpose && ARRAY['teaching','all']::text[]
       AND NOT(f.id=ANY($3::text[])) AND ($4::text IS NULL OR r.data->>'kind'=$4)
       AND position(lower($5) IN lower(r.data::text))>0
       AND ($6::text IS NULL OR r.data->'links' ? $6 OR f.id=ANY($7::text[]))
       AND ($8::bigint IS NULL OR (f.created_tick,f.id)<($8::bigint,$9::text))
       ORDER BY f.created_tick DESC,f.id DESC LIMIT 24`,
      [tx.learner, type ?? (native ? [workspaceEntryType] : workspaceShareableTypes), [...syntheticStudyRecords],
       native ?? null, query.trim(), typeof related === 'string' ? related : null, outgoing, cursor.tick, cursor.id],
    );
    for (const row of rows) {
      cursor = {tick:row.tick, id:row.id};
      const visibleInputs: FactSnapshot[] = [];
      const hit = await resolveSource(tx, row.id, {recipient: 'workspace', track: fact => visibleInputs.push(fact), maySend});
      if (!hit) continue;
      if (results.length === 8) return JSON.stringify({results, cursor:last});
      visibleInputs.forEach(fact => track(fact));
      const kind = hit.kind ?? legacyKind(hit.sourceRef.fact.type);
      results.push({id:row.id, rev:hit.sourceRef.fact.rev, ...(kind ? {kind} : {}), title:hit.title});
      last = row.tick + ':' + row.id;
    }
    if (rows.length < 24) return JSON.stringify({results});
  }
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
      goal, tasks, note:'观察关联具体作答。按 id 打开依据，未观察到的能力保留未知。'});
  }
  const reference = referenceFromId(args.id);
  if (!reference) return JSON.stringify({error:'id 可传 search_workspace 的记录 id 或读回的 sourceRef JSON 字符串。查看学情概览时传 learner。'});
  const offset = args.offset ?? 0;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return JSON.stringify({error:'offset 须为非负整数。'});
  let attempt: FactSnapshot | undefined;
  const record = await resolveSource(tx, reference, {recipient: 'workspace', maySend, track(fact, mode) {
    track(fact, mode);
    if (fact.type === workbookAttemptType) attempt = fact;
  }});
  if (!record) return workspaceSourceUnavailable;
  const {sourceRef, title, tags, links} = record;
  let original = record.content;
  const assessments = [];
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
      if (trackAssessment) {
        for (const {ref, attempt: _attempt, ...assessment} of await readTeachingAttemptAssessments(tx, attempt, {purpose, recipientEligible: maySend(attempt)})) {
          const basis = await workspaceAssessmentBasis(tx, ref, maySend);
          if (!basis) continue;
          trackAssessment(basis);
          assessments.push(assessment);
        }
      }
    }
  }
  const {content, nextOffset} = typeof original === 'string'
    ? textSlice(original, offset) : {content: original, nextOffset: null};
  return JSON.stringify({id: sourceRef.fact.id, rev: sourceRef.fact.rev, kind: record.kind ?? legacyKind(sourceRef.fact.type),
    title, content, tags, links, sourceRef, ...(assessments.length ? {assessments} : {}),
    ...(nextOffset === null ? {} : {nextOffset})});
}
