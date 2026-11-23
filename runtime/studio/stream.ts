import { teachingTurnAllowed } from './reading.ts';
import type { ServerResponse } from 'node:http';
import type { Manifest } from '../../kernel/src/derivations/manifest.ts';
import { notionReadScope, teachingResultAuthority, type NotionReadScope } from './notion.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import type { Client } from 'pg';
import { listenForNotifications } from '../../kernel/src/db/notifications.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, DbQuery, ReadTransaction } from '../../kernel/src/db/types.ts';
import { workerStorage } from '../../kernel/src/schema.ts';
import { readReadyWork, type WorkRef } from '../../kernel/src/work/index.ts';
import type { TeachingProgress } from '../../executors/teaching/index.ts';
import { slotType, studioLearner } from './identity.ts';
import { requireSessionTurn, RequestError, sessionMountPermissions } from './sessions.ts';
import { workspaceGrantChecker } from './harness.ts';
import type { RecallHttp } from './recall-http.ts';
import { RecallRequestError } from './recall.ts';

import { turnArtifacts } from './presentation-store.ts';
import {
  buildCompleteEventData,
  buildProgressEventData,
  buildProgressEventId,
  buildStreamSession,
  chunkSessionDelta,
  isSessionDelta,
  mountPermissionData,
  resolveStreamTurnState,
  sseEvent,
  sseHeaders,
  type StreamSession,
  buildSessionEventView,
} from '../../modules/companion/facts/session-stream-slice.ts';

type Phase = TeachingProgress['phase'];

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

export async function notifySession(tx: DbQuery, sessionId: string) {
  await tx.query(
    `SELECT pg_notify('studio_teaching_' || lower(store_id), $1) FROM kernel_runtime_identity WHERE singleton`,
    [sessionId],
  );
}

type SessionDelta = { session: string; turnId: string; seq: number; delta: string };

export async function publishSessionDelta(db: Db, session: string, turnId: string, seq: number, delta: string): Promise<number> {
  if (!delta || !Number.isSafeInteger(seq) || seq < 0) return seq;
  const chunks = chunkSessionDelta(delta);
  for (const part of chunks) await db.query(
    `SELECT pg_notify('studio_teaching_' || lower(store_id), $1) FROM kernel_runtime_identity WHERE singleton`,
    [JSON.stringify({session, turnId, seq: seq++, delta: part})],
  );
  return seq;
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
    if (written.rowCount) await notifySession(tx, sessionId);
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
  if (row?.sessionId) await notifySession(tx, row.sessionId);
}

type Subscriber = { sessionId: string; refresh: () => void; delta(chunk: SessionDelta): void; disconnect: () => void };
const subscriptions = new WeakMap<Db, Set<Subscriber>>();

export async function listenForSessionEvents(db: Db, createListener: () => Client): Promise<() => void> {
  const channel = 'studio_teaching_' + (await workerStorage(db)).toLowerCase();
  const subscribers = new Set<Subscriber>();
  return listenForNotifications(createListener, channel, {
    connected() { subscriptions.set(db,subscribers); },
    disconnected() {
      subscriptions.delete(db);
      for (const subscriber of subscribers) subscriber.disconnect();
    },
    message(payload) {
      let value: unknown;
      try { value = JSON.parse(payload ?? ''); } catch {}
      const chunk = isSessionDelta(value) ? value : undefined;
      if (chunk)
        for (const subscriber of subscribers) if (subscriber.sessionId === chunk.session) subscriber.delta(chunk);
      else for (const subscriber of subscribers) if (subscriber.sessionId === payload) subscriber.refresh();
    },
  });
}

async function readSessionEvent(notion: NotionReadScope, sessionId: string) {
  return notion.read(async (tx, check) => {
    const grantCurrent = workspaceGrantChecker(tx);
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
    const submission = studyTurn((await requireSessionTurn(tx, row.turnId)).value);
    const status = resolveStreamTurnState(row.status, row.settled, row.message);
    const manifest = status === 'pending' ? row.draftManifest : row.manifest;
    const allowed = await teachingTurnAllowed(tx, submission, grantCurrent);
    if (!allowed && status === 'pending')
      throw new RequestError(409, '本次教学引用的依据已经变更。请重新开始一轮。');
    const authority = !allowed ? 'withdrawn' : manifest
      ? (await teachingResultAuthority(tx, row.turnId, submission, manifest, grantCurrent, check, undefined, status === 'ready' ? 'history' : 'publish')).state : 'authorized';
    const mounts = status === 'pending'
      ? await turnArtifacts(tx,sessionId,row.turnId,check) : {snapshots: [], unconfirmed: []};
    return buildSessionEventView({ sessionId, row, submission, authority, allowed, mounts, status });
  });
}

export async function serveSessionEvents(
  db: Db, sessionId: string, watchMounts: boolean, res: ServerResponse, projectRecall: RecallHttp['project'],
  knownMounts: ReadonlySet<string> = new Set(),
) {
  const subscribers = subscriptions.get(db);
  if (res.destroyed) return;
  if (!subscribers) {
    // Keep EventSource's retry semantics during a LISTEN reconnect.
    res.writeHead(200, sseHeaders).end('retry: 1500\n\n');
    return;
  }
  let closed = false;
  let writing = false;
  let dirty = false;
  let notifiedSinceHeartbeat = false;
  let lastEventId: string | undefined;
  const seen = new Set(knownMounts);
  let authorized = false;
  const subscriber: Subscriber = {
    sessionId,
    refresh() {
      notifiedSinceHeartbeat = true;
      scheduleRead();
    },
    delta(chunk) {
      if (authorized && !closed) void writeFrame(sseEvent('delta', undefined,
        {turnId: chunk.turnId, seq: chunk.seq, delta: chunk.delta})).catch(() => {});
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
          const {authorizedMountIds, unconfirmed} = await sessionMountPermissions(db, sessionId);
          authorized = true;
          if (closed || dirty) continue;
          const permission = {sessionId, authorizedMountIds, ...mountPermissionData(unconfirmed, seen)};
          const key = JSON.stringify(permission);
          if (key !== lastEventId) {
            lastEventId = key;
            authorizedMountIds.forEach(id => seen.add(id));
            await writeFrame(sseEvent('mount-permissions', undefined, permission));
          }
          continue;
        }
        const notion = notionReadScope(db, studioLearner);
        const { session, row, mounts: {snapshots: artifacts, unconfirmed} } = await readSessionEvent(notion, sessionId);
        authorized = true;
        if (closed) return;
        if (dirty) continue;
        const { currentTurnId, status } = session;
        if (status !== 'pending') {
          const recall = status === 'ready' && row.derivationId && row.hasStudyKit
            ? await projectRecall(sessionId, currentTurnId, row.derivationId, row.studyKit, notion) : undefined;
          if (closed) return;
          if (dirty) continue;
          const message = status === 'ready' ? recall?.lesson ?? row.message : undefined;
          res.end(sseEvent('complete', currentTurnId + ':' + status, buildCompleteEventData(session, message, recall)));
          return;
        }
        const partial = mountPermissionData(unconfirmed, seen);
        const eventId = buildProgressEventId({ currentTurnId, revision: row.revision ?? null, hasDraft: Boolean(row.draft), artifacts, partial });
        if (eventId === lastEventId) continue;
        lastEventId = eventId;
        // Each event carries cumulative state, including on Last-Event-ID reattachment.
        const data = buildProgressEventData({ session, phase: row.phase, artifacts, partial, draft: row.draft });
        data.authorizedMountIds.forEach(id => seen.add(id));
        await writeFrame(sseEvent('progress', eventId, data) +
          artifacts.map(artifact => sseEvent('artifact-snapshot', eventId, artifact)).join(''));
      }
    } catch (error) {
      if (closed) return;
      if ((error instanceof RequestError || error instanceof RecallRequestError) && [403, 404, 409].includes(error.status)) {
        res.end(watchMounts
          ? sseEvent('mount-permissions', undefined, { sessionId, authorizedMountIds: [] })
          : sseEvent('session-error', undefined, { status: error.status }));
      } else {
        // Dropping the stream makes EventSource reconnect and reload a fresh snapshot.
        subscriber.disconnect();
      }
    } finally {
      writing = false;
    }
  }

  res.writeHead(200, sseHeaders);
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
