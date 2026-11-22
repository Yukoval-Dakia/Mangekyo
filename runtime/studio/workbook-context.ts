import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { FactNotFoundError, FactReadDeniedError, snapshotFactReaders } from '../../kernel/src/commands/reads.ts';
import { withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import type { Db } from '../../kernel/src/db/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import {
  openStudioWorkbookContext, type StudioWorkbookContextDeps, type WorkbookContextAuthority as HostAuthority,
} from '../../modules/activity/studio-workbook-context-host.ts';
import { historicalWorkbookMount as hostMount } from '../../modules/activity/studio-workbook-context-host.ts';
import { WorkbookSourceMismatch } from '../../modules/activity/workbook-values.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { FactId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, ReadContext } from '../../kernel/src/declarations/types.ts';

export const historicalWorkbookMount = (tx: ReadTransaction, id: FactId, fact: FactSnapshot, read: ReadContext) =>
  hostMount(tx, id, fact, read, error =>
    error instanceof WorkbookSourceMismatch || error instanceof FactNotFoundError || error instanceof FactReadDeniedError);
import { notionReadScope, NotionReadUnchecked } from './notion.ts';
import type { openRetention } from './retention.ts';
import { isWorkbookNotionSource, selectedWorkbookRead, retentionPurpose } from './retention-workbook.ts';
import { stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';
import { resolveSource } from './source-read.ts';

export type { WorkbookQuestionWithContext } from '../../modules/activity/studio-workbook-context-host.ts';
export type WorkbookContextAuthority = HostAuthority & {
  activePosttest?: ReturnType<typeof openRetention>['activePosttest'];
};

export function openWorkbookContext(db: Db, activity: LoadedModule, hooks: CommandHooks, authority: WorkbookContextAuthority) {
  const key = randomBytes(32);
  const sign = (...scope: unknown[]) => createHmac('sha256', key).update(canonicalJsonString(scope)).digest('base64url');
  const deps: StudioWorkbookContextDeps = {
    retentionPurpose,
    stableId,
    canonicalJsonString,
    sign,
    equal: timingSafeEqual,
    fail: (status, message) => { throw new RequestError(status, message); },
    isNotionReadUnchecked: error => error instanceof NotionReadUnchecked,
    isWorkbookNotionSource,
    selectedWorkbookRead: selectedWorkbookRead as StudioWorkbookContextDeps['selectedWorkbookRead'],
    snapshotFactReaders: snapshotFactReaders as StudioWorkbookContextDeps['snapshotFactReaders'],
    resolveSource: resolveSource as StudioWorkbookContextDeps['resolveSource'],
    notionReadScope: ({ signal }) => notionReadScope(db, studioLearner, { signal }) as never,
    createCommandHandler: (tx, commands) => createCommandHandler(tx as never, commands as never),
    withinLearnerTransaction: (innerDb, tx) => withinLearnerTransaction(innerDb as Db, tx as never),
    activity,
    hooks,
    db,
    learner: studioLearner,
    isFactNotFound: error => error instanceof FactNotFoundError,
    isFactReadDenied: error => error instanceof FactReadDeniedError,
  };
  return openStudioWorkbookContext(deps, authority);
}
