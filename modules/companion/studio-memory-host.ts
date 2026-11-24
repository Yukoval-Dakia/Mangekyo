import { commandId, factId, isFactNotFound, type CommandHooks, type Db, type ReadTransaction } from '@mangekyo/kernel';
import { memoryValue } from './memory.ts';
import { validateCompanionMemoryInput } from './memory-slice.ts';

type LoadedModule = any;
export type StudioMemoryDeps = Record<string, any>;

export const memoryId = (deps: StudioMemoryDeps) => factId(deps.stableId('companion-memory', deps.studioHost(null as any).learner));

export async function currentMemory(deps: StudioMemoryDeps, tx: ReadTransaction) {
  try {
    const fact = await deps.createCommandReadContext(tx, deps.purpose).fact(memoryId(deps), { mode: 'following' });
    return { ...memoryValue(fact.value), revision: fact.ref.rev };
  } catch (error) {
    if (!isFactNotFound(error)) throw error;
    return { text: '', endpoint: '', providerId: 'default', protocol: 'openai', revision: 0 };
  }
}

export function openMemory(deps: StudioMemoryDeps, db: Db, module: LoadedModule, hooks: CommandHooks = deps.createStudioCommandHooks()) {
  const host = deps.studioHost(db), handle = host.boundHandler([module], hooks), read = () => host.snapshot((tx: ReadTransaction) => currentMemory(deps, tx));
  return { read, async save(input: Record<string, unknown>) {
    const request = deps.clientRequest(input.requestId), settings = await deps.loadSettings('companion'), endpoint = settings.baseUrl;
    if (input.endpoint !== endpoint || !deps.routeMatchesInput(input.route, settings)) throw new deps.RequestError(409, '模型端点已变更，请重新确认。');
    const parsed = validateCompanionMemoryInput(input);
    if (!parsed) throw new deps.RequestError(400, '备忘最长 800 字，需要原版本。');
    try {
      await handle({ purpose: deps.purpose, type: 'companion.saveMemory', id: commandId(deps.stableId('companion-memory-save', request)),
        input: { id: memoryId(deps), revision: parsed.revision, data: { text: parsed.text, endpoint, providerId: settings.activeProviderId, protocol: settings.protocol } } });
    } catch (error) {
      const kind = deps.classifyKernelError(error).kind;
      if (kind === 'revision_conflict' || kind === 'already_exists' || kind === 'duplicate_command') throw new deps.RequestError(409, '备忘已经有更新，请重新核对。');
      throw error;
    }
    return read();
  } };
}
