import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createCommandHandler } from './commands/handle.ts';
import { createCommandReadContext } from './commands/reads.ts';
import { commandId, factId, learnerId, type Revision } from './declarations/ids.ts';
import type { Json } from './declarations/types.ts';
import type { Db } from './db/types.ts';
import { createPgliteDb } from './db/pglite.ts';
import { applyKernelSchema } from './schema.ts';
import { loadModuleDirectory } from './loader.ts';
import { fileURLToPath } from 'node:url';

const learner = learnerId('01KFS4AAA00000000000000000');
const prefId = factId('01KFS4AAA00000000000000001');
const prefId2 = factId('01KFS4AAA00000000000000002');
const hooks = { onFactsChanged: async () => {} };
const moduleDir = fileURLToPath(new URL('../../modules/learner', import.meta.url));

async function openDb(): Promise<Db> {
  const db = createPgliteDb(new PGlite());
  await applyKernelSchema(db);
  await db.query('INSERT INTO learners(id) VALUES($1)', [learner]);
  return db;
}

function request(id: string, type: string, input: Json, actor: 'learner' | 'companion' = 'learner') {
  return { learner, id: commandId(id), type, input, actor, purpose: 'storage' } as const;
}

describe('learner preference commands', () => {
  it('declares, revises and retracts stable preference facts', { timeout: 20_000 }, async () => {
    const db = await openDb();
    const module = await loadModuleDirectory(moduleDir);
    const handle = createCommandHandler(db, { modules: [module], hooks });
    const first = { text: '先给提示再让我自己做', tags: ['hint-first'], scope: { subject: '化学', activity: '滴定' } };
    const declareReq = request('01KFS4AAA00000000000000010', 'learner.declarePreference', { id: prefId, data: first });

    const declared = await handle(declareReq);
    expect(declared.wrote).toEqual([{ learner, id: prefId, rev: 1 }]);
    expect(await handle(declareReq)).toEqual(declared);

    const fact = await db.snapshot({ learner }, (tx) =>
      createCommandReadContext(tx, 'storage').fact(prefId, { mode: 'following' }));
    expect(fact.type).toBe('learner.preference');
    expect(fact.value).toEqual(first);
    expect(fact.purpose).toEqual(['storage']);

    const revised = await handle(request('01KFS4AAA00000000000000011', 'learner.revisePreference', {
      id: prefId, expectedRev: 1 as Revision,
      data: { text: '先让我尝试再给提示', tags: ['try-first'], scope: { context: '晚自习' } },
    }));
    expect(revised.wrote).toEqual([{ learner, id: prefId, rev: 2 }]);
    await expect(handle(request('01KFS4AAA00000000000000012', 'learner.revisePreference', {
      id: prefId, expectedRev: 1 as Revision, data: { text: '过期版本', tags: [] },
    }))).rejects.toThrow(/revision conflict/);

    const second = await handle(request('01KFS4AAA00000000000000013', 'learner.declarePreference', {
      id: prefId2, data: { text: '喜欢口头讲解', tags: [] },
    }));
    expect(second.wrote).toEqual([{ learner, id: prefId2, rev: 1 }]);
    const retracted = await handle(request('01KFS4AAA00000000000000014', 'learner.retractPreference', {
      id: prefId2, expectedRev: 1 as Revision,
    }));
    expect(retracted.wrote).toEqual([{ learner, id: prefId2, rev: 2 }]);
    await expect(db.snapshot({ learner }, (tx) =>
      createCommandReadContext(tx, 'storage').fact(prefId2, { mode: 'following' }))).rejects.toThrow();
    await db.close();
  });

  it('keeps companion writes as proposals without fact writes', { timeout: 20_000 }, async () => {
    const db = await openDb();
    const module = await loadModuleDirectory(moduleDir);
    const handle = createCommandHandler(db, { modules: [module], hooks });
    const receipt = await handle({ ...request('01KFS4AAA00000000000000020', 'learner.declarePreference',
      { id: prefId, data: { text: '同伴想替我声明', tags: [] } }), actor: 'companion' });
    expect(receipt.state).toBe('proposed');
    expect((await db.query('SELECT * FROM proposals')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM facts')).rows).toHaveLength(0);
    await db.close();
  });
});
