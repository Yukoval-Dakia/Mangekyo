import { createHash } from 'node:crypto';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { materialType } from '../../modules/activity/library-values.ts';
import { goalType } from '../../modules/plan/goal-values.ts';
import { organizerNoteType } from '../../modules/activity/organizer-values.ts';
import { organizerTaskType } from '../../modules/plan/organizer-task-values.ts';
import { isSourceFactId } from '../../modules/activity/source-values.ts';
import { workbookAttemptType, workbookPaperType } from '../../modules/activity/workbook-values.ts';
import {
  workspaceAttemptTypes, workspaceEntryKinds, workspaceEntryType, workspaceShareableTypes, workspaceTagLimit,
} from '../../modules/activity/workspace-values.ts';
import type { WorkspaceSource } from './knowledge-graph.ts';
import { syntheticStudyRecords } from './workspace-access.ts';
import { resolveSource, sourcePurpose, sourceSearchExcerpt, type SourceAccess, type SourceTrack } from './source-read.ts';

const pageSize = 8;
const candidateLimit = 256;
const legacyKinds: Readonly<Record<string, readonly string[]>> = {
  attempt: workspaceAttemptTypes, paper: [workbookPaperType], material: [materialType],
  note: [organizerNoteType], goal: [goalType], task: [organizerTaskType],
};
export const workspaceRecordKinds = [...workspaceEntryKinds, ...Object.keys(legacyKinds)];

export type WorkspaceCandidate = {
  learner: string;
  id: string;
  rev: number;
  type: string;
  accessEpoch: string;
};
export type WorkspaceCandidateChannel = {
  matched: 'semantic';
  candidates: readonly WorkspaceCandidate[];
};
type LexicalCandidate = WorkspaceCandidate & { fts: boolean; trgm: boolean };
type Match = 'fts' | 'trgm' | 'semantic';
type SearchFilters = {
  kinds: readonly string[];
  tags: readonly string[];
  since: string | null;
  exposureFilter: 'exposed' | 'unexposed' | 'unknown' | null;
};
type SearchQuery = SearchFilters & { query: string; related?: string; cursor?: string };

export class WorkspaceSearchError extends Error {}

export function queryStrings(value: unknown, field: string, allowed?: readonly string[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some(item =>
    typeof item !== 'string' || !item.trim() || item.length > workspaceTagLimit ||
    !item.isWellFormed() || item.includes('\0') || (allowed && !allowed.includes(item)))) {
    throw new WorkspaceSearchError(`${field} 含无效值。`);
  }
  return [...new Set<string>(value)];
}

function parseSince(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw new WorkspaceSearchError('since 需为 ISO 日期或带时区的 ISO 时间。');
  }
  const day = new Date(value.slice(0, 10));
  const time = new Date(value);
  if (Number.isNaN(time.valueOf()) || Number.isNaN(day.valueOf()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new WorkspaceSearchError('since 时间无效。');
  }
  return time.toISOString();
}

export function parseWorkspaceSearch(args: Record<string, unknown>): SearchQuery {
  const { query = '', related, cursor, exposureFilter = null } = args;
  if (typeof query !== 'string' || query.length > 300 || !query.isWellFormed() || query.includes('\0')) {
    throw new WorkspaceSearchError('query 请传不超过 300 字的纯文本关键词。');
  }
  if (related !== undefined && !isSourceFactId(related)) throw new WorkspaceSearchError('related 需要记录 id。');
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^[a-f0-9]{24}:[a-f0-9]{24}$/.test(cursor))) {
    throw new WorkspaceSearchError('请使用上次结果中的 cursor。');
  }
  if (args.kind !== undefined && args.kinds !== undefined) throw new WorkspaceSearchError('请选择 kind 或 kinds。');
  const kinds = queryStrings(args.kind === undefined ? args.kinds : [args.kind], 'kinds', workspaceRecordKinds);
  if (exposureFilter !== null && exposureFilter !== 'exposed' && exposureFilter !== 'unexposed' && exposureFilter !== 'unknown') {
    throw new WorkspaceSearchError('exposureFilter 只能是 exposed、unexposed 或 unknown。');
  }
  return {
    query: query.trim(), kinds, tags: queryStrings(args.tags, 'tags'), since: parseSince(args.since), exposureFilter,
    ...(related ? { related } : {}), ...(cursor ? { cursor } : {}),
  };
}

export function workspaceRecordKind(type: string) {
  return Object.keys(legacyKinds).find(kind => legacyKinds[kind]?.includes(type));
}

export function workspaceOccurredAt(fact: FactSnapshot): string | null {
  const data = fact.value;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  const time = fact.type === workbookAttemptType ? value.submittedAt : fact.type === workbookPaperType ? value.savedAt : null;
  return typeof time === 'string' && Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : null;
}

export function workspaceResult(source: WorkspaceSource, fact: FactSnapshot, filters: SearchFilters) {
  const kind = source.kind ?? workspaceRecordKind(fact.type) ?? fact.type;
  const tags = source.tags ?? [];
  const time = workspaceOccurredAt(fact);
  if ((filters.kinds.length && !filters.kinds.includes(kind)) ||
      !filters.tags.every(tag => tags.includes(tag)) || (filters.since && (!time || time < filters.since))) return;
  if (filters.exposureFilter && (filters.exposureFilter !== 'unknown' || kind !== 'question')) return;
  const excerpt = sourceSearchExcerpt(fact, source.content);
  return {
    id: fact.ref.id, rev: fact.ref.rev, kind, title: source.title, excerpt, occurredAt: time, tags,
    sourceRef: source.sourceRef,
    ...(kind === 'question' ? { exposure: 'unknown' as const } : {}),
  };
}

export function unappliedWorkspaceFilters(filters: SearchFilters) {
  const warnings = [];
  if (filters.exposureFilter === 'unexposed' || filters.exposureFilter === 'exposed') {
    warnings.push({ field: 'exposureFilter', reason: 'coverage_unknown', message: '缺少实际展示覆盖，无法确认已曝光或可靠未曝光。' });
  }
  if (filters.since && (!filters.kinds.length || filters.kinds.some(kind => kind !== 'paper'))) {
    warnings.push({ field: 'since', reason: 'undated_records_excluded', message: '没有可用发生时间的记录不参加 since 筛选。' });
  }
  return warnings;
}

export async function trigramFunction(tx: ReadTransaction): Promise<string | undefined> {
  const { rows: [extension] } = await tx.query<{ schema: string }>(
    `SELECT n.nspname AS schema FROM pg_catalog.pg_extension e
     JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'`,
  );
  return extension ? `"${extension.schema.replaceAll('"', '""')}".word_similarity` : undefined;
}

const searchDocument = `concat_ws(' ', r.data->>'title', r.data->>'body', r.data->>'text',
  r.data->>'markdown', r.data#>>'{paper,title}', r.data#>>'{extraction,text}',
  r.data->'tags', jsonb_path_query_array(r.data, '$.questions[*].prompt'),
  jsonb_path_query_array(r.data, '$.paper.questions[*].prompt'))`;

export function lexicalWorkspaceSql(parameter: number, trigram?: string) {
  const query = `$${parameter}::text`;
  const splitHan = (text: string) => `regexp_replace(${text}, '([㐀-䶿一-鿿豈-﫿])', ' \\1 ', 'g')`;
  const tokens = `to_tsvector('simple', ${splitHan(searchDocument)})`;
  const phrase = `phraseto_tsquery('simple', ${splitHan(query)})`;
  const normal = `to_tsvector('simple', ${searchDocument}) @@ plainto_tsquery('simple', ${query})`;
  return { fts: `(${normal} OR ${tokens} @@ ${phrase})`,
    score: trigram ? `${trigram}(${query}, ${searchDocument})` : '0::real' };
}

async function lexicalCandidates(tx: ReadTransaction, criteria: SearchQuery, access: SourceAccess, outgoing: readonly string[]) {
  const trigram = criteria.query ? await trigramFunction(tx) : undefined;
  const { fts, score } = lexicalWorkspaceSql(7, trigram);
  const native = workspaceEntryKinds.filter(kind => criteria.kinds.includes(kind));
  const types = criteria.kinds.length
    ? [...criteria.kinds.flatMap(kind => legacyKinds[kind] ?? []), ...(native.length ? [workspaceEntryType] : [])]
    : workspaceShareableTypes;
  const { rows } = await tx.query<LexicalCandidate>(
    `WITH matches AS (
       SELECT f.learner_id AS learner, f.id, f.type, r.rev, f.access_epoch::text AS "accessEpoch", f.created_tick,
         CASE WHEN $7='' THEN false ELSE ${fts} END AS fts,
         CASE WHEN $7='' THEN 0 ELSE ${score} END AS score
       FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
       WHERE f.learner_id=$1 AND f.type=ANY($2::text[]) AND NOT(f.id=ANY($3::text[]))
         AND f.retracted_rev IS NULL AND r.kind='value'
         AND f.purpose && ARRAY[$4,'all']::text[] AND r.purpose && ARRAY[$4,'all']::text[]
         AND (cardinality($5::text[])=0 OR f.type<>$6 OR r.data->>'kind'=ANY($5))
         AND (cardinality($8::text[])=0 OR r.data->'tags' ?& $8)
         AND ($9::text IS NULL OR r.data->'links' ? $9 OR f.id=ANY($10::text[]))
         AND ($11::timestamptz IS NULL OR CASE
           WHEN f.type=$12 AND pg_input_is_valid(r.data->>'submittedAt', 'timestamptz') THEN (r.data->>'submittedAt')::timestamptz >= $11
           WHEN f.type=$13 AND pg_input_is_valid(r.data->>'savedAt', 'timestamptz') THEN (r.data->>'savedAt')::timestamptz >= $11
           ELSE false END)
     )
     SELECT learner,id,type,rev,"accessEpoch",fts,score>=0.45 AS trgm
     FROM matches WHERE $7='' OR fts OR score>=0.45
     ORDER BY fts DESC, score DESC, created_tick DESC, id DESC LIMIT $14`,
    [tx.learner, types, [...syntheticStudyRecords], sourcePurpose(access), native, workspaceEntryType,
      criteria.query, criteria.tags, criteria.related ?? null, outgoing, criteria.since,
      workbookAttemptType, workbookPaperType, candidateLimit + 1],
  );
  return { rows, trigramUnavailable: Boolean(criteria.query && !trigram) };
}

function candidateKey(candidate: WorkspaceCandidate): string {
  return JSON.stringify([candidate.learner, candidate.id, candidate.type, candidate.rev, candidate.accessEpoch]);
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function fuseWorkspaceCandidates(lexical: readonly LexicalCandidate[], semantic?: WorkspaceCandidateChannel) {
  const merged = new Map<string, { candidate: WorkspaceCandidate; matched: Set<Match>; rank: number }>();
  function add(candidate: WorkspaceCandidate, matches: readonly Match[], index: number) {
    const key = candidateKey(candidate);
    const existing = merged.get(key) ?? { candidate, matched: new Set<Match>(), rank: 0 };
    for (const match of matches) existing.matched.add(match);
    existing.rank += 1 / (60 + index);
    merged.set(key, existing);
  }
  lexical.slice(0, candidateLimit).forEach((candidate, index) =>
    add(candidate, [...(candidate.fts ? ['fts' as const] : []), ...(candidate.trgm ? ['trgm' as const] : [])], index));
  const seen = new Set<string>();
  semantic?.candidates.slice(0, candidateLimit).forEach((candidate, index) => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    add(candidate, [semantic.matched], index);
  });
  return [...merged.values()].sort((left, right) => right.rank - left.rank);
}

export async function searchWorkspaceRecords(
  tx: ReadTransaction, criteria: SearchQuery, access: SourceAccess, semantic?: WorkspaceCandidateChannel,
) {
  const { cursor, ...query } = criteria;
  const related = criteria.related ? await resolveSource(tx, criteria.related, access) : undefined;
  if (criteria.related && !related) return;
  const { rows: [watermark] } = await tx.query<{ tick: string }>('SELECT clock::text AS tick FROM learners WHERE id=$1', [tx.learner]);
  const { rows, trigramUnavailable } = await lexicalCandidates(tx, criteria, access, related?.links ?? []);
  const candidates = fuseWorkspaceCandidates(rows, semantic);
  const fingerprint = shortHash(JSON.stringify([
    tx.learner, sourcePurpose(access), access.recipient, watermark?.tick, query, trigramUnavailable,
    semantic?.candidates.slice(0, candidateLimit),
  ]));
  const results = [];
  const returned = new Set<string>();
  let afterCursor = cursor === undefined;
  let nextCursor: string | undefined;
  let lastCursor: string | undefined;
  for (const { candidate, matched } of candidates) {
    if (returned.has(candidate.id) || candidate.learner !== tx.learner ||
        !isSourceFactId(candidate.id) || !workspaceShareableTypes.includes(candidate.type)) continue;
    const opened: Parameters<SourceTrack>[] = [];
    const record = await resolveSource(tx, candidate.id, { ...access, track: (...witness) => opened.push(witness) });
    const fact = opened.find(([witness]) => witness.ref.id === candidate.id)?.[0];
    if (!record || !fact || fact.type !== candidate.type || fact.ref.rev !== candidate.rev ||
        fact.accessEpoch !== candidate.accessEpoch) continue;
    if (criteria.related && !related?.links?.includes(candidate.id) && !record.links?.includes(criteria.related)) continue;
    const result = workspaceResult(record, fact, criteria);
    if (!result) continue;
    const position = `${fingerprint}:${shortHash(candidateKey(candidate))}`;
    if (!afterCursor) {
      afterCursor = position === cursor;
      if (afterCursor) returned.add(candidate.id);
      continue;
    }
    if (results.length === pageSize) {
      nextCursor = lastCursor;
      break;
    }
    for (const witness of opened) access.track?.(...witness);
    results.push({ ...result, matched: [...matched] });
    returned.add(candidate.id);
    lastCursor = position;
  }
  if (!afterCursor) throw new WorkspaceSearchError('查询或记录已变化，请去掉 cursor 重查。');
  return {
    results, ...(nextCursor ? { cursor: nextCursor } : {}),
    candidateWindow: candidateLimit,
    unappliedFilters: unappliedWorkspaceFilters(criteria),
    ...(trigramUnavailable ? { retrievalWarnings: ['pg_trgm_unavailable'] } : {}),
  };
}
