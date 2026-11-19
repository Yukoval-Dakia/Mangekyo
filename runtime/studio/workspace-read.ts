import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import type {FactSnapshot} from '../../kernel/src/declarations/types.ts';
import {isSourceFactId, sourceRefV1} from '../../modules/activity/source-values.ts';
import {workspaceEntryKinds, workspaceEntryType, workspaceAttemptTypes, workspaceShareableTypes} from '../../modules/activity/workspace-values.ts';
import {workbookPaperType} from '../../modules/activity/workbook-values.ts';
import {materialType} from '../../modules/activity/library-values.ts';
import {organizerNoteType} from '../../modules/activity/organizer-values.ts';
import {resolveSource, type SourceTrack, type WorkspaceSourceRecipient} from './source-read.ts';
import {syntheticStudyRecords} from './workspace-access.ts';
import {textSlice} from './reading.ts';

type Arguments = Record<string, unknown>;
const legacyKinds: Record<string, string[]> = {
  attempt: workspaceAttemptTypes, paper: [workbookPaperType], material: [materialType], note: [organizerNoteType],
};
export const workspaceSourceUnavailable = JSON.stringify({error: '未找到可用于教学的记录。可用 search_workspace 查找当前可读的 id。'});

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

export async function workspaceRead(tx: ReadTransaction, args: Arguments, track: SourceTrack, maySend: WorkspaceSourceRecipient): Promise<string> {
  if (args.id === 'learner') {
    const observations = JSON.parse(await workspaceSearch(tx,{kind:'observation'},track,maySend));
    const attempts = JSON.parse(await workspaceSearch(tx,{kind:'attempt'},track,maySend));
    return JSON.stringify({id:'learner', title:'学习者模型', observations:observations.results, recentAttempts:attempts.results,
      note:'观察关联具体作答。按 id 打开依据，未观察到的能力保留未知。'});
  }
  const reference = referenceFromId(args.id);
  if (!reference) return JSON.stringify({error:'id 可传 search_workspace 的记录 id 或读回的 sourceRef JSON 字符串。查看学情概览时传 learner。'});
  const offset = args.offset ?? 0;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return JSON.stringify({error:'offset 须为非负整数。'});
  const record = await resolveSource(tx, reference, {recipient: 'workspace', track, maySend});
  if (!record) return workspaceSourceUnavailable;
  const {sourceRef, content: original, title, tags, links} = record;
  const sliced = typeof original === 'string' ? textSlice(original, offset) : {content: original, offset: 0, nextOffset: null};
  const content = sliced.content;
  const end = sliced.offset + (typeof content === 'string' ? content.length : 0);
  return JSON.stringify({id: sourceRef.fact.id, rev: sourceRef.fact.rev, kind: record.kind ?? legacyKind(sourceRef.fact.type),
    title, content, tags, links, sourceRef, ...(typeof original === 'string' && end < original.length ? {nextOffset: end} : {})});
}
