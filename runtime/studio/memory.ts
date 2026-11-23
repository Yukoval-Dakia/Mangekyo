import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { Db } from '../../kernel/src/db/types.ts';
import { commandId, factId, type ReadTransaction } from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { memoryValue } from '../../modules/companion/memory.ts';
import { isCompanionMemoryConflict, validateCompanionMemoryInput } from '../../modules/companion/memory-slice.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { createCommandReadContext, isFactNotFound } from './fact-read-helpers.ts';
import { routeMatchesInput } from './harness.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { loadSettings } from './settings.ts';

export const memoryId = factId(stableId('companion-memory', studioLearner));
export async function currentMemory(tx: ReadTransaction) {
  try {
    const fact = await createCommandReadContext(tx, purpose).fact(memoryId, { mode: 'following' });
    return { ...memoryValue(fact.value), revision: fact.ref.rev };
  } catch (error) {
    if (!isFactNotFound(error)) throw error;
    return { text: '', endpoint: '', providerId: 'default', protocol: 'openai', revision: 0 };
  }
}
export function openMemory(db: Db, module: LoadedModule, hooks: CommandHooks = createStudioCommandHooks()) {
  const handle = createCommandHandler(db, { modules: [module], hooks });
  const read = () => db.snapshot({ learner: studioLearner }, currentMemory);
  return { read, async save(input: Record<string, unknown>) {
    const request = clientRequest(input.requestId), settings = await loadSettings('companion'), endpoint = settings.baseUrl;
    if (input.endpoint !== endpoint || !routeMatchesInput(input.route, settings)) throw new RequestError(409, '模型端点已变更，请重新确认。');
    const parsed = validateCompanionMemoryInput(input);
    if (!parsed) throw new RequestError(400, '备忘最长 800 字，需要原版本。');
    try {
      await handle({ learner: studioLearner, actor: 'learner', purpose, type: 'companion.saveMemory',
        id: commandId(stableId('companion-memory-save', request)),
        input: { id: memoryId, revision: parsed.revision, data: { text: parsed.text, endpoint, providerId: settings.activeProviderId, protocol: settings.protocol } } });
    } catch (error) {
      if (isCompanionMemoryConflict(error)) throw new RequestError(409, '备忘已经有更新，请重新核对。');
      throw error;
    }
    return read();
  } };
}
