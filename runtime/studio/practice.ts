import { type Db } from '../../kernel/src/index.ts';
import { assertDeletionWatermark, assertUnburned } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { submittedWatermark } from '../../modules/capture/request.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { studioHost } from './fact-read-helpers.ts';
import { stableId } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { openPractice as openPracticeHost } from '../../modules/activity/studio-practice-host.ts';

export const openPractice = (db: Db, activity: LoadedModule, hooks = createStudioCommandHooks()) =>
  openPracticeHost({ stableId, studioHost, createStudioCommandHooks: () => hooks, clientRequest, RequestError, submittedWatermark, assertDeletionWatermark, assertUnburned }, db, activity, hooks);
