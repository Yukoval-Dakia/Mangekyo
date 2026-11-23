import { commandId, createLearnerHost, factId, type Db, type ReadTransaction } from '../../kernel/src/index.ts';
import { storageRead } from './fact-read-helpers.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { pauseCare, resumeCare, readCarePause, carePauseTtlMs, type CarePauseStatus } from '../../modules/companion/care-pause.ts';
import { stableId, studioLearner } from './identity.ts';

const gateId = factId(stableId('care-pause', studioLearner));

export function openCarePause(db: Db, companion: LoadedModule) {
  const host = createLearnerHost(db, studioLearner);
  const handle = host.boundHandler([companion], createStudioCommandHooks());
  const status = (tx: ReadTransaction, now = Date.now()): Promise<CarePauseStatus> =>
    readCarePause(storageRead(tx), gateId, now);
  const read = () => host.snapshot(tx => status(tx));
  const run = (type: string, input: Record<string, unknown>, key: string) =>
    handle({ type, purpose: 'storage', input: { id: gateId, ...input }, id: commandId(stableId(key, gateId)) });
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
      await run(pauseCare, { revision: current.revision, now: new Date(now).toISOString() }, 'pause-care|' + requestKey);
      return read();
    },
    /** Learner-initiated resume; clears the gate immediately. */
    async resume() {
      const current = await read();
      if (!current.revision) return current;
      if (!current.active) return current;
      await run(resumeCare, { revision: current.revision }, 'resume-care|' + current.revision + '|' + Date.now());
      return read();
    },
  };
}

export type CarePause = ReturnType<typeof openCarePause>;
