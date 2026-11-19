import {createCommandReadContext, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import {factId} from '../../kernel/src/declarations/ids.ts';
import type {FactSnapshot} from '../../kernel/src/declarations/types.ts';
import {workspaceEntry, workspaceEntryKinds, workspaceEntryType, workspaceAttemptTypes, workspaceShareableTypes} from '../../modules/activity/workspace-values.ts';
import {workbookPaperType} from '../../modules/activity/workbook-values.ts';
import {materialType} from '../../modules/activity/library-values.ts';
import {organizerNoteType} from '../../modules/activity/organizer-values.ts';
import {displayOf, syntheticStudyRecords} from './workspace-access.ts';
import {purpose} from './identity.ts';

type Track = (snapshot: FactSnapshot) => void;
type MaySend = (snapshot: FactSnapshot) => boolean;
type Arguments = Record<string, unknown>;
const legacyKinds: Record<string, string[]> = {
  attempt: workspaceAttemptTypes, paper: [workbookPaperType], material: [materialType], note: [organizerNoteType],
};
const unavailable = JSON.stringify({error: '未找到可用于教学的记录。可用 search_workspace 查找当前可读的 id。'});
const idPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

async function visible(tx: ReadTransaction, id: string, track: Track, maySend: MaySend) {
  if (!idPattern.test(id) || syntheticStudyRecords.has(id)) return;
  const reader = createCommandReadContext(tx, purpose);
  const seen = new Map<string, FactSnapshot>();
  const path = new Set<string>();
  async function visit(key: string): Promise<FactSnapshot | undefined> {
    if (path.has(key) || path.size >= 32 || seen.size >= 1024 || syntheticStudyRecords.has(key)) return;
    if (seen.has(key)) return seen.get(key);
    const fact = await reader.fact(factId(key), {mode:'following'});
    if (!maySend(fact)) return;
    if (fact.type === workspaceEntryType) {
      const entry = workspaceEntry(fact.value);
      path.add(key);
      for (const witness of entry.basis) {
        const source = await visit(witness.id);
        if (!source || source.ref.rev !== witness.rev || source.accessEpoch !== witness.epoch) return;
      }
      if (!entry.links.every(link => seen.has(link))) return;
      path.delete(key);
    }
    seen.set(key, fact);
    return fact;
  }
  try {
    const fact = await visit(id);
    if (!fact || !workspaceShareableTypes.includes(fact.type)) return;
    for (const witness of seen.values()) track(witness);
    const display = displayOf(fact.type, fact.value);
    const kind = display.kind ?? Object.keys(legacyKinds).find(k => legacyKinds[k]?.includes(fact.type));
    return {fact, display, kind};
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return;
    throw error;
  }
}

function cursorValue(value: unknown) {
  if (value === undefined) return {tick: null, id: null};
  if (typeof value !== 'string' || !/^\d{1,19}:[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) return;
  const [tick,id] = value.split(':');
  if (!tick || !id || BigInt(tick) > 9223372036854775807n) return;
  return {tick,id};
}

export async function workspaceSearch(tx: ReadTransaction, args: Arguments, track: Track, maySend: MaySend): Promise<string> {
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
    if (typeof related !== 'string') return unavailable;
    const record = await visible(tx, related, track, maySend);
    if (!record) return unavailable;
    if (record.fact.type === workspaceEntryType) outgoing = workspaceEntry(record.fact.value).links;
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
      const hit = await visible(tx,row.id, f => visibleInputs.push(f), maySend);
      if (!hit) continue;
      if (results.length === 8) return JSON.stringify({results, cursor:last});
      visibleInputs.forEach(track);
      results.push({id:row.id, rev:hit.fact.ref.rev, ...(hit.kind ? {kind:hit.kind} : {}), title:hit.display.title});
      last = row.tick + ':' + row.id;
    }
    if (rows.length < 24) return JSON.stringify({results});
  }
}

export async function workspaceRead(tx: ReadTransaction, args: Arguments, track: Track, maySend: MaySend): Promise<string> {
  if (args.id === 'learner') {
    const observations = JSON.parse(await workspaceSearch(tx,{kind:'observation'},track,maySend));
    const attempts = JSON.parse(await workspaceSearch(tx,{kind:'attempt'},track,maySend));
    return JSON.stringify({id:'learner', title:'学习者模型', observations:observations.results, recentAttempts:attempts.results,
      note:'观察关联具体作答。按 id 打开依据，未观察到的能力保留未知。'});
  }
  if (typeof args.id !== 'string' || !idPattern.test(args.id)) return JSON.stringify({error:'id 请使用 search_workspace 返回的记录 id。查看学情概览时传 learner。'});
  const offset = args.offset ?? 0;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return JSON.stringify({error:'offset 须为非负整数。'});
  const record = await visible(tx, args.id, track, maySend);
  if (!record) return unavailable;
  const {fact,display,kind} = record;
  const entry = fact.type === workspaceEntryType ? workspaceEntry(fact.value) : undefined;
  const content = display.text.slice(offset, offset + 4000);
  const end = offset + content.length;
  return JSON.stringify({id:fact.ref.id, rev:fact.ref.rev, kind, title:display.title, content,
    ...(entry ? {tags:entry.tags, links:entry.links} : {}), ...(end < display.text.length ? {nextOffset:end} : {})});
}
