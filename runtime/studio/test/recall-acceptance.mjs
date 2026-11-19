import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createPgDb } from '../../../kernel/src/db/pg.ts';
import { createPgliteDb } from '../../../kernel/src/db/pglite.ts';
import { loadModuleDirectory } from '../../../kernel/src/loader.ts';
import { applyKernelSchema } from '../../../kernel/src/schema.ts';
import { methodName, purpose, slotType, stableId, studioLearner } from '../identity.ts';
import { openRecall, recallItemId } from '../recall.ts';

const connectionString = process.env.MANGEKYO_RECALL_LOCAL_PG;
const schema = 'recall_' + randomBytes(6).toString('hex');
const admin = connectionString && createPgDb(new pg.Pool({ connectionString }));
const require = createRequire(new URL('../../../kernel/package.json', import.meta.url));
const db = connectionString
  ? createPgDb(new pg.Pool({ connectionString }), { schema })
  : createPgliteDb(new (require('@electric-sql/pglite').PGlite)());
const scope = { learner: studioLearner };
const turnId = stableId('recall fixture turn');
const version = stableId('recall fixture version');
const prompt = '三组各四枚，一共几枚？';
const mount = { turnId, derivationId: version, itemId: recallItemId(turnId, version, 0) };

try {
  if (admin) await admin.query('CREATE SCHEMA ' + schema);
  await applyKernelSchema(db);
  await db.query('INSERT INTO learners (id) VALUES ($1)', [studioLearner]);
  const activity = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/activity', import.meta.url)));
  const handle = createCommandHandler(db, { modules: [activity], hooks: { async onFactsChanged() {} } });
  await handle({ ...scope, id: turnId, actor: 'learner', type: 'activity.submitTurn', purpose, input: {
    id: turnId, data: { sessionId: turnId, parentId: null, caseId: 'companion', answer: '备课', model: 'fixture', baseUrl: 'fixture' },
  } });
  await db.tx(scope, tx => tx.withLearnerWrite(async tick => {
    const manifest = JSON.stringify({ version: 1, ...scope, purpose, gatherTick: tick, inputs: [
      { kind: 'fact', id: turnId, rev: 1, accessEpoch: '0', mode: 'following' },
    ] });
    const studyKit = { title: '回忆练习', lesson: '已完成讲义', questions: [
      { prompt, answer: '12' },
      { prompt: '含三个顶点的平面图形叫什么？', answer: '三角形' },
    ] };
    await tx.insert('derivations', {
      learner_id: tx.learner, id: version, slot_type: slotType, slot_key: turnId, deriver: methodName,
      scope_keys: '{}', value: JSON.stringify({ studyKit }), lifecycle: 'effective', freshness: 'current',
      gather_tick: tick, effective_tick: tick, manifest,
    });
    await tx.insert('slot_state', {
      learner_id: tx.learner, slot_type: slotType, slot_key: turnId, current_id: version,
      last_id: version, changed_tick: tick, scope_keys: '{}',
    });
  }));

  const trusted = new WeakMap();
  const recall = openRecall(db, activity, { verifyDisplay: async receipt => trusted.get(receipt) ?? null });
  await assert.rejects(recall.mount({ ...mount, turnId: stableId('other turn') }), { status: 404 });
  const first = await recall.mount(mount);
  assert.deepEqual(first, { ...mount, prompt, issuanceId: first.issuanceId, responseId: 'answer' });
  assert.deepEqual(await recall.get(mount), first);
  const submit = requestId => ({ mount, requestId, answer: '12' });
  const unknown = await recall.submit(submit('before_help'));
  const grant = await recall.requestReveal({ mount, requestId: 'reference_1' });
  const report = { mount, revealId: grant.revealId };
  await assert.rejects(recall.confirmDisplay(report), { status: 403 });
  assert.equal((await recall.submit(submit('after_delivery'))).exposure.kind, 'unknown');
  trusted.set(report, report);
  const { display } = await recall.confirmDisplay(report);
  const assisted = await recall.submit(submit('assisted_1'));
  assert.equal(unknown.result, 'correct');
  assert.equal(unknown.exposure.kind, 'unknown');
  assert.equal(assisted.result, 'correct');
  assert.deepEqual(assisted.exposure, { kind: 'exposed', evidenceRefs: [display] });
  assert.deepEqual(await recall.submit(submit('before_help')), unknown);
  assert.deepEqual(await recall.readState(mount), { answer: '12', receipt: assisted });
  console.log(connectionString ? 'PostgreSQL' : 'PGlite', 'unknown → exposed');
} finally {
  await db.close();
  if (admin) {
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin.close();
  }
}
