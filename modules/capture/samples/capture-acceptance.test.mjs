// Run with MANGEKYO_CAPTURE_ACCEPTANCE_URL pointed at a disposable PostgreSQL database.
// runtime/studio/node_modules/.bin/tsx modules/capture/samples/capture-acceptance.test.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import exerciseNotion from './notion-acceptance.test.mjs';
import exerciseTextbook from '../../content/samples/textbook-acceptance.test.mjs';

const root = new URL('../../../', import.meta.url);
const load = file => import(new URL(file, root));
const require = createRequire(new URL('kernel/package.json', root));
const { Pool } = require('pg');
const { createPgDb } = await load('kernel/src/db/pg.ts');
const { applyKernelSchema } = await load('kernel/src/schema.ts');
const { loadModuleDirectory } = await load('kernel/src/loader.ts');
const { createCommandHandler } = await load('kernel/src/commands/handle.ts');
const { createStudioCommandHooks } = await load('runtime/studio/command-hooks.ts');
const { stableId } = await load('runtime/studio/identity.ts');

const connectionString = process.env.MANGEKYO_CAPTURE_ACCEPTANCE_URL;

const schema = 'capture_accept_' + randomUUID().replaceAll('-', '');
const admin = connectionString ? new Pool({ connectionString }) : null;
const { createPgliteDb } = await load('kernel/src/db/pglite.ts');
const db = admin ? createPgDb(new Pool({ connectionString }), { schema })
  : createPgliteDb(new (require('@electric-sql/pglite').PGlite)());
const learner = stableId('capture-acceptance-learner');

try {
  await admin?.query('CREATE SCHEMA ' + schema);
  await applyKernelSchema(db);
  await db.query('INSERT INTO learners(id) VALUES ($1)', [learner]);
  const modules = await Promise.all(['capture', 'content', 'activity'].map(name =>
    loadModuleDirectory(fileURLToPath(new URL('modules/' + name, root))),
  ));
  const handle = createCommandHandler(db, { modules, hooks: createStudioCommandHooks() });
  function send(type, input, { actor = 'learner', purpose = 'storage' } = {}) {
    return handle({ learner, id: stableId(randomUUID()), type, input, actor, purpose });
  }
  const fixture = { db, learner, stableId, load, send, assert };
  await run(fixture);
  await exerciseNotion(fixture);
  await exerciseTextbook(fixture);
} finally {
  await db.close();
  await admin?.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
  await admin?.end();
}

async function run({db,learner,stableId,load,send,assert}) {
  const {createCommandReadContext} = await load('kernel/src/commands/reads.ts');
  const {bindPaperCommandRead, defaultPaperRunId, projectIssuedPaper, paperIssuance, paperRun, paperReturnCoverage} = await load('modules/capture/paper.ts');
  const reads = (purpose, action) => db.snapshot({ learner }, tx => action(createCommandReadContext(tx, purpose)));
  const read = id => reads('storage', context => context.fact(id, {mode:'following'}));
  const at = '2026-11-21T01:00:00.000Z';
  const crop_ref = {original:0,page:1,bbox:[0.1,0.2,0.8,0.9]};
  const block = (id,body) => ({id,parentId:null,body:{kind:'capture',crop_ref,...body}});
  const envelope = (kind,hex,blocks=[]) => ({
    kind, occurredAt:at, recordedAt:at, retentionPolicy:'retained',
    originals:[{name:'page.jpg',blobRef:'accept:'+hex,mediaType:'image/jpeg',size:100,sha256:hex.repeat(64)}],
    unit:{kind:'capture',title:'跨页验证',blocks},
  });
  const base = stableId('capture-pg-fixture');
  const passage = '跨页共享材料🙂。'.repeat(120);
  const unknowable = block('unknown',{layer:'handwriting',status:'unknown',itemId:'q2',slotId:'slot1',candidates:['0.5','0.8']});
  const blocks = [
    block('shared',{layer:'material',status:'known',text:passage}),
    block('prompt1',{layer:'prompt',status:'known',text:'请答第 1 题。',itemId:'q1'}),
    block('prompt2',{layer:'prompt',status:'known',text:'问题第 2 题。'.repeat(100),itemId:'q2'}),
    block('answer',{layer:'reference-answer',status:'known',text:'hidden reference answer'}),
    block('rubric',{layer:'rubric',status:'known',text:'hidden scores'}),
    block('red', { layer: 'correction', status: 'known', text: 'hidden correction' }),
    unknowable,
  ];
  const targetCapture = id => ({ id, purpose: ['storage', 'teaching'], envelope: envelope('photo', 'f') });
  const learnerId=stableId('learner visual source');
  await send('capture.ingest', targetCapture(learnerId));
  const target = { target: { id: learnerId, rev: 1 }, blocks };
  await assert.rejects(send('capture.applyExtraction',target,{actor:'companion'}),/unedited companion draft/);
  const proposal=await send('capture.proposeExtraction',target,{actor:'companion'});
  assert.equal(proposal.state,'proposed');
  assert.equal((await read(learnerId)).ref.rev,1);

  const {gatherLayeredExtraction,settleLayeredExtraction,mergeLayeredSource,clarificationRegions,layeredExtractionSlot,layeredExtractionDeriver} = await load('modules/capture/extraction.ts');
  const {gatherSnapshot} = await load('kernel/src/derivations/gather.ts');
  const {sealCandidate,submitCandidate} = await load('kernel/src/derivations/candidate.ts');
  const {requestWork,runEffect} = await load('kernel/src/work/index.ts');
  await db.query("INSERT INTO slot_state(learner_id,slot_type,slot_key,scope_keys) VALUES ($1,$2,$3,'{}')",[learner,layeredExtractionSlot,learnerId]);
  const work = await db.tx({learner},tx=>tx.withLearnerWrite(tick=>requestWork(tx,tick,{slotType:layeredExtractionSlot,slotKey:learnerId,deriver:layeredExtractionDeriver})));
  const savedSource=await read(learnerId);
  const scope={learner,purpose:'teaching'};
  const targetKey={target:{id:learnerId,rev:savedSource.ref.rev},accessEpoch:savedSource.accessEpoch,modelMethod:'fixture/vision-v1'};
  const gathered=await gatherSnapshot(db,scope,ctx=>gatherLayeredExtraction(ctx,targetKey));
  assert.deepEqual(gathered.manifest.inputs,[{kind:'fact',id:learnerId,rev:1,accessEpoch:savedSource.accessEpoch,mode:'pinned'}]);
  const policy={deriver:layeredExtractionDeriver,purpose:'teaching',slot:{type:layeredExtractionSlot}};
  const sealed=await sealCandidate(db,work,policy,gathered);
  assert.equal(sealed.kind,'sealed');
  const [effect]=sealed.plan.effects;
  assert.equal(effect.input.modelMethod,'fixture/vision-v1');
  const wire=await runEffect(db,{learner,ownerKind:'derivation',ownerId:sealed.id,...effect},async()=>({version:effect.stepKey,blocks}),async tx=>{
    const pinned=await createCommandReadContext(tx,'teaching').fact(learnerId,{mode:'pinned',rev:1});
    assert.equal(pinned.accessEpoch,targetKey.accessEpoch);
  });
  assert.equal(wire.kind,'done');
  const outcome=settleLayeredExtraction(sealed.plan.data,[{request:effect,state:'done',result:wire.result}]);
  const forged = block('unknown', { ...unknowable.body, status: 'known', text: '猜测', author: 'learner', sticky: true });
  assert.equal(settleLayeredExtraction(sealed.plan.data, [{request:effect,state:'done',result:{version:effect.stepKey,blocks:[forged]}}]).kind, 'unknown');
  const submitted=await submitCandidate(db,work,policy,sealed.id,outcome,{onSlotChanged:()=>{}});
  assert.equal(submitted.kind,'effective');
  assert.equal((await read(learnerId)).ref.rev,1);
  assert.equal(mergeLayeredSource(await read(learnerId),outcome).source.unit.blocks.length,blocks.length);
  const layeredIssue = paperIssuance({source:targetKey.target,epoch:targetKey.accessEpoch,layout:{lines:10,columns:16},
    extraction:{derivationId:sealed.id,sourceRev:1,modelMethod:targetKey.modelMethod}});
  const preview = await reads('storage', context => projectIssuedPaper(bindPaperCommandRead(context, {readExtraction: async (_request, mode) => {
    assert.equal(mode, 'current');
    return {deriver:layeredExtractionDeriver,manifest:sealed.manifest,
      snapshot:{id:sealed.id,slot:{learner,type:layeredExtractionSlot,key:learnerId},outcome}};
  }}), layeredIssue));
  assert.match(preview.pages.flatMap(page=>page.pieces).map(piece=>piece.text).join(''), /请答第 1 题/);
  assert.doesNotMatch(JSON.stringify(preview), /hidden|blobRef|sha256/);
  const [region] = clarificationRegions(savedSource, outcome);
  assert.equal(region.originalSha256, savedSource.value.originals[0].sha256);
  assert.equal(region.id, 'unknown');
  const clarify = { target: { id: learnerId, rev: 1 }, blockId: 'unknown', anchor: unknowable };
  const asked = await send('capture.clarifyExtraction', clarify);
  assert.equal(asked.wrote[0].rev, 2);
  assert.equal((await send('capture.clarifyExtraction', { ...clarify, target: { id: learnerId, rev: 2 } })).wrote.length, 0);
  const fixed=await send('capture.correctExtraction',{target:{id:learnerId,rev:2},blockId:'unknown',anchor:unknowable,text:'0.5'});
  assert.equal(fixed.wrote[0].rev,3);
  const current=await gatherSnapshot(db,scope,async ctx=>({kind:'input',effects:[],data:
    (await ctx.read.slot({learner,type:layeredExtractionSlot,key:learnerId},{mode:'following'})).outcome,
  }));
  const live=mergeLayeredSource(await read(learnerId),current.plan.data);
  assert.equal(live.differences[0].blockId,'unknown');
  assert.equal(live.source.unit.blocks.find(b=>b.id==='unknown').body.text,'0.5');
  assert.deepEqual(clarificationRegions(await read(learnerId), outcome), []);
  assert.deepEqual(live.source.originals,savedSource.value.originals);
  console.log(JSON.stringify({checked:'capture slot pg',manifest:gathered.manifest.inputs,modelMethod:effect.input.modelMethod,
    derivation:sealed.id,sourceRev:fixed.wrote[0].rev,stickyDifferences:live.differences.length}));

  const draft = targetCapture(base);
  await send('capture.ingest', draft, { actor: 'companion' });
  await send('capture.applyExtraction', { target: { id: base, rev: 1 }, blocks }, { actor: 'companion' });
  const snapshot = await read(base);
  assert.deepEqual(snapshot.value.originals, draft.envelope.originals);
  assert.equal(snapshot.ref.rev, 2);
  assert.equal(snapshot.value.unit.blocks.length, blocks.length);
  const issue = {source:{id:base,rev:snapshot.ref.rev},epoch:snapshot.accessEpoch,layout:{lines:10,columns:16}};
  const issued = await send('capture.issuePaper',issue);
  const issuanceId = issued.wrote[0].id;
  assert.equal((await send('capture.issuePaper',issue)).wrote.length,0);
  const issuanceFact = await read(issuanceId);
  const projected = await reads('storage',ctx=>projectIssuedPaper(ctx,paperIssuance(issuanceFact.value)));
  assert.equal(projected.issuanceId,issuanceId);
  assert.ok(projected.pages.length>2);
  assert.equal(projected.pages.flatMap(page=>page.pieces).filter(piece=>piece.blockId==='shared').map(piece=>piece.text).join(''),passage);
  await assert.rejects(reads('storage',ctx=>projectIssuedPaper(ctx,{...issue,epoch:'999'})), /用途已变更/);
  assert.doesNotMatch(JSON.stringify(projected),/hidden|blobRef|crop_ref|sha256/);

  const questionId = stableId('textbook example'), pageId = stableId('textbook print');
  const written = await send('content.saveQuestion', { id: questionId, asset: {
    kind:'question', title:'应用题', promptBlockId:'statement', blocks:[
      {id:'statement',parentId:null,body:{kind:'text',text:'2 + 3 = ?'}},
      {id:'solution',parentId:null,body:{kind:'text',text:'hidden solution'}},
    ],
  } });
  await send('content.createTextbookPage', { id:pageId, clientEditSeq:1, page:{title:'教材应用题',blocks:[
    {id:'exposition',parentId:null,body:{kind:'text',text:'hidden commentary'}},
    {id:'question',parentId:null,body:{kind:'reference',role:'question',presentation:'embed',
      target:{fact:written.wrote[0],type:'content.asset',anchor:{kind:'whole'}}}},
  ]} });
  const textbook = {source:{id:pageId,rev:1},epoch:'0',layout:issue.layout};
  await assert.rejects(reads('storage',ctx=>projectIssuedPaper(ctx,textbook)), /未授权教学用途/);
  await assert.rejects(send('capture.issuePaper',textbook), /未授权教学用途/);

  const legacyId = stableId('legacy-workspace-question'), workbookId = stableId('legacy-workbook');
  const prompt = '2 + 3 = ?';
  await send('activity.saveWorkspaceEntry', { id: legacyId, entry: { kind: 'question', title: '旧题', body: prompt, answer: '5' }, basis: [] });
  await send('activity.saveWorkbookPaper', { id: workbookId, data: { title: '旧卷', savedAt: at, materialId: null,
    questions: [{ id: 'q1', kind: 'numeric', prompt, sourceQuestionRef: { id: legacyId, rev: 1 },
      answer: 5, tolerance: 0, unit: null, explanation: null }],
  } });
  const legacy = { ...issue, epoch: '0', source: { id: workbookId, rev: 1 } };
  assert.equal((await send('capture.issuePaper', legacy)).wrote.length, 1);
  await send('activity.setWorkspaceTeaching', { id: legacyId, expectedRev: 1, enabled: false });
  await assert.rejects(reads('storage', ctx => projectIssuedPaper(ctx, legacy)), /教学用途/);

  const questionPages = projected.pages.filter(page=>page.pieces.some(piece=>piece.itemId==='q2')).map(page=>page.number);
  assert.ok(questionPages.length>1);
  const runId = await defaultPaperRunId(issuanceId);
  for (const [i,page] of questionPages.entries()) {
    const source = stableId('return:'+i);
    const hex = (i+1).toString(16);
    await send('capture.ingest',{id:source,envelope:envelope('paper-return',hex)});
    const returned = {issuanceId,source:{id:source,rev:1},page,original:0};
    const receipts = i===0 ? await Promise.all([send('capture.collectPaper',returned),send('capture.collectPaper',returned)]) : [await send('capture.collectPaper',returned)];
    assert.equal(receipts.reduce((total,receipt)=>total+receipt.wrote.length,0),1);
    const run = paperRun((await read(runId)).value);
    const coverage = paperReturnCoverage(projected.pages,run.pages.map(page=>page.number));
    assert.equal(coverage.find(item=>item.itemId==='q2').status,i===questionPages.length-1?'pages-received':'unsubmitted');
    if(i===0) {
      const retryId=stableId('intentional retry');
      assert.equal((await send('capture.collectPaper',{...returned,retryId})).wrote[0].id,retryId);
    }
  }
  const run = paperRun((await read(runId)).value);
  assert.equal(run.pages.length,questionPages.length);
  console.log(JSON.stringify({checked:'capture pg',pages:projected.pages.length,returned:run.pages.length,stickyText:'0.5'}));
}
