import { type Db } from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { studioHost, storageRead } from './fact-read-helpers.ts';
import { stableId } from './identity.ts';
import { openCarePause as openCarePauseHost, type CarePause } from '../../modules/companion/studio-care-pause-host.ts';
export type { CarePause };

export const openCarePause = (db: Db, companion: LoadedModule) =>
  openCarePauseHost({ stableId, studioHost, storageRead, createStudioCommandHooks }, db, companion);
