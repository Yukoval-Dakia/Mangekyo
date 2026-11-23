import { createHash } from 'node:crypto';
import type { FactSnapshot, ReadTransaction } from '../../kernel/src/index.ts';
import { projectWorkspaceSearchResult, runWorkspaceSearch, type SearchFilters, type SearchQuery, type WorkspaceCandidateChannel } from '../../modules/activity/workspace-search.ts';
export {
  lexicalWorkspaceSql, parseWorkspaceSearch, queryStrings, trigramFunction, unappliedWorkspaceFilters,
  workspaceOccurredAt, workspaceRecordKind, workspaceRecordKinds, WorkspaceSearchError,
  type WorkspaceCandidate, type WorkspaceCandidateChannel,
} from '../../modules/activity/workspace-search.ts';
import type { WorkspaceSource } from './knowledge-graph.ts';
import { resolveSource, sourcePurpose, sourceSearchExcerpt, type SourceAccess, type SourceTrack } from './source-read.ts';
import { syntheticStudyRecords } from './workspace-access.ts';

const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
export function workspaceResult(source: WorkspaceSource, fact: FactSnapshot, filters: SearchFilters) {
  return projectWorkspaceSearchResult(source, fact, filters, sourceSearchExcerpt);
}
export function searchWorkspaceRecords(tx: ReadTransaction, criteria: SearchQuery, access: SourceAccess, semantic?: WorkspaceCandidateChannel) {
  return runWorkspaceSearch(tx, criteria, {
    purpose: sourcePurpose(access), recipient: access.recipient, syntheticIds: [...syntheticStudyRecords],
    async resolve(id) {
      const opened: Parameters<SourceTrack>[] = [];
      const source = await resolveSource(tx, id, { ...access, track: (...witness) => opened.push(witness) });
      if (!source) return undefined;
      const fact = opened.find(([witness]) => witness.ref.id === id)?.[0];
      return { source, ...(fact ? { fact } : {}), opened };
    },
    track: witness => access.track?.(...witness), excerpt: sourceSearchExcerpt, shortHash,
  }, semantic);
}
