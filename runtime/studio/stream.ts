import { teachingTurnAllowed } from './reading.ts';
import type { ServerResponse } from 'node:http';
import { notionReadScope, type NotionReadScope } from './notion.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import type { Client } from 'pg';
import { listenForNotifications } from '../../kernel/src/db/notifications.ts';
import { workerStorage } from '../../kernel/src/schema.ts';
import { readReadyWork, type WorkRef } from '../../kernel/src/work/index.ts';
import type { TeachingActivity, TeachingProgress } from '../../executors/teaching/index.ts';
import {listCurrentSlotFacts, type Db, type Manifest, type ReadTransaction} from '../../kernel/src/index.ts';
import type { DbQuery } from '../../kernel/src/db/types.ts';
import { slotType, studioHost, studioLearner } from './identity.ts';
import {
  requireSessionTurn, RequestError, resolveTurnAuthority, sessionMountPermissions,
  unconfirmedReplyMessage, unavailableReplyMessage,
} from './sessions.ts';
import { workspaceGrantChecker } from './harness.ts';
import type { RecallHttp } from './recall-http.ts';
import { RecallRequestError } from './recall.ts';
import {mountPermissionFields, turnArtifacts} from './presentation-store.ts';
type Phase = TeachingProgress['phase'];
type StreamSession = { id: string; caseId: string; currentTurnId: string; status: 'pending' | 'ready' | 'failed' | 'unknown'; pendingAnswer?: string; };
const notifySql =
  `SELECT pg_notify('studio_teaching_' || lower(store_id), $1) FROM kernel_runtime_identity WHERE singleton`;
export async function prepareSessionEvents(db: Db): Promise<void> {
  await db.schemaTransaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(7264041, hashtext(current_schema()::text))');
    // A live draft is disposable. The completed derivation is stored by finishWork.
    await tx.query(`CREATE UNLOGGED TABLE IF NOT EXISTS studio_turn_stream (
      learner_id text NOT NULL, turn_id text NOT NULL,
      phase text NOT NULL CHECK (phase IN ('thinking', 'reading', 'checking', 'replying')),
      message text NOT NULL CHECK (length(message) <= 12000), manifest jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
      PRIMARY KEY (learner_id, turn_id), FOREIGN KEY (learner_id, turn_id) REFERENCES facts(learner_id, id) ON DELETE CASCADE)`);
  });
}
export const notifySession = (tx: DbQuery, sessionId: string) => tx.query(notifySql, [sessionId]);
type SessionDelta = { session: string; turnId: string; seq: number; delta: string };
type SessionActivity = { session: string; turnId: string; activity: TeachingActivity };
function utf8Chunks(text: string): string[] {
  const chunks: string[] = []; let chunk = '';
  for (const ch of text) chunk && new TextEncoder().encode(chunk + ch).length > 1000 ? (chunks.push(chunk), chunk = ch) : (chunk += ch);
  return chunk ? [...chunks, chunk] : chunks;
}
export async function publishSessionDelta(db: Db, session: string, turnId: string, seq: number, delta: string): Promise<number> {
  if (!delta || !Number.isSafeInteger(seq) || seq < 0) return seq;
  for (const part of utf8Chunks(delta)) await db.query(notifySql, [JSON.stringify({ session, turnId, seq: seq++, delta: part })]);
  return seq;
}
export async function publishSessionActivity(db: Db, session: string, turnId: string, activity: TeachingActivity): Promise<void> {
  const items = activity.kind === 'thinking' ? utf8Chunks(activity.delta).map(delta => ({ kind: 'thinking' as const, delta })) : [activity];
  for (const item of items) await db.query(notifySql, [JSON.stringify({ session, turnId, activity: item })]);
}
export async function publishTurnProgress(
  db: Db, ref: WorkRef, turnId: string, sessionId: string, progress: TeachingProgress,
  validate: (tx: ReadTransaction) => Promise<Manifest>,
): Promise<void> {
  await studioHost(db).lockedTx(async tx => {
    if ((await readReadyWork(tx, ref))?.slotKey !== turnId) return;
    const manifest = await validate(tx);
    const written = await tx.query(
      `INSERT INTO studio_turn_stream (learner_id, turn_id, phase, message, manifest) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (learner_id, turn_id) DO UPDATE SET
         phase=EXCLUDED.phase, message=EXCLUDED.message, manifest=EXCLUDED.manifest, revision=studio_turn_stream.revision+1
       WHERE (studio_turn_stream.phase, studio_turn_stream.message) IS DISTINCT FROM (EXCLUDED.phase, EXCLUDED.message)`,
      [tx.learner, turnId, progress.phase, progress.phase === 'replying' ? progress.message : '', JSON.stringify(manifest)]);
    if (written.rowCount) await notifySession(tx, sessionId);
  });
}
export async function completeTurnStream(tx: ReadTransaction, turnId: string) {
  await tx.query('DELETE FROM studio_turn_stream WHERE learner_id=$1 AND turn_id=$2', [tx.learner, turnId]);
  const { rows: [row] } = await tx.query<{ sessionId: string }>(
    `SELECT r.data->>'sessionId' AS "sessionId" FROM facts f
     JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev
     WHERE f.learner_id=$1 AND f.id=$2 AND f.type='activity.studyTurn'`, [tx.learner, turnId]);
  // Delivered only after the acceptance (or failure) transaction commits.
  if (row?.sessionId) await notifySession(tx, row.sessionId);
}
type Subscriber = { sessionId: string; refresh: () => void; delta(chunk: SessionDelta): void; activity(item: SessionActivity): void; disconnect: () => void };
const subscriptions = new WeakMap<Db, Set<Subscriber>>();
export async function listenForSessionEvents(db: Db, createListener: () => Client): Promise<() => void> {
  const channel = 'studio_teaching_' + (await workerStorage(db)).toLowerCase(), subscribers = new Set<Subscriber>();
  return listenForNotifications(createListener, channel, {
    connected() { subscriptions.set(db, subscribers); },
    disconnected() { subscriptions.delete(db); subscribers.forEach(s => s.disconnect()); },
    message(payload) {
      let value: unknown;
      try { value = JSON.parse(payload ?? ''); } catch {}
      const chunk = value as (SessionDelta & Partial<SessionActivity>) | undefined;
      const notify = (session: string, fn: (s: Subscriber) => void) => subscribers.forEach(s => { if (s.sessionId === session) fn(s); });
      if (chunk && typeof chunk.session === 'string' && typeof chunk.turnId === 'string' &&
          typeof chunk.seq === 'number' && typeof chunk.delta === 'string') notify(chunk.session, s => s.delta(chunk));
      else if (chunk && typeof chunk.session === 'string' && typeof chunk.turnId === 'string' && chunk.activity)
        notify(chunk.session, s => s.activity(chunk as SessionActivity));
      else if (payload) notify(payload, s => s.refresh());
    },
  });
}
async function readSessionEvent(notion: NotionReadScope, sessionId: string) {
  return notion.read(async (tx, check) => {
    const grantCurrent = workspaceGrantChecker(tx);
    const [row] = await listCurrentSlotFacts(tx, {
      factType: 'activity.studyTurn', slotType, keyField: 'sessionId', keyValue: sessionId, newestFirst: true, limit: 1,
    });
    if (!row) throw new RequestError(404, '这次学习会话不存在。');
    const { rows: [stream] } = await tx.query<{
      phase: Phase | null; revision: number | null; draft: string | null; draftManifest: unknown;
    }>(`SELECT phase, revision, message AS draft, manifest AS "draftManifest"
        FROM studio_turn_stream WHERE learner_id=$1 AND turn_id=$2`, [tx.learner, row.id]);
    const submission = studyTurn((await requireSessionTurn(tx, row.id)).value);
    const value = row.value as { message?: unknown; studyKit?: unknown } | null;
    let message = typeof value?.message === 'string' ? value.message : null;
    let hasStudyKit = Boolean(value && Object.hasOwn(value, 'studyKit'));
    const status = (row.error as { status?: 'failed' | 'unknown' } | null)?.status ?? (row.settled || message !== null ? 'ready' : 'pending');
    const allowed = await teachingTurnAllowed(tx, submission, grantCurrent);
    if (!allowed && status === 'pending') throw new RequestError(409, '本次教学引用的依据已经变更。请重新开始一轮。');
    const authority = await resolveTurnAuthority(tx, row.id, submission, status === 'pending' ? stream?.draftManifest : row.manifest,
      allowed, grantCurrent, check, status === 'ready' ? 'history' : 'publish');
    if (status === 'ready' && (authority !== 'authorized' || message === null)) {
      message = authority === 'unconfirmed' ? unconfirmedReplyMessage : unavailableReplyMessage;
      hasStudyKit = false;
    }
    const session: StreamSession = {
      id: sessionId, caseId: submission.caseId, currentTurnId: row.id, status,
      ...(status !== 'ready' && !submission.classroom && submission.answer ? { pendingAnswer: submission.answer } : {}),
    };
    const mounts = status === 'pending' ? await turnArtifacts(tx, sessionId, row.id, check) : { snapshots: [], unconfirmed: [] };
    return {
      session, mounts,
      row: { ...row, message, hasStudyKit, studyKit: value?.studyKit, phase: stream?.phase ?? null,
        revision: stream?.revision ?? null, draft: authority === 'authorized' ? (stream?.draft ?? null) : null },
    };
  });
}
export async function serveSessionEvents(
  db: Db, sessionId: string, watchMounts: boolean, res: ServerResponse, projectRecall: RecallHttp['project'],
  knownMounts: ReadonlySet<string> = new Set(),
) {
  const subscribers = subscriptions.get(db);
  if (res.destroyed) return;
  if (!subscribers) return void res.writeHead(200, eventHeaders).end('retry: 1500\n\n');
  let closed = false, writing = false, dirty = false, notifiedSinceHeartbeat = false, authorized = false, lastEventId: string | undefined;
  const seen = new Set(knownMounts);
  const cleanup = () => { if (!closed) { closed = true; clearInterval(heartbeat); subscribers.delete(subscriber); } };
  const subscriber: Subscriber = {
    sessionId,
    refresh() { notifiedSinceHeartbeat = true; scheduleRead(); },
    delta: chunk => {
      if (authorized && !closed)
        void writeFrame(event('delta', undefined, { turnId: chunk.turnId, seq: chunk.seq, delta: chunk.delta })).catch(() => {});
    },
    activity: item => {
      if (authorized && !closed)
        void writeFrame(event('activity', undefined, { turnId: item.turnId, ...item.activity })).catch(() => {});
    },
    disconnect() { cleanup(); res.destroy(); },
  };
  const scheduleRead = () => { dirty = true; if (!writing) void deliver(); };
  const writeFrame = (frame: string) => res.write(frame) ? Promise.resolve() : new Promise<void>(resolve => {
    const ready = () => { res.off('drain', ready); res.off('close', ready); resolve(); };
    res.once('drain', ready).once('close', ready);
  });
  async function deliver() {
    writing = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        if (watchMounts) {
          const { authorizedMountIds, unconfirmed } = await sessionMountPermissions(db, sessionId);
          authorized = true;
          if (closed || dirty) continue;
          const permission = { sessionId, authorizedMountIds, ...mountPermissionFields(unconfirmed, seen) };
          const key = JSON.stringify(permission);
          if (key !== lastEventId) {
            lastEventId = key;
            authorizedMountIds.forEach(id => seen.add(id));
            return writeFrame(event('mount-permissions', undefined, permission));
          }
          continue;
        }
        const notion = notionReadScope(db, studioLearner);
        const { session, row, mounts: { snapshots: artifacts, unconfirmed } } = await readSessionEvent(notion, sessionId);
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
          res.end(event('complete', `${currentTurnId}:${status}`, { session, ...(message && { message }), ...(recall && { recall }) }));
          return;
        }
        const partial = mountPermissionFields(unconfirmed, seen);
        const eventId = [currentTurnId, row.revision ?? 0, Number(Boolean(row.draft)), ...artifacts.map(a => `${a.mountId}-${a.viewSeq}`),
          ...(partial.mountPermissionsPartial ? ['partial', ...partial.unconfirmedMountIds] : [])].join(':');
        if (eventId === lastEventId) continue;
        lastEventId = eventId;
        // Each event carries cumulative state, including on Last-Event-ID reattachment.
        const authorizedMountIds = artifacts.map(artifact => artifact.mountId);
        authorizedMountIds.forEach(id => seen.add(id));
        const data = { session, phase: row.phase ?? 'queued', authorizedMountIds, ...partial, ...(row.draft && { message: row.draft }) };
        await writeFrame(event('progress', eventId, data) + artifacts.map(artifact => event('artifact-snapshot', eventId, artifact)).join(''));
      }
    } catch (error) {
      if (closed) return;
      if ((error instanceof RequestError || error instanceof RecallRequestError) && [403, 404, 409].includes(error.status)) {
        res.end(watchMounts ? event('mount-permissions', undefined, { sessionId, authorizedMountIds: [] })
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
const eventHeaders = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', };
function event(name: string, id: string | undefined, payload: object) {
  return (id ? 'id: ' + id + '\n' : '') + 'event: ' + name + '\ndata: ' + JSON.stringify(payload) + '\n\n';
}
