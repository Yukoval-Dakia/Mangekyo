import { createHash } from 'node:crypto';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { isSourceFactId } from '../../modules/activity/source-values.ts';
import { workspaceShareableTypes } from '../../modules/activity/workspace-values.ts';
import {
  candidateKey, candidateLimit, fuseWorkspaceCandidates, lexicalCandidates, unappliedWorkspaceFilters, workspaceRecordKind,
  workspaceOccurredAt, WorkspaceSearchError, type SearchFilters, type SearchQuery, type WorkspaceCandidateChannel,
} from '../../modules/activity/workspace-search.ts';
export {
  lexicalWorkspaceSql, parseWorkspaceSearch, queryStrings, trigramFunction, unappliedWorkspaceFilters,
  workspaceOccurredAt, workspaceRecordKind, workspaceRecordKinds, WorkspaceSearchError,
  type WorkspaceCandidate, type WorkspaceCandidateChannel,
} from '../../modules/activity/workspace-search.ts';
import type { WorkspaceSource } from './knowledge-graph.ts';
import { syntheticStudyRecords } from './workspace-access.ts';
import { resolveSource, sourcePurpose, sourceSearchExcerpt, type SourceAccess, type SourceTrack } from './source-read.ts';

const pageSize = 8;
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

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export async function searchWorkspaceRecords(
  tx: ReadTransaction, criteria: SearchQuery, access: SourceAccess, semantic?: WorkspaceCandidateChannel,
) {
  const { cursor, ...query } = criteria;
  const related = criteria.related ? await resolveSource(tx, criteria.related, access) : undefined;
  if (criteria.related && !related) return;
  const { rows: [watermark] } = await tx.query<{ tick: string }>('SELECT clock::text AS tick FROM learners WHERE id=$1', [tx.learner]);
  const { rows, trigramUnavailable } = await lexicalCandidates(tx, criteria, sourcePurpose(access), [...syntheticStudyRecords], related?.links ?? []);
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
  if (!afterCursor) throw new WorkspaceSearchError('查询或记录已变化，请去掉 cursor 重查。','cursor','basis_stale');
  return {
    results, ...(nextCursor ? { cursor: nextCursor } : {}),
    candidateWindow: candidateLimit,
    unappliedFilters: unappliedWorkspaceFilters(criteria),
    ...(trigramUnavailable ? { retrievalWarnings: ['pg_trgm_unavailable'] } : {}),
  };
}
