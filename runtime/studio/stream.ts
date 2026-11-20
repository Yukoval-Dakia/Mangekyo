import { attachmentCurrent } from './reading.ts';
import type { ServerResponse } from 'node:http';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { factId } from '../../kernel/src/declarations/ids.ts';
import { parseManifest, type Manifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import type { Pool, PoolClient } from 'pg';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, DbQuery, ReadTransaction } from '../../kernel/src/db/types.ts';
import { workerStorage } from '../../kernel/src/schema.ts';
import { readReadyWork, type WorkRef } from '../../kernel/src/work/index.ts';
import type { TeachingProgress } from '../../executors/teaching/index.ts';
import { purpose, slotType, studioLearner } from './identity.ts';
import { RequestError, sessionMountPermissions, unavailableReplyMessage } from './sessions.ts';
import { workspaceGrantChecker } from './harness.ts';
import type { RecallHttp } from './recall-http.ts';
import { RecallRequestError } from './recall.ts';

import {turnArtifacts} from './presentation-store.ts';

type Phase = TeachingProgress['phase'];
type StreamSession = {
  id: string;
  caseId: string;
  currentTurnId: string;
  status: 'pending' | 'ready' | 'failed' | 'unknown';
  pendingAnswer?: string;
};

export async function prepareSessionEvents(db: Db): Promise<void> {
  await db.schemaTransaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7264041, hashtext(current_schema()::text))');
    // A live draft is disposable. The completed derivation is stored by finishWork.
    await tx.query(`CREATE UNLOGGED TABLE IF NOT EXISTS studio_turn_stream (
      learner_id text NOT NULL,
      turn_id text NOT NULL,
      phase text NOT NULL CHECK (phase IN ('thinking', 'reading', 'checking', 'replying')),
      message text NOT NULL CHECK (length(message) <= 12000),
      manifest jsonb NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      PRIMARY KEY (learner_id, turn_id),
      FOREIGN KEY (learner_id, turn_id) REFERENCES facts(learner_id, id) ON DELETE CASCADE
    )`);
  });
}

async function notify(tx: DbQuery, sessionId: string) {
  await tx.query(
    `SELECT pg_notify('studio_teaching_' || lower(store_id), $1) FROM kernel_runtime_identity WHERE singleton`,
    [sessionId],
  );
}

export async function publishTurnProgress(
  db: Db,
  ref: WorkRef,
  turnId: string,
  sessionId: string,
  progress: TeachingProgress,
  validate: (tx: ReadTransaction) => Promise<Manifest>,
): Promise<void> {
  await db.tx({ learner: studioLearner }, async (tx) => {
    await lockLearner(tx, studioLearner);
    if ((await readReadyWork(tx, ref))?.slotKey !== turnId) return;
    const manifest = await validate(tx);
    const written = await tx.query(
      `INSERT INTO studio_turn_stream (learner_id, turn_id, phase, message, manifest)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (learner_id, turn_id) DO UPDATE SET
         phase=EXCLUDED.phase, message=EXCLUDED.message, manifest=EXCLUDED.manifest, revision=studio_turn_stream.revision+1
       WHERE (studio_turn_stream.phase, studio_turn_stream.message) IS DISTINCT FROM (EXCLUDED.phase, EXCLUDED.message)`,
      [tx.learner, turnId, progress.phase, progress.phase === 'replying' ? progress.message : '', JSON.stringify(manifest)],
    );
    if (written.rowCount) await notify(tx, sessionId);
  });
}

export async function completeTurnStream(tx: ReadTransaction, turnId: string) {
  await tx.query('DELETE FROM studio_turn_stream WHERE learner_id=$1 AND turn_id=$2', [tx.learner, turnId]);
  const { rows: [row] } = await tx.query<{ sessionId: string }>(
    `SELECT r.data->>'sessionId' AS "sessionId" FROM facts f
     JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev
     WHERE f.learner_id=$1 AND f.id=$2 AND f.type='activity.studyTurn'`,
    [tx.learner, turnId],
  );
  // Delivered only after the acceptance (or failure) transaction commits.
  if (row?.sessionId) await notify(tx, row.sessionId);
}

type Subscriber = { sessionId: string; refresh: () => void; disconnect: () => void };
const subscriptions = new WeakMap<Db, Set<Subscriber>>();

export async function listenForSessionEvents(db: Db, pool: Pool): Promise<() => void> {
  const channel = 'studio_teaching_' + (await workerStorage(db)).toLowerCase();
  const subscribers = new Set<Subscriber>();
  let current: PoolClient | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const disconnectSubscribers = () => {
    subscriptions.delete(db);
    for (const subscriber of subscribers) subscriber.disconnect();
  };

  function scheduleReconnect() {
    reconnect = setTimeout(() => {
      void listen().catch(scheduleReconnect);
    }, 1000);
    reconnect.unref();
  }

  async function listen() {
    if (stopped) return;
    const client = await pool.connect();
    if (stopped) {
      client.release(true);
      return;
    }
    current = client;
    const lost = () => {
      if (current !== client) return;
      current = undefined;
      client.release(true);
      disconnectSubscribers();
      if (!stopped) scheduleReconnect();
    };
    client.on('error', lost);
    client.once('end', lost);
    client.on('notification', ({ channel: received, payload }) => {
      if (received !== channel) return;
      for (const subscriber of subscribers) {
        if (subscriber.sessionId === payload) subscriber.refresh();
      }
    });
    try {
      // Quoting permits the identifier while escaping any quote defensively.
      await client.query('LISTEN "' + channel.replaceAll('"', '""') + '"');
    } catch (error) {
      if (current === client) {
        current = undefined;
        client.release(true);
        throw error;
      }
    }
    if (current === client) subscriptions.set(db, subscribers);
  }

  await listen();
  return () => {
    stopped = true;
    clearTimeout(reconnect);
    disconnectSubscribers();
    const client = current;
    current = undefined;
    client?.release(true);
  };
}

async function readSessionEvent(db: Db, sessionId: string) {
  const grantCurrent = workspaceGrantChecker();
  return db.snapshot({ learner: studioLearner }, async (tx) => {
    const { rows: [row] } = await tx.query<{
      turnId: string;
      derivationId: string | null;
      message: string | null;
      settled: boolean;
      studyKit: unknown;
      hasStudyKit: boolean | null;
      status: 'failed' | 'unknown' | null;
      manifest: unknown;
      phase: Phase | null;
      revision: number | null;
      draft: string | null;
      draftManifest: unknown;
    }>(
      `SELECT f.id AS "turnId", d.id AS "derivationId", d.value->>'message' AS message,
              d.value->'studyKit' AS "studyKit", d.value ? 'studyKit' AS "hasStudyKit", s.last_id IS NOT NULL AS settled, s.last_error->>'status' AS status,
              d.manifest, p.phase, p.revision, p.message AS draft, p.manifest AS "draftManifest"
       FROM facts f
       JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev
       LEFT JOIN slot_state s ON s.learner_id=f.learner_id AND s.slot_type=$3 AND s.slot_key=f.id
       LEFT JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id
       LEFT JOIN studio_turn_stream p ON p.learner_id=f.learner_id AND p.turn_id=f.id
       WHERE f.learner_id=$1 AND f.type='activity.studyTurn' AND r.data->>'sessionId'=$2
       ORDER BY f.created_tick DESC LIMIT 1`,
      [tx.learner, sessionId, slotType],
    );
    if (!row) throw new RequestError(404, '这次学习会话不存在。');
    const submission = await createCommandReadContext(tx, purpose).fact(factId(row.turnId), { mode: 'following' })
      .then(input => studyTurn(input.value))
      .catch((error: unknown) => {
        if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) {
          throw new RequestError(409, '本次教学引用的依据已经变更。请重新开始一轮。');
        }
        throw error;
      });
    const status = row.status ?? (row.settled || row.message !== null ? 'ready' : 'pending');
    const manifest = status === 'pending' ? row.draftManifest : row.manifest;
    const origin = submission.parentId
      ? studyTurn((await createCommandReadContext(tx,purpose).fact(submission.sessionId,{mode:'following'})).value)
      : submission;
    const invalid = !await attachmentCurrent(tx, origin) || !await grantCurrent(submission) ||
      (manifest && (await revalidateManifest(tx, parseManifest(manifest))).kind !== 'valid');
    if (invalid && status === 'pending') {
      throw new RequestError(409, '本次教学引用的依据已经变更。请重新开始一轮。');
    }
    if (status === 'ready' && (invalid || row.message === null)) {
      row.message = unavailableReplyMessage;
      row.hasStudyKit = false;
    }
    const session: StreamSession = {
      id: sessionId, caseId: submission.caseId, currentTurnId: row.turnId, status,
      ...(status !== 'ready' && submission.answer ? { pendingAnswer: submission.answer } : {}),
    };
    return {session,row,artifacts:status === 'pending' ? await turnArtifacts(tx,sessionId,row.turnId) : []};
  });
}

export async function serveSessionEvents(
  db: Db, sessionId: string, watchMounts: boolean, res: ServerResponse, projectRecall: RecallHttp['project'],
) {
  const subscribers = subscriptions.get(db);
  if (res.destroyed) return;
  if (!subscribers) {
    // Keep EventSource's retry semantics during a LISTEN reconnect.
    res.writeHead(200, eventHeaders).end('retry: 1500\n\n');
    return;
  }
  let closed = false;
  let writing = false;
  let dirty = false;
  let notifiedSinceHeartbeat = false;
  let lastEventId: string | undefined;
  const subscriber: Subscriber = {
    sessionId,
    refresh() {
      notifiedSinceHeartbeat = true;
      scheduleRead();
    },
    disconnect() {
      cleanup();
      res.destroy();
    },
  };
  function scheduleRead() {
    dirty = true;
    if (!writing) void deliver();
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    subscribers!.delete(subscriber);
  }

  async function writeFrame(frame: string) {
    if (res.write(frame)) return;
    await new Promise<void>(resolve => {
      const ready = () => {
        res.off('drain', ready);
        res.off('close', ready);
        resolve();
      };
      res.once('drain', ready);
      res.once('close', ready);
    });
  }

  async function deliver() {
    writing = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        if (watchMounts) {
          const authorizedMountIds = await sessionMountPermissions(db, sessionId);
          if (closed || dirty) continue;
          const key = JSON.stringify(authorizedMountIds);
          if (key !== lastEventId) {
            lastEventId = key;
            await writeFrame(event('mount-permissions', undefined, { sessionId, authorizedMountIds }));
          }
          continue;
        }
        const { session, row, artifacts } = await readSessionEvent(db, sessionId);
        if (closed) return;
        if (dirty) continue;
        const { currentTurnId, status } = session;
        if (status !== 'pending') {
          const recall = status === 'ready' && row.derivationId && row.hasStudyKit
            ? await projectRecall(sessionId, currentTurnId, row.derivationId, row.studyKit) : undefined;
          if (closed) return;
          if (dirty) continue;
          const message = status === 'ready' ? recall?.lesson ?? row.message : undefined;
          res.end(event('complete', currentTurnId + ':' + status, {
            session, ...(message ? { message } : {}), ...(recall ? { recall } : {}),
          }));
          return;
        }
        const eventId = [currentTurnId,row.revision ?? 0,...artifacts.map(a => a.mountId+'-'+a.viewSeq)].join(':');
        if (eventId === lastEventId) continue;
        lastEventId = eventId;
        // Each event carries cumulative state, including on Last-Event-ID reattachment.
        const data = {
          session,
          phase: row.phase ?? 'queued',
          authorizedMountIds: artifacts.map(artifact => artifact.mountId),
          ...(row.draft ? { message: row.draft } : {}),
        };
        await writeFrame(event('progress', eventId, data) +
          artifacts.map(artifact => event('artifact-snapshot', eventId, artifact)).join(''));
      }
    } catch (error) {
      if (closed) return;
      if ((error instanceof RequestError || error instanceof RecallRequestError) && [403, 404, 409].includes(error.status)) {
        res.end(watchMounts
          ? event('mount-permissions', undefined, { sessionId, authorizedMountIds: [] })
          : event('session-error', undefined, { status: error.status }));
      } else {
        // Dropping the stream makes EventSource reconnect and reload a fresh snapshot.
        subscriber.disconnect();
      }
    } finally {
      writing = false;
    }
  }

  res.writeHead(200, eventHeaders);
  res.flushHeaders();
  res.write('retry: 1500\n\n');
  res.once('close', cleanup);
  const heartbeat = setInterval(() => {
    if (!res.writableNeedDrain) res.write(': keep-alive\n\n');
    // An older worker can commit a result without sending NOTIFY.
    if (!writing && (watchMounts || !notifiedSinceHeartbeat)) scheduleRead();
    notifiedSinceHeartbeat = false;
  }, 15_000);
  heartbeat.unref();
  // Register before the initial DB read so a commit cannot fall between the read and LISTEN.
  subscribers.add(subscriber);
  scheduleRead();
}

const eventHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  'X-Accel-Buffering': 'no',
};
function event(name: string, id: string | undefined, payload: object) {
  return (id ? 'id: ' + id + '\n' : '') + 'event: ' + name + '\ndata: ' + JSON.stringify(payload) + '\n\n';
}
