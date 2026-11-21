import { assertDeletionWatermark, assertUnburned } from '../lifecycle.ts';
import type { Db, DbTransaction, ReadTransaction } from '../db/types.ts';
import { lockLearner } from '../db/learner.ts';
import { commandId, learnerId, type CommandId, type LearnerId, type Tick } from '../declarations/ids.ts';
import type {
  CommandContext,
  CommandReceipt,
  FactWrite,
  Json,
  JsonObject,
  ValueSchema,
} from '../declarations/types.ts';
import type { LoadedModule } from '../loader.ts';
import { canonicalJsonString } from './canonical.ts';
import { createCommandReadContext } from './reads.ts';
import type {
  CommandRequest,
  CommandRuntimeOptions,
  FactWriteTarget,
  WriteOptions,
} from './contracts.ts';
import { applyFactWrites } from './writes.ts';


async function checkLifetime(tx: ReadTransaction, request: CommandRequest) {
  await assertUnburned(tx, 'command', [request.id]);
  if (request.deletionWatermark !== undefined) await assertDeletionWatermark(tx, request.deletionWatermark);
}

type StoredCommand = {
  readonly type: string;
  readonly input: unknown;
  readonly state: CommandReceipt['state'];
  readonly receipt: unknown;
};

type CommandDeclaration = {
  readonly schema: ValueSchema<unknown>;
  readonly destructive: boolean;
  readonly requiredPurpose?: string;
  readonly read: ((ctx: CommandContext) => unknown) | undefined;
  readonly write: (ctx: CommandContext, input: unknown, read: unknown) => unknown;
};

type CommandModule = {
  readonly module: LoadedModule;
  readonly declaration: CommandDeclaration;
};

const terminalStates = new Set(['done', 'undone', 'rejected']);

function declarationFromRecord(value: Record<string, unknown>): CommandDeclaration {
  const { schema, destructive, requiredPurpose, read, write } = value;
  if (
    typeof schema !== 'object' || schema === null ||
    !('parse' in schema) || typeof schema.parse !== 'function' ||
    typeof destructive !== 'boolean' ||
    (requiredPurpose !== undefined && (typeof requiredPurpose !== 'string' || !requiredPurpose.trim())) ||
    (read !== undefined && typeof read !== 'function') ||
    typeof write !== 'function'
  ) {
    throw new Error('Invalid command declaration');
  }
  return {
    schema: schema as ValueSchema<unknown>,
    destructive,
    ...(requiredPurpose !== undefined ? { requiredPurpose } : {}),
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

async function beginCommand(tx: DbTransaction, request: CommandRequest, declaration: CommandDeclaration) {
  await lockLearner(tx, request.learner);
  await checkLifetime(tx, request);
  const existing = await findStoredCommand(tx, request.learner, request.id);
  if (existing) return checkReplay(existing, request);
  if (declaration.requiredPurpose !== undefined && request.purpose !== declaration.requiredPurpose) {
    throw new Error(`Command ${request.type} requires purpose ${declaration.requiredPurpose}`);
  }
  return null;
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
  hooks: CommandRuntimeOptions['hooks'],
): Promise<CommandReceipt> {
  return db.tx({ learner: request.learner }, async (tx) => {
    const replay = await beginCommand(tx, request, declaration);
    if (replay) return replay;

    const input = request.input;
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const fields = input as JsonObject;
      const subjects = [fields.id,fields.intakeId,fields.materialId].filter((value): value is string => typeof value === 'string');
      await assertUnburned(tx,'fact',subjects);
    }
    declaration.schema.parse(request.input);
    await hooks.beforeProposal?.(tx, request);
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

type Proposal = {
  readonly id: CommandId;
  readonly input: Json;
  readonly state: 'pending' | 'confirmed' | 'rejected' | 'conflict';
};

export async function readCommandProposals(tx: ReadTransaction, type: string, match: JsonObject, id?: CommandId) {
  const { rows } = await tx.query<Proposal>(
    `SELECT p.command_id AS id,p.input,p.state FROM proposals p
     JOIN commands c ON (c.learner_id,c.id)=(p.learner_id,p.command_id)
     WHERE p.learner_id=$1 AND c.type=$2 AND p.input @> $3::jsonb AND ($4::text IS NULL OR p.command_id=$4)
     ORDER BY p.created_tick DESC,p.command_id DESC LIMIT 50`,
    [tx.learner, type, canonicalJsonString(match), id ?? null],
  );
  return rows;
}

export function readRecordedCommand(tx: ReadTransaction, id: CommandId) {
  return findStoredCommand(tx, tx.learner, id);
}

async function declaredWrites(
  tx: DbTransaction, request: CommandRequest, command: CommandModule, input: Json,
  bindRead: CommandRuntimeOptions['bindCommandRead'],
) {
  const parsedInput = command.declaration.schema.parse(input);
  const base = createCommandReadContext(tx, request.purpose);
  const context: CommandContext = {
    learner: request.learner,
    read: bindRead ? bindRead(tx, request, base) : base,
  };
  const readResult = await command.declaration.read?.(context);
  return await command.declaration.write(context, parsedInput, readResult) as readonly FactWrite[];
}

async function commitCommand(
  tx: DbTransaction, request: CommandRequest, options: CommandRuntimeOptions,
  writes: readonly FactWrite[], writeTarget: FactWriteTarget,
  decide?: { readonly proposalId: CommandId; readonly state: 'confirmed' | 'rejected' },
): Promise<CommandReceipt> {
  return tx.withLearnerWrite(async (tick) => {
    const changes = decide?.state === 'rejected' ? [] :
      await applyFactWrites(tx, tick, writes, writeOptions(request), writeTarget);
    const scopedPurposeChanges = changes.flatMap(({ref, scopedPurpose}) => scopedPurpose === undefined ? [] :
      [{id: ref.id, rev: ref.rev, purpose: scopedPurpose}]);
    const receipt: CommandReceipt = {
      commandId: request.id,
      state: decide?.state === 'rejected' ? 'rejected' : 'done',
      wrote: changes.map((change) => change.ref),
      proposals: [],
      ...(scopedPurposeChanges.length ? {scopedPurposeChanges} : {}),
      ...(decide ? {output: request.input} : {}),
    };
    await insertCommand(tx, request, receipt.state, receipt, tick);
    if (decide?.state !== 'rejected') await options.hooks.onFactsChanged(tx, tick, changes);
    if (decide) await tx.query(
      'UPDATE proposals SET state=$3, decided_tick=$4 WHERE learner_id=$1 AND command_id=$2',
      [request.learner, decide.proposalId, decide.state, tick],
    );
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
    const replay = await beginCommand(tx, request, command.declaration);
    if (replay) return replay;

    const writes = await declaredWrites(tx, request, command, request.input, options.bindCommandRead);
    return commitCommand(tx, request, options, writes, writeTarget);
  });
}

export function createCommandHandler(
  db: Db,
  options: CommandRuntimeOptions,
) {
  const { commands, facts } = commandModules(options.modules);

  function writeTarget(command: CommandModule, type: string): FactWriteTarget {
    const grants = options.crossModuleWrites?.[type];
    return (fact, kind) => command.module.facts.get(fact) ?? (grants?.[kind]?.includes(fact) ? facts.get(fact) : undefined);
  }
  const handle = async (request: CommandRequest) => {
    validateRequest(request);
    const command = commands.get(request.type);
    if (!command) return db.snapshot({learner:request.learner}, async tx => {
      await checkLifetime(tx,request);
      const recorded = await findStoredCommand(tx,tx.learner,request.id);
      if (recorded) return checkReplay(recorded,request);
      throw new Error(`Unknown command: ${request.type}`);
    });

    if (request.actor === 'companion' && command.declaration.destructive) {
      return saveProposal(db, request, command.declaration, options.hooks);
    }
    return executeCommand(db, request, options, command, writeTarget(command, request.type));
  };
  return Object.assign(handle, {
    async decideProposal(
      decision: Omit<CommandRequest, 'actor' | 'input'> & { proposalId: CommandId; selection: Json },
      select: (tx: ReadTransaction, proposedInput: Json) => Promise<Json | null>,
    ) {
      const { proposalId, selection, ...identity } = decision;
      const request: CommandRequest = {...identity, actor:'learner', input:{proposalId, selection}};
      validateRequest(request);
      commandId(proposalId);
      const command = commands.get(request.type);
      if (!command?.declaration.destructive) throw new Error('Command does not support proposals');
      return db.tx({learner:request.learner}, async tx => {
        const replay = await beginCommand(tx, request, command.declaration);
        if (replay) return replay;
        const [proposal] = await readCommandProposals(tx, request.type, {}, proposalId);
        if (!proposal) throw new Error('Proposal not found');
        if (proposal.state !== 'pending') throw new Error('Proposal already decided');
        const input = await select(tx, proposal.input);
        const writes = input === null ? [] : await declaredWrites(tx, request, command, input, options.bindCommandRead);
        return commitCommand(tx, request, options, writes, writeTarget(command, request.type),
          {proposalId, state:input === null ? 'rejected' : 'confirmed'});
      });
    },
  });
}
