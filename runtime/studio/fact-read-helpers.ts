// Thin adapter so existing studio callers keep their import path and semantics.
export {
  createAuthorizedFactReader, createCommandReadContext, FactNotFoundError, FactReadDeniedError,
  isFactNotFound, isFactReadDenied, isFactUnavailable, snapshotFactReaders,
  createCommandHandler, createLearnerHost, lockLearner, withinLearnerTransaction, withLearnerLock,
} from '../../kernel/src/index.ts';
export type { CommandHandler, CommandHooks, CommandRequest, CommandRuntimeOptions } from '../../kernel/src/index.ts';

import {
  createAuthorizedFactReader, createCommandHandler, createCommandReadContext, createLearnerHost,
  isFactNotFound, isFactReadDenied, isFactUnavailable,
} from '../../kernel/src/index.ts';
import type { CommandRequest, CommandRuntimeOptions } from '../../kernel/src/index.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { CommandReceipt, FactReadOptions, FactSnapshot, Json } from '../../kernel/src/declarations/types.ts';
import { stableId, studioLearner } from './identity.ts';

export const factReadChecks = { isFactNotFound, isFactReadDenied };
export const studioHost = (db: Db) => createLearnerHost(db, studioLearner);
export const storageRead = (tx: ReadTransaction) => createCommandReadContext(tx, 'storage');
export const teachingRead = (tx: ReadTransaction) => createCommandReadContext(tx, 'teaching');
export const purposeReader = (tx: ReadTransaction, maySend: (fact: FactSnapshot) => boolean) =>
  createAuthorizedFactReader(tx, 'teaching', maySend);

export function createTrackingReadContext(tx: ReadTransaction, purpose: string,
  maySend: (fact: FactSnapshot) => boolean,
  track?: (fact: FactSnapshot, mode?: 'pinned' | 'following') => void) {
  const reader = createAuthorizedFactReader(tx, purpose, maySend);
  return {...reader, async fact(id: FactId, options: FactReadOptions) {
    const fact = await reader.fact(id, options); track?.(fact, options.mode); return fact;
  }};
}

export type StudioCommandInput = Pick<CommandRequest, 'type' | 'input' | 'purpose' | 'deletionWatermark'> & {
  readonly requestId: string;
};

export const createStudioCommand = (db: Db, options: CommandRuntimeOptions) => createCommandHandler(db, options);

export const runStudioCommand = (handle: (request: CommandRequest) => Promise<CommandReceipt>, command: StudioCommandInput) =>
  handle({
    learner: studioLearner, actor: 'learner', purpose: command.purpose, type: command.type,
    input: command.input as Json, id: commandId(stableId(command.type, command.requestId)),
    ...(command.deletionWatermark === undefined ? {} : { deletionWatermark: command.deletionWatermark }),
  });

export async function readFactOrNull(tx: ReadTransaction, purpose: string, id: FactId, options: FactReadOptions) {
  try { return await createCommandReadContext(tx, purpose).fact(id, options); }
  catch (error) { if (isFactUnavailable(error)) return; throw error; }
}

export async function readAuthorizedFactOrNull(tx: ReadTransaction, purpose: string,
  maySend: (fact: FactSnapshot) => boolean, id: FactId, options: FactReadOptions) {
  try { return await createAuthorizedFactReader(tx, purpose, maySend).fact(id, options); }
  catch (error) { if (isFactUnavailable(error)) return; throw error; }
}
