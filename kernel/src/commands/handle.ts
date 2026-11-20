import type { Db, DbTransaction } from '../db/types.ts';
import { lockLearner } from '../db/learner.ts';
import { commandId, learnerId, type CommandId, type LearnerId, type Tick } from '../declarations/ids.ts';
import type {
  CommandContext,
  CommandReceipt,
  JsonObject,
  ValueSchema,
} from '../declarations/types.ts';
import type { LoadedModule } from '../loader.ts';
import { canonicalJsonString } from './canonical.ts';
import { createCommandReadContext } from './reads.ts';
import type {
  CommandHandler,
  CommandRequest,
  CommandRuntimeOptions,
  FactWriteTarget,
  WriteOptions,
} from './contracts.ts';
import { applyFactWrites } from './writes.ts';

type StoredCommand = {
  readonly type: string;
  readonly input: unknown;
  readonly state: CommandReceipt['state'];
  readonly receipt: unknown;
};

type CommandDeclaration = {
  readonly schema: ValueSchema<unknown>;
  readonly destructive: boolean;
  readonly read: ((ctx: CommandContext) => unknown) | undefined;
  readonly write: (ctx: CommandContext, input: unknown, read: unknown) => unknown;
};

type CommandModule = {
  readonly module: LoadedModule;
  readonly declaration: CommandDeclaration;
};

const terminalStates = new Set(['done', 'undone', 'rejected']);

function declarationFromRecord(value: Record<string, unknown>): CommandDeclaration {
  const { schema, destructive, read, write } = value;
  if (
    typeof schema !== 'object' || schema === null ||
    !('parse' in schema) || typeof schema.parse !== 'function' ||
    typeof destructive !== 'boolean' ||
    (read !== undefined && typeof read !== 'function') ||
    typeof write !== 'function'
  ) {
    throw new Error('Invalid command declaration');
  }
  return {
    schema: schema as ValueSchema<unknown>,
    destructive,
    read: read as CommandDeclaration['read'],
    write: write as CommandDeclaration['write'],
  };
}

function commandModules(modules: readonly LoadedModule[]) {
  const commands = new Map<string, CommandModule>();
  const facts = new Map<string, Record<string, unknown>>();
  for (const module of modules) {
    for (const [type, fact] of module.facts) {
      if (facts.has(type)) throw new Error(`Duplicate fact definition: ${type}`);
      facts.set(type, fact);
    }
    for (const [type, declarationRecord] of module.commands) {
      if (commands.has(type)) throw new Error(`Duplicate command definition: ${type}`);
      commands.set(type, { module, declaration: declarationFromRecord(declarationRecord) });
    }
  }
  return { commands, facts };
}

function validateRequest(request: CommandRequest): void {
  learnerId(request.learner);
  commandId(request.id);
  if (typeof request.type !== 'string' || request.type.length === 0) {
    throw new Error('Command type must be a non-empty string');
  }
  if (request.actor !== 'learner' && request.actor !== 'companion') {
    throw new Error('Command actor must be learner or companion');
  }
  if (typeof request.purpose !== 'string' || request.purpose.length === 0) {
    throw new Error('Command purpose must be a non-empty string');
  }
  canonicalJsonString(request.input);
}

function inputEnvelope(request: CommandRequest): JsonObject {
  return { actor: request.actor, purpose: request.purpose, input: request.input };
}

function sameIdentity(command: StoredCommand, request: CommandRequest): boolean {
  return command.type === request.type &&
    canonicalJsonString(command.input) === canonicalJsonString(inputEnvelope(request));
}

function checkReplay(command: StoredCommand, request: CommandRequest): CommandReceipt {
  if (!sameIdentity(command, request)) {
    throw new Error('Command ID already used with a different command identity');
  }
  const receipt = command.receipt;
  if (
    typeof receipt !== 'object' || receipt === null ||
    typeof (receipt as CommandReceipt).commandId !== 'string' ||
    (receipt as CommandReceipt).commandId !== request.id ||
    (command.state !== 'proposed' && !terminalStates.has(command.state))
  ) {
    throw new Error('Stored command receipt is invalid');
  }
  return receipt as CommandReceipt;
}

async function findStoredCommand(
  query: Pick<Db, 'query'>,
  learner: LearnerId,
  id: CommandId,
): Promise<StoredCommand | undefined> {
  const result = await query.query<StoredCommand>(
    'SELECT type, input, state, receipt FROM commands WHERE learner_id = $1 AND id = $2',
    [learner, id],
  );
  return result.rows[0];
}

async function insertCommand(
  tx: DbTransaction,
  request: CommandRequest,
  state: CommandReceipt['state'],
  receipt: CommandReceipt,
  tick: Tick,
): Promise<void> {
  await tx.insert('commands', {
    learner_id: request.learner,
    id: request.id,
    type: request.type,
    input: canonicalJsonString(inputEnvelope(request)),
    state,
    receipt: JSON.stringify(receipt),
    tick,
  });
}

function writeOptions(request: CommandRequest): WriteOptions {
  return { actor: request.actor, purpose: request.purpose, commandId: request.id };
}

async function saveProposal(
  db: Db,
  request: CommandRequest,
  declaration: CommandDeclaration,
): Promise<CommandReceipt> {
  return db.tx({ learner: request.learner }, async (tx) => {
    await lockLearner(tx, request.learner);
    const existing = await findStoredCommand(tx, request.learner, request.id);
    if (existing) return checkReplay(existing, request);

    declaration.schema.parse(request.input);
    const receipt: CommandReceipt = {
      commandId: request.id,
      state: 'proposed',
      wrote: [],
      proposals: [request.id],
    };
    await tx.withLearnerWrite(async (tick) => {
      await insertCommand(tx, request, 'proposed', receipt, tick);
      await tx.insert('proposals', {
        learner_id: request.learner,
        command_id: request.id,
        source_derivation_id: null,
        input: canonicalJsonString(request.input),
        state: 'pending',
        created_tick: tick,
        decided_tick: null,
        error: null,
      });
    });
    return receipt;
  });
}

async function executeCommand(
  db: Db,
  request: CommandRequest,
  options: CommandRuntimeOptions,
  command: CommandModule,
  writeTarget: FactWriteTarget,
): Promise<CommandReceipt> {
  return db.tx({ learner: request.learner }, async (tx) => {
    await lockLearner(tx, request.learner);
    const existing = await findStoredCommand(tx, request.learner, request.id);
    if (existing) return checkReplay(existing, request);

    const parsedInput = command.declaration.schema.parse(request.input);
    const commandContext: CommandContext = {
      learner: request.learner,
      read: createCommandReadContext(tx, request.purpose),
    };
    const readResult = await command.declaration.read?.(commandContext);
    const writes = await command.declaration.write(commandContext, parsedInput, readResult);

    return tx.withLearnerWrite(async (tick) => {
      const changes = await applyFactWrites(
        tx,
        tick,
        writes as readonly never[],
        writeOptions(request),
        writeTarget,
      );
      await options.hooks.onFactsChanged(tx, tick, changes);
      const receipt: CommandReceipt = {
        commandId: request.id,
        state: 'done',
        wrote: changes.map((change) => change.ref),
        proposals: [],
      };
      await insertCommand(tx, request, 'done', receipt, tick);
      return receipt;
    });
  });
}

export function createCommandHandler(
  db: Db,
  options: CommandRuntimeOptions,
): CommandHandler {
  const { commands, facts } = commandModules(options.modules);

  return async (request) => {
    validateRequest(request);
    const existing = await findStoredCommand(db, request.learner, request.id);
    if (existing) return checkReplay(existing, request);

    const command = commands.get(request.type);
    if (!command) throw new Error(`Unknown command: ${request.type}`);

    if (request.actor === 'companion' && command.declaration.destructive) {
      return saveProposal(db, request, command.declaration);
    }
    const grants = options.crossModuleWrites?.[request.type];
    return executeCommand(db, request, options, command, (type, kind) =>
      command.module.facts.get(type) ?? (grants?.[kind]?.includes(type) ? facts.get(type) : undefined));
  };
}
