// Run through tsx with MANGEKYO_CAPTURE_ACCEPTANCE_URL pointing at an owned, disposable loopback PostgreSQL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createCommandReadContext } from '../../../kernel/src/commands/reads.ts';
import { createPgDb } from '../../../kernel/src/db/pg.ts';
import { sealCandidate, submitCandidate } from '../../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../../kernel/src/derivations/gather.ts';
import { loadModuleDirectory } from '../../../kernel/src/loader.ts';
import { applyKernelSchema } from '../../../kernel/src/schema.ts';
import { requestWork, runEffect } from '../../../kernel/src/work/index.ts';
import { createStudioCommandHooks } from '../../../runtime/studio/command-hooks.ts';
import { stableId } from '../../../runtime/studio/identity.ts';
import {
  clarificationRegions, gatherLayeredExtraction, layeredExtractionDeriver, layeredExtractionSlot,
  openCapturedAssessment, settleLayeredExtraction,
} from '../extraction.ts';
import {
  gather as gatherQuestion, questionVerificationEffectResult, questionVerificationKey,
  questionVerificationType, settle as settleQuestion,
} from '../../content/question-verification.ts';

const url = new URL(process.env.MANGEKYO_CAPTURE_ACCEPTANCE_URL);
assert.equal(url.hostname, '127.0.0.1');
assert.ok(url.port);
const { Pool } = createRequire(new URL('../../../kernel/package.json', import.meta.url))('pg');
const admin = new Pool({ connectionString: url.href });
const schema = 'layered_capture_' + randomUUID().replaceAll('-', '');
const db = createPgDb(new Pool({ connectionString: url.href }), { schema });
const learner = stableId('layered-paper-learner');
const scope = { learner, purpose: 'teaching' };
const sourceId = stableId('four-page-capture');
const questionId = stableId('captured-distance-item');
const id = () => stableId(randomUUID());

async function publish(type, key, deriver, gather, invoke, settle) {
  await db.query('INSERT INTO slot_state(learner_id,slot_type,slot_key,scope_keys) VALUES ($1,$2,$3,$4)',
    [learner,type,key,'{}']);
  const work = await db.tx({ learner }, tx => tx.withLearnerWrite(tick =>
    requestWork(tx, tick, { slotType: type, slotKey: key, deriver })));
  const policy = { deriver, purpose: scope.purpose, slot: { type } };
  const sealed = await sealCandidate(db, work, policy, await gatherSnapshot(db, scope, gather));
  assert.equal(sealed.kind, 'sealed');
  const receipts = [];
  for (const request of sealed.plan.effects) {
    const reply = await runEffect(db, { learner, ownerKind: 'derivation', ownerId: sealed.id, ...request },
      invocation => invoke(request, invocation), undefined, { manifest: sealed.manifest });
    assert.equal(reply.kind, 'done');
    receipts.push({ ownerId: sealed.id, request, state:'done', result: reply.result });
  }
  const outcome = settle(sealed, receipts);
  assert.equal((await submitCandidate(db, work, policy, sealed.id, outcome, { onSlotChanged: () => {} })).kind, 'effective');
  return { derivation: sealed.id, receipts: receipts.length };
}

try {
  await admin.query('CREATE SCHEMA ' + schema);
  await applyKernelSchema(db);
  await db.query('INSERT INTO learners(id) VALUES ($1)', [learner]);
  const modules = await Promise.all(['capture', 'content'].map(name =>
    loadModuleDirectory(fileURLToPath(new URL('../../../modules/' + name, import.meta.url)))));
  const handle = createCommandHandler(db, { modules, hooks: createStudioCommandHooks() });
  const send = (type, input, actor = 'learner') => handle({ learner, id: id(), type, input, actor, purpose: 'storage' });
  const current = () => db.snapshot({ learner }, tx => createCommandReadContext(tx, 'teaching').fact(sourceId, { mode: 'following' }));
  const read = input => gatherSnapshot(db, scope, async ({ read }) => ({
    kind: 'input', effects: [], data: await openCapturedAssessment(read, { sourceId, itemId: 'distance', ...input }),
  }));
  const at = '2026-11-21T01:00:00.000Z';
  const originals = Array.from({ length: 4 }, (_, index) => ({
    name: `page-${index + 1}.jpg`, blobRef: `fixture:${index}`, mediaType:'image/jpeg', size: 100,
    sha256: String(index + 1).repeat(64),
  }));
  const block = (id, original, layer, data, parentId = null) => ({
    id, parentId, body: { kind:'capture', layer, crop_ref: {original, page:1, bbox:[0.1, 0.2, 0.8, 0.9]}, ...data },
  });
  const handwriting = { itemId:'distance', slotId:'answer' };
  const unknown = block('faint', 2, 'handwriting', { ...handwriting, status:'unknown', candidates:['30','36'] });
  const blocks = [
    block('material-1', 0, 'material', { status:'known', text:'第一段骑行速度为每小时 15 千米。' }),
    block('material-2', 1, 'material', { status:'known', text:'这段路一共用了 2 小时。' }, 'material-1'),
    block('prompt-1', 1, 'prompt', { status:'known', text:'按所给速度和时间计算。', itemId:'distance' }, 'material-2'),
    block('prompt-2', 2, 'prompt', { status:'known', text:'第一段骑行了多少千米？', itemId:'distance' }, 'prompt-1'),
    unknown,
    block('teacher', 3, 'correction', { ...handwriting, status:'known', text:'RED SECRET' }),
    block('teacher-child', 3, 'handwriting', { ...handwriting, status:'known', text:'RED CHILD SECRET' }, 'teacher'),
    block('school', 3, 'reference-answer', { status:'known', text:'SCHOOL SECRET' }),
    block('rubric', 3, 'rubric', { status:'known', text:'RUBRIC SECRET' }),
  ];
  await send('capture.ingest', { id: sourceId, purpose:['storage','teaching'], envelope:{
    kind:'photo', occurredAt:at, recordedAt:at, retentionPolicy:'retained', originals,
    unit:{kind:'capture',title:'四页原件',blocks:[]},
  } });
  const { accessEpoch, ref } = await current();
  const extraction = await publish(layeredExtractionSlot, sourceId, layeredExtractionDeriver,
    ctx => gatherLayeredExtraction(ctx, { target:ref, accessEpoch, modelMethod:'fixture/layers', redInkMeaning:'红笔是事后订正' }),
    request => {
      assert.deepEqual(request.input.originals, originals);
      assert.equal(request.input.redInkMeaning, '红笔是事后订正');
      return { version: request.stepKey, blocks };
    }, (sealed, receipts) => settleLayeredExtraction(sealed.plan.data, receipts));
  const gap = (await read({ extraction:'layered' })).plan.data;
  assert.equal(gap.kind, 'question-gap');
  assert.deepEqual(gap.passages.map(({ blockId }) => blockId), ['material-1','material-2']);
  assert.doesNotMatch(JSON.stringify(gap), /SECRET|candidates|blobRef/);

  const target = async () => (await current()).ref;
  async function confirmBlocks(target, blocks) {
    const type = 'capture.proposeExtraction';
    const proposal = await send(type, { target, blocks }, 'companion');
    assert.equal(proposal.state, 'proposed');
    return handle.decideProposal({
      learner, id:id(), type, purpose:'storage', proposalId:proposal.commandId, selection:true,
    }, async (_tx, input) => input);
  }
  const invalid = block('invalid', 4, 'material', { status:'known', text:'未交原图' });
  await assert.rejects(confirmBlocks(ref, [invalid]), /内容块缺少原图/);
  await confirmBlocks(ref, blocks);
  const [region] = clarificationRegions(await current(), null);
  assert.deepEqual([region.id, region.originalSha256, region.candidates], ['faint', originals[2].sha256, ['30','36']]);
  assert.equal((await read({ questionId })).plan.data.kind, 'waiting');
  await send('capture.clarifyExtraction', { target:await target(), blockId:'faint' });
  const renamed = { ...unknown, id:'faint-again' };
  assert.equal((await send('capture.clarifyExtraction', { target:await target(), blockId:renamed.id, anchor:renamed })).wrote.length, 0);
  await send('capture.correctExtraction', { target:await target(), blockId:renamed.id, anchor:renamed, text:'30' });
  const guessed = block('faint-again', 2, 'handwriting', { ...handwriting, status:'known', text:'36' });
  const reextract = await confirmBlocks(await target(), blocks.map(entry => entry === unknown ? guessed : entry));
  assert.equal(reextract.wrote.length, 0);
  const displaced = block('faint', 3, 'handwriting', { ...handwriting, status:'known', text:'36' });
  await assert.rejects(confirmBlocks(await target(), blocks.map(entry => entry === unknown ? displaced : entry)), /改指到另一页/);
  assert.deepEqual(clarificationRegions(await current(), null), []);

  const source = await current();
  const statement = { id:'statement', parentId:null, body:{kind:'text', text:gap.prompt} };
  const materials = gap.passages.map(({ blockId }) => ({
    id:blockId, parentId:null, body:{kind:'sharedMaterial', source:{
      fact:source.ref, type:source.type, anchor:{kind:'block',blockId},
    }},
  }));
  const written = await send('content.saveQuestion', { id:questionId, purpose:'teaching', asset:{
    kind:'question', title:'骑行', promptBlockId:statement.id, blocks:[statement, ...materials],
    basis:[{id:sourceId, rev:source.ref.rev, epoch:source.accessEpoch, type:source.type}],
    response_schema:[{slotId:'answer',schemaVersion:'1',fields:[{kind:'numeric',path:''}]}],
    assessment_contract:[{criterionId:'distance',inputs:[{slotId:'answer',path:''}],maximum:1,
      missingEvidence:'insufficient-evidence',evaluator:{id:'frozen-value-match',version:'1'},parameters:{value:30}}],
  } });
  const question = written.wrote.find(row => row.id === questionId);
  assert.deepEqual((await read({ questionId })).plan.targets,
    [{kind:'slot',ref:{learner,type:questionVerificationType,key:questionVerificationKey(question)}}]);
  const verification = await publish(questionVerificationType, questionVerificationKey(question), 'content/question-verification',
    ctx => gatherQuestion(ctx, question), (request, invocation) => {
      assert.doesNotMatch(JSON.stringify(request.input), /SECRET|candidates|blobRef/);
      assert.equal(request.input.prompt, gap.prompt);
      return questionVerificationEffectResult(invocation, {
        answerKey:'30 km', conditionKey:'constant speed for two hours', reasoning:'fixture receipt', eligible:true,
      });
    }, (sealed, receipts) => {
      const wrong = { ...receipts[1], result: { ...receipts[1].result, result: { answerKey:'36 km' } } };
      assert.equal(settleQuestion(sealed, [receipts[0], wrong, ...receipts.slice(2)]).value.status, 'needs-review');
      return settleQuestion(sealed, receipts);
    });
  const observed = await read({ questionId, extraction:'layered' });
  const ready = observed.plan.data;
  assert.equal(ready.kind, 'ready');
  assert.deepEqual(ready.answers.map(({ id, body }) => [id, body.text, body.sticky, body.crop_ref.original]), [['faint','30',true,2]]);
  assert.deepEqual(source.value.originals, originals);
  assert.ok(observed.manifest.inputs.some(entry => entry.kind === 'slot' && entry.derivationId === verification.derivation));
  console.log(JSON.stringify({ pages:originals.length, captureRev:source.ref.rev, extraction, verification,
    questionSlot:questionVerificationKey(question), firstHandwriting:ready.answers[0].body.text, state:ready.kind }));
} finally {
  await db.close();
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
  await admin.end();
}
