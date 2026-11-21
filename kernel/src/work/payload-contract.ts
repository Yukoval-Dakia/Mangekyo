import type { CommandId, FactId } from '../declarations/ids.ts';

/** Identities fixed by the host before a durable work output can be sent or published. */
export type WorkPublication = { readonly factId: FactId; readonly commandId: CommandId };
