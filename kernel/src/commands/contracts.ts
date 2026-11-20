import type { DbTransaction } from '../db/types.ts';
import type { CommandId, LearnerId, Tick } from '../declarations/ids.ts';
import type { CommandReceipt, FactRef, FactWrite, Json, ReadContext } from '../declarations/types.ts';
import type { LoadedModule } from '../loader.ts';

export type Actor = 'learner' | 'companion';
export type CommandRequest = {
  readonly learner: LearnerId;
  readonly id: CommandId;
  readonly type: string;
  readonly input: Json;
  readonly actor: Actor;
  readonly purpose: string;
};
export type FactWriteTarget = (type: string, kind: FactWrite['kind']) => Record<string, unknown> | undefined;
export type CrossModuleWrites = Readonly<Record<string, Readonly<Partial<Record<FactWrite['kind'], readonly string[]>>>>>;
export type WriteOptions = { readonly actor: Actor; readonly purpose: string; readonly commandId: CommandId };
export type FactChange = {
  readonly ref: FactRef;
  readonly factType: string;
  readonly kind: FactWrite['kind'];
  readonly scopedPurpose?: string;
};
export type CommandHooks = {
  readonly beforeProposal?: (tx: DbTransaction, request: CommandRequest) => Promise<void>;
  // Required transactional handoff. Propagation/scheduling owns the implementation in unit 4.
  readonly onFactsChanged: (tx: DbTransaction, tick: Tick, changes: readonly FactChange[]) => Promise<void>;
};
export type CommandRuntimeOptions = {
  readonly modules: readonly LoadedModule[];
  readonly hooks: CommandHooks;
  // The host may authorize specific commands to write specific foreign fact types.
  readonly crossModuleWrites?: CrossModuleWrites;
};
export type CommandHandler = (request: CommandRequest) => Promise<CommandReceipt>;
export type CommandReaderFactory = (tx: DbTransaction, purpose: string) => ReadContext;
