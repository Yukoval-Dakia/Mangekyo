import { isFactNotFound, isFactReadDenied, type ReadContext, type ReadTransaction } from '../../kernel/src/index.ts';
import { studioWorkbookBacktrace, type StudioBacktraceDeps, type StudioBacktraceInput } from '../../modules/activity/studio-backtrace-host.ts';
import { backtrace } from '../../modules/learner/retention-backtrace.ts';
import { scopedKnowledgeEdges } from './knowledge-graph.ts';
import { retentionHistoryValid } from './retention.ts';
import { readPosttestIssuance } from './retention-posttest.ts';
import { openRetentionTarget, readItemConceptLinks, retentionPurpose, retentionWorkbookEvidence } from './retention-workbook.ts';
import { RequestError } from './sessions.ts';

let cachedDeps: StudioBacktraceDeps | undefined;
const getDeps = (): StudioBacktraceDeps => cachedDeps ??= {
  retentionPurpose, isRequestError: error => error instanceof RequestError, isFactNotFound, isFactReadDenied,
  openRetentionTarget: openRetentionTarget as StudioBacktraceDeps['openRetentionTarget'],
  readItemConceptLinks: readItemConceptLinks as StudioBacktraceDeps['readItemConceptLinks'],
  readWorkbookEvidence: retentionWorkbookEvidence(readPosttestIssuance).readWorkbookEvidence as StudioBacktraceDeps['readWorkbookEvidence'],
  scopedKnowledgeEdges: scopedKnowledgeEdges as unknown as StudioBacktraceDeps['scopedKnowledgeEdges'],
  retentionHistoryValid: retentionHistoryValid as StudioBacktraceDeps['retentionHistoryValid'],
  backtrace: backtrace as unknown as StudioBacktraceDeps['backtrace'],
};
export function workbookBacktrace(tx: ReadTransaction, reader: Pick<ReadContext, 'fact'>, facts: Parameters<typeof scopedKnowledgeEdges>[2]) {
  return (input: StudioBacktraceInput) => studioWorkbookBacktrace(getDeps(), tx, reader, facts)(input);
}
