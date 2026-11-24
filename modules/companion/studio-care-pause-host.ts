import { commandId, factId, type Db, type ReadTransaction } from '@mangekyo/kernel';
import { pauseCare, resumeCare, readCarePause, type CarePauseStatus } from './care-pause.ts';

type LoadedModule = any;
export type StudioCarePauseDeps = {
  readonly stableId: (...parts: string[]) => string;
  readonly studioHost: (db: Db) => any;
  readonly storageRead: (tx: ReadTransaction) => any;
  readonly createStudioCommandHooks: () => any;
};

export function openCarePause(deps: StudioCarePauseDeps, db: Db, companion: LoadedModule) {
  const gateId = factId(deps.stableId('care-pause', deps.studioHost(db).learner));
  const host = deps.studioHost(db);
  const handle = host.boundHandler([companion], deps.createStudioCommandHooks());
  const status = (tx: ReadTransaction, now = Date.now()): Promise<CarePauseStatus> =>
    readCarePause(deps.storageRead(tx), gateId, now);
  const read = () => host.snapshot((tx: ReadTransaction) => status(tx));
  const run = (type: string, input: Record<string, unknown>, ...idParts: string[]) =>
    handle({ type, purpose: 'storage', input: { id: gateId, ...input }, id: commandId(deps.stableId(...idParts)) });
  return {
    gateId,
    status,
    async paused(tx: ReadTransaction, now = Date.now()) { return (await status(tx, now)).active; },
    read,
    async pause(requestKey: string, now = Date.now()) {
      const current = await read();
      if (current.active) return current;
      await run(pauseCare, { revision: current.revision, now: new Date(now).toISOString() }, 'pause-care', gateId, requestKey);
      return read();
    },
    async resume() {
      const current = await read();
      if (!current.revision || !current.active) return current;
      await run(resumeCare, { revision: current.revision }, 'resume-care', gateId, String(current.revision), String(Date.now()));
      return read();
    },
  };
}
export type CarePause = ReturnType<typeof openCarePause>;
