import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, FactNotFoundError } from '../../kernel/src/commands/reads.ts';
import { commandId, factId } from '../../kernel/src/declarations/ids.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { memoryValue } from '../../modules/companion/memory.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import { routeMatchesInput } from './harness.ts';
import { loadSettings } from './settings.ts';
import { RequestError, clientRequest } from './sessions.ts';

export const memoryId = factId(stableId('companion-memory', studioLearner));
export async function currentMemory(tx: ReadTransaction) {
  try {
    const fact = await createCommandReadContext(tx, purpose).fact(memoryId, { mode: 'following' });
    return { ...memoryValue(fact.value), revision: fact.ref.rev };
  } catch (error) {
    if (!(error instanceof FactNotFoundError)) throw error;
    return { text: '', endpoint: '', providerId: 'default', protocol: 'openai', revision: 0 };
  }
}
export function openMemory(db: Db, module: LoadedModule, hooks: CommandHooks = createStudioCommandHooks()) {
  const handle = createCommandHandler(db, { modules: [module], hooks });
  const read = () => db.snapshot({ learner: studioLearner }, currentMemory);
  return { read, async save(input: Record<string, unknown>) {
    const request = clientRequest(input.requestId);
    const settings = await loadSettings('companion');
    const endpoint = settings.baseUrl;
    if (input.endpoint !== endpoint || !routeMatchesInput(input.route, settings)) throw new RequestError(409, '模型端点已变更，请重新确认。');
    if (typeof input.text !== 'string' || input.text.length > 800 || !input.text.isWellFormed() || input.text.includes('\0') ||
        typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0)
      throw new RequestError(400, '备忘最长 800 字，需要原版本。');
    try {
      await handle({ learner: studioLearner, actor: 'learner', purpose, type: 'companion.saveMemory',
        id: commandId(stableId('companion-memory-save', request)), input: { id: memoryId,
          revision: input.revision, data: { text: input.text, endpoint, providerId: settings.activeProviderId, protocol: settings.protocol } } });
    } catch (error) {
      if (error instanceof Error && /Fact revision conflict|Fact already exists|Command ID already used/.test(error.message))
        throw new RequestError(409, '备忘已经有更新，请重新核对。');
      throw error;
    }
    return read();
  } };
}
