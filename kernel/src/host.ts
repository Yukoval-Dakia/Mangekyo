import type { CommandHandler, CommandHooks, CommandRequest, CommandRuntimeOptions } from './commands/contracts.ts';
import { createCommandHandler } from './commands/handle.ts';
import { createAuthorizedFactReader, createCommandReadContext } from './commands/reads.ts';
import type { Db, DbTransaction, ReadTransaction, SnapshotOptions } from './db/types.ts';
import { lockLearner, withinLearnerTransaction, withLearnerLock } from './db/learner.ts';
import { commandId, type CommandId, type FactId, type LearnerId } from './declarations/ids.ts';
import { stableId } from './declarations/random.ts';
import type { CommandReceipt, FactReadOptions, FactSnapshot, Json } from './declarations/types.ts';
import type { LoadedModule } from './loader.ts';
import { isFactUnavailable } from './commands/errors.ts';

export type HostCommandInput = Pick<CommandRequest, 'type' | 'input' | 'purpose' | 'deletionWatermark'> & {
  readonly requestId?: string;
  readonly id?: CommandId;
  readonly actor?: CommandRequest['actor'];
};

type CommandExtraOptions = Pick<CommandRuntimeOptions, 'bindCommandRead' | 'crossModuleWrites'>;

/** Per-learner entrypoint; helpers stay domain-free (no purpose or module names baked in). */
export function createLearnerHost(db: Db, learner: LearnerId, options: { actor?: CommandRequest['actor'] } = {}) {
  const scope = { learner } as const;
  const actor = options.actor ?? 'learner';

  const snapshot = <T>(read: (tx: ReadTransaction) => Promise<T>, opts?: SnapshotOptions) =>
    db.snapshot(scope, read, opts);
  const tx = <T>(run: (tx: DbTransaction) => Promise<T>) => db.tx(scope, run);
  const lockedTx = <T>(run: (tx: DbTransaction) => Promise<T>) => withLearnerLock(db, scope, run);
  const boundDb = (boundTx: DbTransaction) => withinLearnerTransaction(db, boundTx);

  const commandHandler = (
    modules: readonly LoadedModule[], hooks: CommandHooks, boundTx?: DbTransaction, extra?: CommandExtraOptions,
  ) => createCommandHandler(boundTx ? boundDb(boundTx) : db, { modules, hooks, ...extra });

  const runCommand = (handle: (request: CommandRequest) => Promise<CommandReceipt>, command: HostCommandInput) =>
    handle({
      learner, actor: command.actor ?? actor, purpose: command.purpose, type: command.type,
      input: command.input as Json,
      id: command.id ?? commandId(stableId(command.type, command.requestId ?? '')),
      ...(command.deletionWatermark === undefined ? {} : { deletionWatermark: command.deletionWatermark }),
    });

  const boundHandler = (
    modules: readonly LoadedModule[], hooks: CommandHooks, boundTx?: DbTransaction, extra?: CommandExtraOptions,
  ) => {
    const handle = commandHandler(modules, hooks, boundTx, extra);
    return (command: HostCommandInput | CommandRequest) => {
      const { learner: _l, ...rest } = command as CommandRequest & HostCommandInput;
      return runCommand(handle, rest);
    };
  };

  const lockedCommand = <T>(
    modules: readonly LoadedModule[], hooks: CommandHooks,
    run: (tx: DbTransaction, handle: CommandHandler) => Promise<T>,
    extra?: CommandExtraOptions,
  ) => lockedTx(boundTx => run(boundTx, commandHandler(modules, hooks, boundTx, extra)));

  const read = (boundTx: ReadTransaction, purpose: string) => createCommandReadContext(boundTx, purpose);
  const readOrNull = async (boundTx: ReadTransaction, purpose: string, id: FactId, readOptions: FactReadOptions) => {
    try {
      return await createCommandReadContext(boundTx, purpose).fact(id, readOptions);
    } catch (error) {
      if (isFactUnavailable(error)) return undefined;
      throw error;
    }
  };
  const trackingReader = (
    boundTx: ReadTransaction, purpose: string,
    maySend: (fact: FactSnapshot) => boolean,
    track?: (fact: FactSnapshot, mode?: FactReadOptions['mode']) => void,
  ) => {
    const reader = createAuthorizedFactReader(boundTx, purpose, maySend);
    return {...reader, async fact(id: FactId, o: FactReadOptions) {
      const fact = await reader.fact(id, o);
      track?.(fact, o.mode);
      return fact;
    }};
  };

  return {
    learner, scope, snapshot, tx, lockedTx, boundDb,
    commandHandler, boundHandler, lockedCommand, runCommand,
    read, readOrNull, trackingReader, lockLearner,
  };
}

export type LearnerHost = ReturnType<typeof createLearnerHost>;
