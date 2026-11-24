import { createHmac, randomBytes } from 'node:crypto';
import { type Db, type CommandHooks } from '../../kernel/src/index.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { studioHost } from './fact-read-helpers.ts';
import { stableId } from './identity.ts';
import { RequestError } from './sessions.ts';
import { openTakeaway as openTakeawayHost } from '../../modules/activity/studio-takeaway-host.ts';

export const openTakeaway = (db: Db, activity: LoadedModule, hooks: CommandHooks = createStudioCommandHooks()) =>
  openTakeawayHost({ stableId, canonicalJsonString, createHmac, randomBytes, studioHost, createStudioCommandHooks: () => hooks, RequestError }, db, activity, hooks);
