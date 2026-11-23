import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createCommandHandler, isFactUnavailable, snapshotFactReaders, withinLearnerTransaction, type CommandHooks, type Db, type FactId, type FactSnapshot, type ReadContext, type ReadTransaction } from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { historicalWorkbookMount as hostMount, openStudioWorkbookContext, type StudioWorkbookContextDeps, type WorkbookContextAuthority as HostAuthority } from '../../modules/activity/studio-workbook-context-host.ts';
import { WorkbookSourceMismatch } from '../../modules/activity/workbook-values.ts';
import { factReadChecks } from './fact-read-helpers.ts';
import { stableId, studioLearner } from './identity.ts';
import { notionReadScope, NotionReadUnchecked } from './notion.ts';
import type { openRetention } from './retention.ts';
import { isWorkbookNotionSource, retentionPurpose, selectedWorkbookRead } from './retention-workbook.ts';
import { RequestError } from './sessions.ts';
import { resolveSource } from './source-read.ts';

export type { WorkbookQuestionWithContext } from '../../modules/activity/studio-workbook-context-host.ts';
export type WorkbookContextAuthority = HostAuthority & { activePosttest?: ReturnType<typeof openRetention>['activePosttest'] };
export function historicalWorkbookMount(tx: ReadTransaction, id: FactId, fact: FactSnapshot, read: ReadContext) {
  return hostMount(tx, id, fact, read, error => error instanceof WorkbookSourceMismatch || isFactUnavailable(error));
}
export function openWorkbookContext(db: Db, activity: LoadedModule, hooks: CommandHooks, authority: WorkbookContextAuthority) {
  const key = randomBytes(32);
  return openStudioWorkbookContext({
    retentionPurpose, stableId, canonicalJsonString, equal: timingSafeEqual, activity, hooks, db, learner: studioLearner, ...factReadChecks,
    sign: (...scope: unknown[]) => createHmac('sha256', key).update(canonicalJsonString(scope)).digest('base64url'),
    fail: (status, message) => { throw new RequestError(status, message); },
    isNotionReadUnchecked: error => error instanceof NotionReadUnchecked,
    isWorkbookNotionSource, selectedWorkbookRead: selectedWorkbookRead as StudioWorkbookContextDeps['selectedWorkbookRead'],
    snapshotFactReaders: snapshotFactReaders as StudioWorkbookContextDeps['snapshotFactReaders'],
    resolveSource: resolveSource as StudioWorkbookContextDeps['resolveSource'],
    notionReadScope: ({ signal }) => notionReadScope(db, studioLearner, { signal }) as never,
    createCommandHandler: (tx, commands) => createCommandHandler(tx as never, commands as never),
    withinLearnerTransaction: (innerDb, tx) => withinLearnerTransaction(innerDb as Db, tx as never),
  }, authority);
}
