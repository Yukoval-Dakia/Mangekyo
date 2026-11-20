import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { fileURLToPath } from 'node:url';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { loadModuleDirectory } from '../../../kernel/src/loader.ts';
import { intakeWriteTargets } from '../intake.ts';
import { methodName, purpose, slotType, stableId, studioLearner } from '../identity.ts';
import { openRecall, recallItemId } from '../recall.ts';

const config = await mkdtemp(join(tmpdir(),'mangekyo-recall-settings-'));
const baseUrl = 'http://127.0.0.1:1/v1';
const model = 'auto/deepseek-v4.1-flash';
const accountRevision = randomUUID();
process.env.MANGEKYO_SETTINGS_FILE = join(config,'provider.json');
await writeFile(process.env.MANGEKYO_SETTINGS_FILE,JSON.stringify({version:2,activeProviderId:'default',providers:[
  {id:'default',baseUrl,model,protocol:'openai',apiKey:'',credentialRevision:accountRevision},
]}));
const connectionString = process.env.MANGEKYO_RECALL_LOCAL_PG;
const scope = { learner: studioLearner };
const turnId = stableId('recall fixture turn');
const version = stableId('recall fixture version');
const prompt = '三组各四枚，一共几枚？';
const mount = { turnId, derivationId: version, itemId: recallItemId(turnId, version, 0) };

async function exerciseRecall(db) {
  const activity = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/activity', import.meta.url)));
  const capture = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/capture', import.meta.url)));
  const content = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/content', import.meta.url)));
  const handle = createCommandHandler(db, {
    modules: [activity, capture, content],
    hooks: { async onFactsChanged() {} },
    crossModuleWrites: intakeWriteTargets,
  });
  const materialId = stableId('recall material');
  const intakeId = stableId('intake-document', materialId);
  const attachment = { id: materialId, title: '分组', text: '每组三枚', mode: 'prepare' };
  await handle({ ...scope, id: materialId, actor: 'learner', type: 'activity.captureIntake', purpose: 'storage', input: {
    materialId, intakeId, title: attachment.title,
    original: { name: 'groups.txt', mediaType: 'text/plain', size: 12, sha256: 'a'.repeat(64) },
    extraction: { method: 'utf8', status: 'ok', text: attachment.text, characterCount: attachment.text.length,
      pages: null, error: null, warnings: [], truncated: false },
  } });
  await handle({ ...scope, id: turnId, actor: 'learner', type: 'activity.submitTurn', purpose, input: {
    id: turnId, data: { sessionId: turnId, parentId: null, attachment, caseId: 'companion', answer: '备课', model, baseUrl, accountRevision, accountConfirmation:1 },
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
  const { rows: [issuance] } = await db.query('SELECT data FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=1',
    [studioLearner, first.issuanceId]);
  assert.deepEqual(issuance.data.materials.map(witness => witness.ref), [{ id: materialId, rev: 1 }, { id: intakeId, rev: 1 }]);
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
}

try {
  await withLearnerDatabase(studioLearner, exerciseRecall, { postgres: Boolean(connectionString), connectionString });
} finally {
  await rm(config, {recursive:true, force:true});
}
