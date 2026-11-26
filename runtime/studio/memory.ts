import { classifyKernelError, commandId, createCommandReadContext, factId, isFactNotFound, type CommandHooks, type Db, type ReadTransaction } from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { memoryValue } from '../../modules/companion/memory.ts';
import { validateCompanionMemoryInput } from '../../modules/companion/memory-slice.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { routeMatchesInput } from './harness.ts';
import { purpose, stableId, studioHost, studioLearner } from './identity.ts';
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
  const host = studioHost(db), handle = host.boundHandler([module], hooks), read = () => host.snapshot(currentMemory);
  return { read, async save(input: Record<string, unknown>) {
    const request = clientRequest(input.requestId), settings = await loadSettings('companion'), endpoint = settings.baseUrl;
    if (input.endpoint !== endpoint || !routeMatchesInput(input.route, settings)) throw new RequestError(409, '模型端点已变更，请重新确认。');
    const parsed = validateCompanionMemoryInput(input);
    if (!parsed) throw new RequestError(400, '备忘最长 800 字，需要原版本。');
    try {
      await handle({ purpose, type: 'companion.saveMemory', id: commandId(stableId('companion-memory-save', request)),
        input: { id: memoryId, revision: parsed.revision, data: { text: parsed.text, endpoint, providerId: settings.activeProviderId, protocol: settings.protocol } } });
    } catch (error) {
      const kind = classifyKernelError(error).kind;
      if (kind === 'revision_conflict' || kind === 'already_exists' || kind === 'duplicate_command') throw new RequestError(409, '备忘已经有更新，请重新核对。');
      throw error;
    }
    return read();
  } };
}
