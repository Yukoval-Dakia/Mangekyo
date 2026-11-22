import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { stableId, studioLearner } from '../identity.ts';
import { listenForSessionEvents, prepareSessionEvents, publishSessionDelta, serveSessionEvents } from '../stream.ts';

it.skipIf(!testDatabaseUrl)('publishes transient PostgreSQL deltas to authorized SSE streams', {timeout: 30_000}, () =>
  withLearnerDatabase(studioLearner, async db => {
    await prepareSessionEvents(db);
    const session = stableId('stream-session'), turn = stableId('stream-turn'), frames: string[] = [];
    await db.tx({learner: studioLearner}, tx => tx.withLearnerWrite(async tick => {
      await tx.insert('facts', {learner_id: studioLearner, id: turn, type: 'activity.studyTurn', current_rev: 1,
        access_epoch: 0, purpose: ['teaching'], sticky: false, created_tick: tick, changed_tick: tick});
      await tx.insert('fact_revs', {learner_id: studioLearner, fact_id: turn, rev: 1,
        data: JSON.stringify({sessionId: session, caseId: 'companion', parentId: null, answer: '问题', model: 'm-test', baseUrl: 'http://127.0.0.1/v1'}),
        purpose: ['teaching'], sticky: false, kind: 'value', author: 'learner', command_id: stableId('cmd'), tick});
    }));
    const response = Object.assign(new EventEmitter(), {
      destroyed: false, writableNeedDrain: false, writeHead() {}, flushHeaders() {},
      write(frame: string) { frames.push(frame); return true; }, destroy() { this.destroyed = true; },
    }) as unknown as ServerResponse;
    const counts = async () => Object.values((await db.query<{facts: number; fact_revs: number; derivations: number; effects: number}>(`SELECT
      (SELECT count(*) FROM facts), (SELECT count(*) FROM fact_revs), (SELECT count(*) FROM derivations),
      (SELECT count(*) FROM effects)`)).rows[0]!);
    const stop = await listenForSessionEvents(db, () => new pg.Client({connectionString: testDatabaseUrl}));
    try {
      await serveSessionEvents(db, session, false, response, async () => { throw new Error('unused'); });
      await vi.waitFor(() => expect(frames.at(-1)).toContain('event: progress'), {timeout: 5000});
      const before = await counts();
      expect(await publishSessionDelta(db, session, turn, 1, '你好')).toBe(2);
      expect(await publishSessionDelta(db, session, turn, 2, '世界')).toBe(3);
      await vi.waitFor(() => expect(frames.filter(frame => frame.includes('event: delta'))).toHaveLength(2));
      expect(frames.filter(frame => frame.includes('event: delta')).map(frame => JSON.parse(frame.split('\ndata: ')[1]!)))
        .toEqual([{turnId: turn, seq: 1, delta: '你好'}, {turnId: turn, seq: 2, delta: '世界'}]);
      expect(await counts()).toEqual(before);
      expect(await publishSessionDelta(db, session, turn, 3, 'x'.repeat(6000))).toBe(9);
      await vi.waitFor(() => expect(frames.filter(frame => frame.includes('event: delta'))).toHaveLength(8));
    } finally {
      await stop();
    }
  }));
