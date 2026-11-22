import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { storageRead } from './fact-read-helpers.ts';
import { commandId, factId } from '../../kernel/src/declarations/ids.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { pauseCare, resumeCare, readCarePause, carePauseTtlMs, type CarePauseStatus } from '../../modules/companion/care-pause.ts';
import { stableId, studioLearner } from './identity.ts';

const gateId = factId(stableId('care-pause', studioLearner));
const scope = { learner: studioLearner };

export function openCarePause(db: Db, companion: LoadedModule) {
  const handle = createCommandHandler(db, { modules: [companion], hooks: createStudioCommandHooks() });
  const status = (tx: ReadTransaction, now = Date.now()): Promise<CarePauseStatus> =>
    readCarePause(storageRead(tx), gateId, now);
  const read = () => db.snapshot(scope, tx => status(tx));
  return {
    gateId,
    status,
    /** Returns true while paid background research and proactive nudges must be held. */
    async paused(tx: ReadTransaction, now = Date.now()) {
      return (await status(tx, now)).active;
    },
    read,
    /** Record the short-lived gate after a carePause signal; idempotent within the TTL. */
    async pause(requestKey: string, now = Date.now()) {
      const current = await read();
      if (current.active) return current;
      await handle({
        ...scope, actor: 'learner', purpose: 'storage', type: pauseCare,
        id: commandId(stableId('pause-care', gateId, requestKey)),
        input: { id: gateId, revision: current.revision, now: new Date(now).toISOString() },
      });
      return read();
    },
    /** Learner-initiated resume; clears the gate immediately. */
    async resume() {
      const current = await read();
      if (!current.revision) return current;
      if (!current.active) return current;
      await handle({
        ...scope, actor: 'learner', purpose: 'storage', type: resumeCare,
        id: commandId(stableId('resume-care', gateId, String(current.revision), String(Date.now()))),
        input: { id: gateId, revision: current.revision },
      });
      return read();
    },
  };
}

export type CarePause = ReturnType<typeof openCarePause>;
