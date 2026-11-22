import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { ReadContext } from '../../kernel/src/declarations/types.ts';
import { FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import {
  studioWorkbookBacktrace, type StudioBacktraceDeps, type StudioBacktraceInput,
} from '../../modules/activity/studio-backtrace-host.ts';
import { backtrace } from '../../modules/learner/retention-backtrace.ts';
import { scopedKnowledgeEdges } from './knowledge-graph.ts';
import {
  openRetentionTarget, readItemConceptLinks, retentionPurpose, retentionWorkbookEvidence,
} from './retention-workbook.ts';
import { readPosttestIssuance } from './retention-posttest.ts';
import { retentionHistoryValid } from './retention.ts';
import { RequestError } from './sessions.ts';

type Reader = Pick<ReadContext, 'fact'>;

const { readWorkbookEvidence } = retentionWorkbookEvidence(readPosttestIssuance);

const deps: StudioBacktraceDeps = {
  retentionPurpose,
  isRequestError: error => error instanceof RequestError,
  isFactNotFound: error => error instanceof FactNotFoundError,
  isFactReadDenied: error => error instanceof FactReadDeniedError,
  openRetentionTarget: openRetentionTarget as StudioBacktraceDeps['openRetentionTarget'],
  readItemConceptLinks: readItemConceptLinks as StudioBacktraceDeps['readItemConceptLinks'],
  readWorkbookEvidence: readWorkbookEvidence as StudioBacktraceDeps['readWorkbookEvidence'],
  scopedKnowledgeEdges: scopedKnowledgeEdges as unknown as StudioBacktraceDeps['scopedKnowledgeEdges'],
  retentionHistoryValid: retentionHistoryValid as StudioBacktraceDeps['retentionHistoryValid'],
  backtrace: backtrace as unknown as StudioBacktraceDeps['backtrace'],
};

export function workbookBacktrace(tx: ReadTransaction, reader: Reader, facts: Parameters<typeof scopedKnowledgeEdges>[2]) {
  return (input: StudioBacktraceInput) => studioWorkbookBacktrace(deps, tx, reader, facts)(input);
}
