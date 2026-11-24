import { type Db, type CommandHooks } from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { captureMaterial } from '../../modules/capture/intake-values.ts';
import { materialType, textMaterial } from '../../modules/content/text-material.ts';
import { goalType, setStudyGoal, studyGoal } from '../../modules/plan/goal-values.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { studioHost } from './fact-read-helpers.ts';
import { stableId } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { readMaterialText } from './reading.ts';
import { openLibrary as openLibraryHost } from '../../modules/companion/studio-library-host.ts';

const validate = <Value>(parse: (input: unknown) => Value, input: unknown, message: string) => {
  try { return parse(input); } catch { throw new RequestError(400, message); }
};

export const openLibrary = (db: Db, captureModule: LoadedModule, content: LoadedModule, plan: LoadedModule,
  hooks: CommandHooks = createStudioCommandHooks()) =>
  openLibraryHost({ stableId, studioHost, createStudioCommandHooks: () => hooks, clientRequest, RequestError, readMaterialText, validate,
    storagePurpose, captureMaterial, materialType, textMaterial, goalType, setStudyGoal, studyGoal }, db, captureModule, content, plan, hooks);
