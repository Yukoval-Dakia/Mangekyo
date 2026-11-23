import { createAuthorizedFactReader, createCommandReadContext, FactNotFoundError, FactReadDeniedError, snapshotFactReaders } from '../../kernel/src/commands/reads.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks, CommandRequest } from '../../kernel/src/commands/contracts.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { commandId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { CommandReceipt, FactReadOptions, FactSnapshot, Json } from '../../kernel/src/declarations/types.ts';
import { stableId, studioLearner } from './identity.ts';

export { createAuthorizedFactReader, createCommandReadContext, FactNotFoundError, FactReadDeniedError, snapshotFactReaders };

export const isFactNotFound = (error: unknown): error is FactNotFoundError => error instanceof FactNotFoundError;
export const isFactReadDenied = (error: unknown): error is FactReadDeniedError => error instanceof FactReadDeniedError;
export const isFactUnavailable = (error: unknown): boolean => isFactNotFound(error) || isFactReadDenied(error);
export const factReadChecks = {isFactNotFound, isFactReadDenied};

export function storageRead(tx: ReadTransaction): ReturnType<typeof createCommandReadContext> {
  return createCommandReadContext(tx, 'storage');
}

export function teachingRead(tx: ReadTransaction): ReturnType<typeof createCommandReadContext> {
  return createCommandReadContext(tx, 'teaching');
}

export function purposeReader(tx: ReadTransaction, maySend: (fact: FactSnapshot) => boolean): ReturnType<typeof createAuthorizedFactReader> {
  return createAuthorizedFactReader(tx, 'teaching', maySend);
}

export function createTrackingReadContext(tx: ReadTransaction, purpose: string,
  maySend: (fact: FactSnapshot) => boolean,
  track?: (fact: FactSnapshot, mode?: 'pinned' | 'following') => void): ReturnType<typeof createAuthorizedFactReader> {
  const reader = createAuthorizedFactReader(tx, purpose, maySend);
  return {
    ...reader,
    async fact(id: FactId, options: FactReadOptions) {
      const fact = await reader.fact(id, options);
      track?.(fact, options.mode);
      return fact;
    },
  };
}

export type StudioCommandInput = Pick<CommandRequest, 'type' | 'input' | 'purpose' | 'deletionWatermark'> & {
  readonly requestId: string;
};

export const createStudioCommand = (db: Db, options: {modules: readonly LoadedModule[]; hooks: CommandHooks}) =>
  createCommandHandler(db, options);

export const runStudioCommand = (handle: (request: CommandRequest) => Promise<CommandReceipt>, command: StudioCommandInput) =>
  handle({
    learner: studioLearner,
    actor: 'learner',
    purpose: command.purpose,
    type: command.type,
    input: command.input as Json,
    id: commandId(stableId(command.type, command.requestId)),
    ...(command.deletionWatermark === undefined ? {} : {deletionWatermark: command.deletionWatermark}),
  });

export async function readFactOrNull(tx: ReadTransaction, purpose: string, id: FactId, options: FactReadOptions) {
  try { return await createCommandReadContext(tx, purpose).fact(id, options); }
  catch (error) { if (isFactUnavailable(error)) return; throw error; }
}

export async function readAuthorizedFactOrNull(tx: ReadTransaction, purpose: string, maySend: (fact: FactSnapshot) => boolean, id: FactId, options: FactReadOptions) {
  try { return await createAuthorizedFactReader(tx, purpose, maySend).fact(id, options); }
  catch (error) { if (isFactUnavailable(error)) return; throw error; }
}
