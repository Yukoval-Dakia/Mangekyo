import { classifyKernelError, commandId, createCommandReadContext, factId, type Db, type ReadTransaction } from '../../kernel/src/index.ts';
import { studioHost } from './fact-read-helpers.ts';
import { routeMatchesInput } from './harness.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { loadSettings } from './settings.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { openMemory as openMemoryHost, currentMemory as currentMemoryHost } from '../../modules/companion/studio-memory-host.ts';

export const memoryId = factId(stableId('companion-memory', studioLearner));
export const currentMemory = (tx: ReadTransaction) => currentMemoryHost({ stableId, studioHost, createCommandReadContext, purpose }, tx);
export const openMemory = (db: Db, module: unknown, hooks = createStudioCommandHooks()) =>
  openMemoryHost({ stableId, studioHost, createStudioCommandHooks: () => hooks, clientRequest, RequestError, loadSettings, routeMatchesInput, classifyKernelError, createCommandReadContext, purpose }, db, module, hooks);
