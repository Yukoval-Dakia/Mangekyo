import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgDb } from '../src/db/pg.ts';
import { createPgliteDb } from '../src/db/pglite.ts';
import type { Db } from '../src/db/types.ts';
import { commandId, factId, learnerId } from '../src/declarations/ids.ts';
import { applyKernelSchema } from '../src/schema.ts';
import { createCommandHandler } from '../src/commands/handle.ts';
import {createBusScope} from '../src/bus.ts';
import type {FactSnapshot} from '../src/declarations/types.ts';
import { createCommandReadContext } from '../src/commands/reads.ts';
import { canonicalJsonString } from '../src/commands/canonical.ts';
import { noteModule } from './commands/fixture.ts';

export function invariants(postgres = false) {
  const connectionString = process.env.MANGEKYO_TEST_DATABASE_URL;
  const suite = postgres && !connectionString ? describe.skip : describe;
  suite(postgres ? 'PostgreSQL invariants' : 'PGlite invariants', () => {
    let db: Db;
    let admin: Db | undefined;
    const schema = `invariants_${process.pid}`;
    const learner = learnerId('01KFS4AAA00000000000000000');
    const id = factId('01KFS4AAA00000000000000001');
    const request = { learner, id: commandId('01KFS4AAA00000000000000002'), type: 'note.record', input: { id, text: 'original' }, actor: 'learner' as const, purpose: 'storage' };
    const hooks = { onFactsChanged: async () => {} };
    const handle = () => createCommandHandler(db, { modules: [noteModule()], hooks });
    beforeEach(async () => {
      if (postgres) {
        admin = createPgDb(new pg.Pool({ connectionString }));
        await admin.query(`CREATE SCHEMA ${schema}`);
        db = createPgDb(new pg.Pool({ connectionString, max: 8 }), { schema });
      } else db = createPgliteDb(new PGlite());
      await applyKernelSchema(db);
      await db.query('INSERT INTO learners(id) VALUES($1)', [learner]);
    });
    afterEach(async () => {
      await db.close();
      if (admin) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.close();
      }
    });
    it('replays one identity and rejects changed content without extra revisions', async () => {
      const receipts = postgres
        ? await Promise.all(Array.from({ length: 8 }, () => handle()(request)))
        : [await handle()(request), await handle()(request)];
      for (const receipt of receipts) expect(receipt).toEqual(receipts[0]);
      await expect(handle()({ ...request, input: { id, text: 'different' } })).rejects.toThrow();
      expect((await db.query('SELECT purpose FROM fact_revs')).rows).toEqual([{ purpose: ['storage'] }]);
      expect((await db.query<{clock:string}>('SELECT clock::text FROM learners')).rows[0]?.clock).toBe('1');
      expect(await createCommandHandler(db, { modules: [], hooks })(request)).toEqual(receipts[0]);
      await handle()({ ...request, id: commandId('01KFS4AAA00000000000000003'), input: { id: factId('01KFS4AAA00000000000000004'), text: 'original' } });
      expect((await db.query('SELECT * FROM facts')).rows).toHaveLength(2);
    });
    it('projects authorized results and reopens every witness with the bound command identity', async () => {
      await handle()(request);
      const second = factId('01KFS4AAA00000000000000004');
      await handle()({...request, id:commandId(second), input:{id:second, text:'private value'}});
      const actor = {actor:'companion', purpose:'storage', maySend:() => true, defaultPreset:'type',
        presets:new Map([['type', (fact: FactSnapshot) => fact.type]])} as const;
      const bus = createBusScope({db,learner}, actor, handle());
      const initial = await bus.query({types:['note.entry']});
      expect(initial.items).toEqual(['note.entry','note.entry']);
      expect(JSON.stringify(initial)).not.toContain('private value');
      const [first, next] = initial.witnesses;
      if (!first || !next) throw new Error('Missing witnesses');
      const pinned = {...first, mode:'pinned'} as const;
      await handle()({...request, id:commandId('01KFS4AAA00000000000000005'), type:'note.correct', input:{id, text:'v2', rev:1}});
      await expect(bus.resolve([next, first], 'type')).rejects.toMatchObject({reason:'changed'});
      expect((await bus.resolve([next, pinned], 'type')).witnesses).toEqual([next,pinned]);
      await expect(bus.resolve([next, {...pinned, type:'other.type'}], 'type')).rejects.toMatchObject({reason:'changed'});
      await db.snapshot({learner}, async tx => {
        const filtered = createBusScope(tx, {...actor, maySend:fact => fact.ref.id === second});
        expect((await filtered.query({types:['note.entry'], limit:1})).witnesses).toEqual([next]);
        await expect(filtered.resolve([next, pinned], 'type')).rejects.toMatchObject({reason:'recipient'});
        await expect(filtered.resolve(Array(9).fill(next), 'type')).rejects.toThrow('eight');
        await expect(filtered.resolve([next], 'unknown')).rejects.toThrow('preset');
      });
      // A different recipient or purpose cannot borrow the prior read's authority.
      await db.snapshot({learner}, tx => expect(createBusScope(tx, {...actor,purpose:'teaching'})
        .resolve([next], 'type')).rejects.toMatchObject({reason:'purpose'}));
      await db.snapshot({learner:learnerId(second)}, tx => expect(createBusScope(tx, actor)
        .resolve([next], 'type')).rejects.toMatchObject({reason:'recipient'}));
      const spoofed = {...request, type:'note.correct', input:{id, rev:2, text:'edited'}, actor:'learner',
        learner:learnerId(second), purpose:'teaching', id:commandId('01KFS4AAA00000000000000006')};
      const receipt = await bus.mutate(spoofed);
      expect(receipt.state).toBe('proposed');
      expect((await db.query('SELECT learner_id,input FROM commands WHERE id=$1',[spoofed.id])).rows)
        .toEqual([{learner_id:learner,input:{actor:'companion',purpose:'storage',input:spoofed.input}}]);
      await db.query('UPDATE facts SET access_epoch=access_epoch+2 WHERE learner_id=$1 AND id=$2',[learner, id]);
      await expect(bus.resolve([next, pinned], 'type')).rejects.toMatchObject({reason:'changed'});
      await db.query('UPDATE facts SET retracted_rev=current_rev WHERE learner_id=$1 AND id=$2',[learner, second]);
      await expect(bus.resolve([next], 'type')).rejects.toMatchObject({reason:'retracted'});
    });
    it('preserves old content, sticky ownership and rejects competing corrections', async () => {
      await handle()(request);
      const correct = { ...request, type: 'note.correct', input: { id, text: 'mine', rev: 1 } };
      const changes = [3, 4].map(n => ({ ...correct, id: commandId(`01KFS4AAA0000000000000000${n}`) }));
      const results = await Promise.allSettled(changes.map(r => handle()(r)));
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
      if (postgres) expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect((await db.query('SELECT current_rev,sticky FROM facts')).rows[0]).toEqual({ current_rev: 2, sticky: true });
      const old = await db.tx({ learner }, tx => createCommandReadContext(tx, request.purpose).fact(id, { mode: 'pinned', rev: 1 as never }));
      expect(old.value).toEqual({ text: 'original' });
      await db.query("UPDATE facts SET purpose='{}' WHERE learner_id=$1", [learner]);
      await expect(db.tx({ learner }, tx => createCommandReadContext(tx, request.purpose).fact(id, { mode: 'pinned', rev: 1 as never }))).rejects.toThrow();
    });
    it('allows a companion to revise its own draft until the learner edits it', async () => {
      const agent = { ...request, actor: 'companion' as const };
      const revise = { ...agent, type: 'note.revise', id: commandId('01KFS4AAA00000000000000003'), input: { id, text: 'revision', rev: 1 } };
      await handle()(agent);
      expect((await handle()(revise)).wrote[0]?.rev).toBe(2);
      await handle()({ ...request, type: 'note.correct', id: commandId('01KFS4AAA00000000000000004'), input: { id, text: 'my edit', rev: 2 } });
      await expect(handle()({ ...revise, id: commandId('01KFS4AAA00000000000000005'), input: { ...revise.input, rev: 3 } })).rejects.toThrow('unedited companion');
      const own = factId('01KFS4AAA00000000000000006');
      await handle()({ ...request, id: commandId('01KFS4AAA00000000000000007'), input: { id: own, text: 'learner' } });
      await expect(handle()({ ...revise, id: commandId('01KFS4AAA00000000000000008'), input: { ...revise.input, id: own } })).rejects.toThrow('unedited companion');
    });
    it('rolls back the fact, registration, receipt and tick together', async () => {
      await db.query('CREATE TABLE handoff(tick bigint)');
      const fail = createCommandHandler(db, { modules: [noteModule()], hooks: { onFactsChanged: async (tx, tick) => {
        await tx.query('INSERT INTO handoff VALUES($1)', [tick]);
        throw new Error('handoff failure');
      } } });
      await expect(fail(request)).rejects.toThrow('handoff failure');
      for (const table of ['facts', 'fact_revs', 'commands', 'handoff']) expect((await db.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
      expect((await db.query<{clock:string}>('SELECT clock::text FROM learners')).rows[0]?.clock).toBe('0');
    });
    it('persists AI destructive proposals without writing content or bypassing replay', async () => {
      await handle()(request);
      const proposal = { ...request, id: commandId('01KFS4AAA00000000000000003'), type: 'note.correct', actor: 'companion' as const, input: { id, text: 'AI', rev: 1 } };
      const submit = () => handle()(proposal);
      const receipts = postgres ? await Promise.all(Array.from({ length: 8 }, submit)) : [await submit(), await submit()];
      expect(receipts.every(r => r.state === 'proposed')).toBe(true);
      expect((await db.query('SELECT * FROM proposals')).rows).toHaveLength(1);
      expect((await db.query('SELECT * FROM fact_revs')).rows).toHaveLength(1);
      await expect(handle()({ ...proposal, actor: 'learner' })).rejects.toThrow();
    });
    it('rejects lossy JSON identities and cross-learner inserts', async () => {
      for (const input of [NaN, { a: undefined }, new Date(), [, 1]]) expect(() => canonicalJsonString(input as never)).toThrow();
      expect(canonicalJsonString({ b: 2, a: 1 })).toBe(canonicalJsonString({ a: 1, b: 2 }));
      await expect(db.tx({ learner }, tx => tx.insert('facts', { learner_id: 'other' }))).rejects.toThrow('scope');
    });
  });
}
