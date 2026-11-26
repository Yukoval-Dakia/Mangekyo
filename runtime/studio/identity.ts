import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  commandId, createAuthorizedFactReader, createCommandReadContext, createLearnerHost,
  factId, learnerId, type Db, type FactId, type FactSnapshot, type LearnerHost, type LearnerId, type ReadTransaction, type Revision, type Tick,
} from '../../kernel/src/index.ts';
import { loadModuleDirectory, type LoadedModule } from '../../kernel/src/loader.ts';
import { RequestError } from '../../modules/capture/request.ts';
export function stableId(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 26).toUpperCase();
}
export const studioLearner = learnerId(stableId('studio', 'synthetic-histories-v1'));
export const requestCommand = (request: string) => commandId(stableId('submission', request));
export const textbookUndoId = (token: string) => commandId(stableId('undo-textbook-write', token));
export const firstTurn = (request: string) => factId(stableId('session', request));
export const nextTurn = (session: string, parent: string) => factId(stableId('answer', session, parent));
export const sourceId = (studyCase: string, id: string) =>
  factId(stableId('learning-history-v1', studyCase, id));
export const slotType = 'activity.teachingFeedback';
export const methodName = 'activity/evidence-tutor';
export const learningToolsMethod = 'activity/evidence-tutor-learning-tools-v1';
export const confirmedTeachingMethod = 'activity/evidence-tutor-confirmed-v1';
export const purpose = 'teaching';
export const ulidPattern = '[0-9A-HJKMNP-TV-Z]{26}';
export const ulidExact = new RegExp(`^${ulidPattern}$`);
export const studioHost = (db: Db, options: { learner?: LearnerId; actor?: 'learner' | 'companion' } = {}): LearnerHost =>
  createLearnerHost(db, options.learner ?? studioLearner, { ...(options.actor ? { actor: options.actor } : {}) });
export const storageRead = (tx: ReadTransaction) => createCommandReadContext(tx, 'storage');
export const teachingRead = (tx: ReadTransaction) => createCommandReadContext(tx, 'teaching');
export const purposeReader = (tx: ReadTransaction, maySend: (fact: FactSnapshot) => boolean) =>
  createAuthorizedFactReader(tx, 'teaching', maySend);
export function toWitness<M extends 'pinned' | 'following'>(
  fact: FactSnapshot, mode: M,
): { id: FactId; rev: Revision; epoch: Tick; type: string; mode: M };
export function toWitness(
  fact: FactSnapshot, mode?: 'pinned' | 'following',
): { id: FactId; rev: Revision; epoch: Tick; type: string; mode?: 'pinned' | 'following' };
export function toWitness(fact: FactSnapshot, mode?: 'pinned' | 'following') {
  return { id: fact.ref.id, rev: fact.ref.rev, epoch: fact.accessEpoch, type: fact.type, ...(mode ? { mode } : {}) };
}
export function parseRequest<T>(parse: () => T, fallback = '请求格式无效。'): T {
  try { return parse(); }
  catch (error) { throw new RequestError(400, error instanceof Error ? error.message : fallback); }
}
export function notionModelRecipient(id: string, endpoint: string, protocol: string, model: string, revision: string) {
  return 'studio:model:' + stableId(id, endpoint, protocol, model, revision);
}
export function modelRecipientId(
  route: { providerId?: string | undefined; activeProviderId?: string | undefined; baseUrl: string; protocol?: string | undefined; model: string },
  revision: string,
) {
  return notionModelRecipient(route.providerId ?? route.activeProviderId ?? 'default', route.baseUrl, route.protocol ?? '', route.model, revision);
}
const loadedModules = new Map<string, Promise<LoadedModule>>();
export function studioModule(name: string): Promise<LoadedModule> {
  let loaded = loadedModules.get(name);
  if (!loaded) {
    loaded = loadModuleDirectory(fileURLToPath(new URL(`../../modules/${name}`, import.meta.url)));
    loadedModules.set(name, loaded);
  }
  return loaded;
}
