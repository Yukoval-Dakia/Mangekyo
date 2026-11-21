// Use PGlite by default or set MANGEKYO_TEST_DATABASE_URL to an owned, disposable loopback PostgreSQL.
// runtime/studio/node_modules/.bin/tsx modules/capture/samples/capture-acceptance.test.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { loadStudioTestModule } from '../../../runtime/studio/test/modules.ts';
import {
  clarificationRegions, gatherLayeredExtraction, layeredExtractionDeriver, layeredExtractionSlot,
  mergeLayeredSource, settleLayeredExtraction,
} from '../extraction.ts';
import { sourceBlocks } from '../source.ts';
import exerciseLayeredPaper from './layered-paper-assessment.test.mjs';
import exerciseNotion from './notion-acceptance.test.mjs';
import exerciseTextbook from '../../content/samples/textbook-acceptance.test.mjs';
import { numericQuestion } from '../../content/samples/fixtures/question.ts';

const root = new URL('../../../', import.meta.url);
const load = file => import(new URL(file, root));
const { createCommandHandler } = await load('kernel/src/commands/handle.ts');
const { createStudioCommandHooks } = await load('runtime/studio/command-hooks.ts');
const { stableId } = await load('runtime/studio/identity.ts');
const { createCommandReadContext, UnsupportedReadError } = await load('kernel/src/commands/reads.ts');
const { gatherSnapshot } = await load('kernel/src/derivations/gather.ts');
const { readEffectiveSlotVersion } = await load('kernel/src/derivations/revalidate.ts');
const { sealCandidate, submitCandidate } = await load('kernel/src/derivations/candidate.ts');
const { runEffect } = await load('kernel/src/work/index.ts');
const { enqueueWork } = await load('kernel/src/work/todos.ts');
const learner = stableId('capture-acceptance-learner');
const commandId = () => stableId(randomUUID());
const at = '2026-11-21T01:00:00.000Z';
const captureBlock = (id, body, original = 0, parentId = null) => ({
  id, parentId, body: { kind: 'capture', crop_ref: { original, page: 1, bbox: [0.1, 0.2, 0.8, 0.9] }, ...body },
});
const jpeg = (name, blobRef, hex) => ({ name, blobRef, mediaType: 'image/jpeg', size: 100, sha256: hex.repeat(64) });

const connectionString = process.env.MANGEKYO_CAPTURE_ACCEPTANCE_URL ?? testDatabaseUrl;
await withLearnerDatabase(learner, async db => {
  const gather = (plan, purpose = 'teaching') => gatherSnapshot(db, { learner, purpose }, plan);
  const gatherValue = (read, purpose) => gather(async context => ({
    kind: 'input', effects: [], data: await read(context),
  }), purpose);
  const modules = await Promise.all(['capture', 'content', 'activity'].map(loadStudioTestModule));
  const hooks = createStudioCommandHooks();
  const withExtraction = (tx, purpose, base) => ({ ...base, async slot(ref, options) {
    if (ref.type !== layeredExtractionSlot || options.mode !== 'following') return base.slot(ref, options);
    const effective = await readEffectiveSlotVersion(tx, ref, layeredExtractionDeriver, purpose);
    if (!effective) throw new Error('Expected an effective extraction');
    return effective.snapshot;
  } });
  const handle = createCommandHandler(db, { modules, hooks, bindCommandRead: (tx, request, base) => withExtraction(tx, request.purpose, base) });
  function send(type, input, { actor = 'learner', purpose = 'storage', commandId: id = commandId() } = {}) {
    return handle({ learner, id, type, input, actor, purpose });
  }
  const sendCompanion = (type, input, purpose) => send(type, input, { actor: 'companion', purpose });
  const snapshot = action => db.snapshot({ learner }, action);
  const read = (action, purpose = 'storage', layered = false) => snapshot(tx => {
    const base = createCommandReadContext(tx, purpose);
    return action(layered ? withExtraction(tx, purpose, base) : base);
  });
  const current = (id, purpose) => read(context => context.fact(id, { mode: 'following' }), purpose);
  const ingestVisual = (id, title, originals, { kind = 'photo', paperReturn, actor } = {}) => send('capture.ingest', {
    id, purpose: ['storage', 'teaching'], ...(paperReturn && { paperReturn }),
    envelope: { kind, occurredAt: at, recordedAt: at, retentionPolicy: 'retained', originals,
      unit: { kind: 'capture', title, blocks: [] } },
  }, { actor });
  async function proposeExtraction(input) {
    const proposal = await send('capture.proposeExtraction', input, { actor: 'companion' });
    assert.equal(proposal.state, 'proposed');
    return proposal.commandId;
  }
  const confirmExtraction = async input => handle.decideProposal({
    learner, id: commandId(), type: 'capture.proposeExtraction', purpose: 'storage', proposalId: await proposeExtraction(input), selection: true,
  }, async (_tx, input) => input);

  async function publish(slotType, slotKey, deriver, { plan, inspect, invoke, authorize, settle }) {
    const work = await db.tx({ learner }, tx => tx.withLearnerWrite(tick =>
      enqueueWork(tx, tick, { slotType, slotKey, deriver })));
    const policy = { deriver, purpose: 'teaching', slot: { type: slotType } };
    const gathered = await gather(plan);
    inspect?.(gathered);
    const sealed = await sealCandidate(db, work, policy, gathered);
    assert.equal(sealed.kind, 'sealed');
    const receipts = [];
    for (const request of sealed.plan.effects) {
      const reply = await runEffect(db, { learner, ownerKind: 'derivation', ownerId: sealed.id, ...request },
        invocation => invoke(request, invocation), authorize, authorize ? undefined : { manifest: sealed.manifest });
      assert.equal(reply.kind, 'done');
      receipts.push({ ownerId: sealed.id, request, state: 'done', result: reply.result });
    }
    const outcome = settle(sealed, receipts);
    assert.equal((await submitCandidate(db, work, policy, sealed.id, outcome, hooks)).kind, 'effective');
    return { sealed, outcome };
  }

  const extract = (key, blocks, originals, { inspect, authorize, settle = settleLayeredExtraction } = {}) =>
    publish(layeredExtractionSlot, key.target.id, layeredExtractionDeriver, {
      plan: ctx => gatherLayeredExtraction(ctx, key),
      inspect,
      invoke: ({ input, stepKey }) => {
        assert.deepEqual(input.originals, originals);
        assert.equal(input.modelMethod, key.modelMethod);
        assert.equal(input.redInkMeaning, key.redInkMeaning ?? null);
        return { version: stepKey, blocks };
      },
      authorize,
      settle: ({ plan }, receipts) => settle(plan.data, receipts),
    });
  const fixture = { db, learner, stableId, load, send, sendCompanion, assert, snapshot, read, current, hooks, gatherValue, publish, extract,
    proposeExtraction, confirmExtraction, captureBlock, ingestVisual, jpeg, numericQuestion,
    content: modules.find(module => module.definition.name === 'content') };
  await run(fixture);
  await exerciseLayeredPaper(fixture);
  await exerciseNotion(fixture);
  await exerciseTextbook(fixture, handle.decideProposal);
}, { postgres: Boolean(connectionString), connectionString });

async function run({ send, read, current, gatherValue, extract, ingestVisual, proposeExtraction, confirmExtraction }) {
  const {bindPaperCommandRead, defaultPaperRunId, projectIssuedPaper, projectNewPaper, paperIssuance,
    paperRun, paperReturnCoverage} = await load('modules/capture/paper.ts');
  const {openPaperRun} = await load('modules/capture/paper-answers.ts');
  const firstPage = hex => jpeg('page.jpg', 'accept:' + hex, hex);
  const originals = [firstPage('f')];
  const base = stableId('capture-pg-fixture');
  const passage = '跨页共享材料🙂。'.repeat(120);
  const unknowable = captureBlock('unknown',{crop_ref:{original:0,page:1,bbox:[0.1,0.2,0.8,0.26]},
    layer:'handwriting',status:'unknown',itemId:'q2',slotId:'slot1',candidates:['0.5','0.8']});
  const blocks = [
    captureBlock('shared',{layer:'material',status:'known',text:passage}),
    captureBlock('prompt1',{layer:'prompt',status:'known',text:'请答第 1 题。',itemId:'q1'}),
    captureBlock('prompt2',{layer:'prompt',status:'known',text:'问题第 2 题。'.repeat(100),itemId:'q2'}),
    captureBlock('answer',{layer:'reference-answer',status:'known',text:'hidden reference answer'}),
    captureBlock('rubric',{layer:'rubric',status:'known',text:'hidden scores'}),
    captureBlock('red', { layer: 'correction', status: 'known', text: 'hidden correction' }),
    unknowable,
  ];
  const learnerId=stableId('learner visual source');
  await ingestVisual(learnerId, '跨页验证', originals);
  const target = { target: { id: learnerId, rev: 1 }, blocks };
  await assert.rejects(send('capture.applyExtraction',target,{actor:'companion'}),/unedited companion draft/);
  await proposeExtraction(target);
  const savedSource = await current(learnerId);
  assert.equal(savedSource.ref.rev, 1);
  const targetKey={target:{id:learnerId,rev:savedSource.ref.rev},accessEpoch:savedSource.accessEpoch,modelMethod:'fixture/vision-v1'};
  const { sealed, outcome } = await extract(targetKey, blocks, originals, {
    inspect: ({ manifest }) => assert.deepEqual(manifest.inputs, [
      { kind: 'fact', id: learnerId, rev: 1, accessEpoch: savedSource.accessEpoch, mode: 'pinned' },
    ]),
    authorize: async tx => {
      const pinned = await createCommandReadContext(tx, 'teaching').fact(learnerId, { mode: 'pinned', rev: 1 });
      assert.equal(pinned.accessEpoch, targetKey.accessEpoch);
    },
  });
  const [effect] = sealed.plan.effects;
  const forged = captureBlock('unknown', { ...unknowable.body, status: 'known', text: '猜测', author: 'learner', sticky: true });
  assert.equal(settleLayeredExtraction(sealed.plan.data, [{request:effect,state:'done',result:{version:effect.stepKey,blocks:[forged]}}]).kind, 'unknown');
  assert.equal((await current(learnerId)).ref.rev,1);
  assert.equal(mergeLayeredSource(await current(learnerId),outcome).source.unit.blocks.length,blocks.length);
  const layeredIssue = paperIssuance({source:targetKey.target,epoch:targetKey.accessEpoch,layout:{lines:10,columns:16},
    extraction:{derivationId:sealed.id,sourceRev:1,modelMethod:targetKey.modelMethod}});
  const layeredPreview = outcome => read(context => projectIssuedPaper(bindPaperCommandRead(context, {readExtraction: async (_request, mode) => {
    assert.equal(mode, 'current');
    return {deriver:layeredExtractionDeriver,manifest:sealed.manifest,
      snapshot:{id:sealed.id,slot:{learner,type:layeredExtractionSlot,key:learnerId},outcome}};
  }}), layeredIssue));
  const preview = await layeredPreview(outcome);
  assert.match(preview.pages.flatMap(page=>page.pieces).map(piece=>piece.text).join(''), /请答第 1 题/);
  assert.doesNotMatch(JSON.stringify(preview), /hidden|blobRef|sha256/);
  const invalidMaterial = captureBlock('invalid-material', { layer:'material', status:'known', text:'M'.repeat(160),
    crop_ref:{original:0,page:2,bbox:[0.1,0.2,0.8,0.9]} });
  const revised = await layeredPreview({ ...outcome, value:{ ...outcome.value, blocks:[invalidMaterial,...outcome.value.blocks] } });
  assert.notEqual(revised.issuanceId, preview.issuanceId);
  assert.deepEqual(revised.pages, preview.pages);
  await assert.rejects(send('capture.issuePaper', { ...layeredIssue, edition:'layered-print-crops-v1' }), /版记由服务端/);
  const [region] = clarificationRegions(savedSource, outcome);
  assert.equal(region.originalSha256, savedSource.value.originals[0].sha256);
  assert.equal(region.id, 'unknown');
  const clarify = { target: { id: learnerId, rev: 1 }, blockId: 'unknown', anchor: unknowable };
  const asked = await send('capture.clarifyExtraction', clarify);
  assert.equal(asked.wrote[0].rev, 2);
  assert.equal((await send('capture.clarifyExtraction', { ...clarify, target: { id: learnerId, rev: 2 } })).wrote.length, 0);
  const fixed=await send('capture.correctExtraction',{target:{id:learnerId,rev:2},blockId:'unknown',anchor:unknowable,text:'0.5'});
  assert.equal(fixed.wrote[0].rev,3);
  const liveSlot = await gatherValue(async ({ read }) =>
    (await read.slot({ learner, type: layeredExtractionSlot, key: learnerId }, { mode: 'following' })).outcome);
  const live=mergeLayeredSource(await current(learnerId),liveSlot.plan.data);
  assert.equal(live.differences[0].blockId,'unknown');
  assert.equal(live.source.unit.blocks.find(b=>b.id==='unknown').body.text,'0.5');
  assert.deepEqual(clarificationRegions(await current(learnerId), outcome), []);
  assert.deepEqual(live.source.originals,savedSource.value.originals);
  console.log(JSON.stringify({checked:'capture slot pg',manifest:sealed.manifest.inputs,modelMethod:effect.input.modelMethod,
    derivation:sealed.id,sourceRev:fixed.wrote[0].rev,stickyDifferences:live.differences.length}));

  await ingestVisual(base, '跨页验证', originals, { actor: 'companion' });
  await send('capture.applyExtraction', { target: { id: base, rev: 1 }, blocks }, { actor: 'companion' });
  const snapshot = await current(base);
  assert.deepEqual(snapshot.value.originals, originals);
  assert.equal(snapshot.ref.rev, 2);
  assert.equal(snapshot.value.unit.blocks.length, blocks.length);
  const issue = {source:{id:base,rev:snapshot.ref.rev},epoch:snapshot.accessEpoch,layout:{lines:10,columns:16}};
  const issued = await send('capture.issuePaper',issue);
  const issuanceId = issued.wrote[0].id;
  assert.equal((await send('capture.issuePaper',issue)).wrote.length,0);
  const issuanceFact = await current(issuanceId);
  const projected = await read(ctx=>projectIssuedPaper(ctx,paperIssuance(issuanceFact.value)));
  assert.equal(projected.issuanceId,issuanceId);
  assert.ok(projected.pages.length>2);
  assert.equal(projected.pages.flatMap(page=>page.pieces).filter(piece=>piece.blockId==='shared').map(piece=>piece.text).join(''),passage);
  await assert.rejects(read(ctx=>projectIssuedPaper(ctx,{...issue,epoch:'999'})), /用途已变更/);
  assert.doesNotMatch(JSON.stringify(projected),/hidden|blobRef|crop_ref|sha256/);

  const prompt = '2 + 3 = ?';
  const questionId = stableId('textbook example'), pageId = stableId('textbook print');
  const solution = { id: 'solution', parentId: null, body: { kind: 'text', text: 'hidden solution' } };
  const written = await send('content.saveQuestion', {
    id: questionId, asset: numericQuestion('应用题', prompt, 'sum', 5, [solution]),
  });
  await send('content.createTextbookPage', { id:pageId, clientEditSeq:1, page:{title:'教材应用题',blocks:[
    {id:'exposition',parentId:null,body:{kind:'text',text:'hidden commentary'}},
    {id:'question',parentId:null,body:{kind:'reference',role:'question',presentation:'embed',
      target:{fact:written.wrote[0],type:'content.asset',anchor:{kind:'whole'}}}},
  ]} });
  const textbook = {source:{id:pageId,rev:1},epoch:'0',layout:issue.layout};
  await assert.rejects(read(ctx=>projectIssuedPaper(ctx,textbook)), /未授权教学用途/);
  await assert.rejects(send('capture.issuePaper',textbook), /未授权教学用途/);

  const { freezeQuestionAssessment, questionAsset } = await load('modules/content/asset.ts');
  const { questionVerificationKey, questionVerificationType } = await load('modules/content/question-state.ts');
  await send('content.setQuestionTeaching', { id: questionId, expectedRev: 1, allowed: true });
  const bank = await current(questionId);
  const [assessment] = freezeQuestionAssessment(questionAsset(bank.value), bank.ref).items;
  const entry = { kind: 'question', title: '旧题', body: prompt, answer: '5' };
  const question = { id: 'q1', kind: 'numeric', prompt, answer: 5, tolerance: 0, unit: null, explanation: null };
  async function legacyWorkbook(id, field) {
    const source = { id: stableId(id + field), rev: 1 };
    const pinned = { id, rev: 1 };
    const data = field === 'promptRef'
      ? { questions: [question], assessmentRelease: { releaseRef: source, items: [{ ...assessment, itemId: 'q1', promptRef: pinned }] } }
      : { questions: [{ ...question, sourceQuestionRef: pinned }] };
    await send('activity.saveWorkbookPaper', { id: source.id, data: { title: '旧卷', materialId: null, savedAt: at, ...data } });
    return { ...issue, source, epoch: '0' };
  }
  const originalId = stableId('legacy-workspace-question');
  await send('activity.saveWorkspaceEntry', { id: originalId, entry, basis: [] });
  const histories = await Promise.all(['sourceQuestionRef','promptRef'].map(field => legacyWorkbook(originalId, field)));
  for (const paper of histories) assert.equal((await send('capture.issuePaper',paper)).wrote.length,1);
  await send('activity.setWorkspaceTeaching', { id: originalId, expectedRev: 1, enabled: false });
  for (const paper of histories) await assert.rejects(read(ctx=>projectIssuedPaper(ctx,paper)), /教学用途/);

  const wrapperId = stableId('legacy-with-iqdb-basis');
  await send('activity.saveWorkspaceEntry', { id: wrapperId, entry, basis: [{ id: questionId, rev: bank.ref.rev, epoch: bank.accessEpoch }] });
  const throughPrompt = await legacyWorkbook(wrapperId, 'promptRef');
  await assert.rejects(send('capture.issuePaper', throughPrompt), UnsupportedReadError);
  const missingReady = await gatherValue(({ read }) => projectNewPaper(read, throughPrompt), 'storage');
  assert.deepEqual(missingReady.plan, {kind:'waiting', targets:[
    {kind:'slot',ref:{learner,type:questionVerificationType,key:questionVerificationKey(bank.ref)}},
  ]});
  await send('content.setQuestionTeaching', { id: questionId, expectedRev: bank.ref.rev, allowed: false });
  await assert.rejects(read(ctx=>projectNewPaper(ctx,throughPrompt)), /来源权限已变更/);

  const questionPages = projected.pages.filter(page=>page.pieces.some(piece=>piece.itemId==='q2')).map(page=>page.number);
  assert.ok(questionPages.length>1);
  const runId = await defaultPaperRunId(issuanceId);
  const view = (id = runId) => read(ctx => openPaperRun(ctx,{issuanceId,runId:id}));
  const item = async id => (await view(id)).items.find(row=>row.itemId==='q2');
  const retryId=stableId('intentional retry');
  assert.equal((await read(ctx=>openPaperRun(ctx,{issuanceId}))).items.find(row=>row.itemId==='q2').status,'unsubmitted');
  for (const [i,page] of questionPages.entries()) {
    const source = stableId('return:'+i);
    const hex = (i+1).toString(16);
    const start = performance.now();
    await ingestVisual(source, '跨页验证', [firstPage(hex)], {
      kind: 'paper-return', paperReturn: i === 1 ? { issuanceId, page, original: 0 } : undefined,
    });
    const ingestMs = performance.now() - start;
    const returned = {issuanceId,source:{id:source,rev:1},page,original:0};
    if(i===1) await assert.rejects(send('capture.collectPaper',{...returned,page:questionPages[0],retryId}),/与原件确认/);
    const receipts = i===0 ? await Promise.all([send('capture.collectPaper',returned),
      send('capture.collectPaper',{source:returned.source,original:0,marker:{issuanceId,page}})]) : [await send('capture.collectPaper',returned)];
    assert.equal(receipts.reduce((total,receipt)=>total+receipt.wrote.length,0),1);
    const run = paperRun((await current(runId)).value);
    const coverage = paperReturnCoverage(projected.pages,run.pages.map(page=>page.number));
    assert.equal(coverage.find(item=>item.itemId==='q2').status,i===questionPages.length-1?'pages-received':'unsubmitted');
    if(i===0) {
      assert.equal((await send('capture.collectPaper',{...returned,retryId})).wrote[0].id,retryId);
      await assert.rejects(send('capture.collectPaper',{...returned,marker:{issuanceId:stableId('different edition'),page}}),/定位与所选发卷/);
      const red = captureBlock('red-return',{layer:'correction',status:'known',text:'RED'});
      const ink = [unknowable, red, captureBlock('red-child',{layer:'handwriting',status:'known',text:'RED',itemId:'q2',slotId:'slot1'},0,red.id)];
      await confirmExtraction({target:returned.source,blocks:ink});
      const before = await item();
      assert.equal(before.status,'unsubmitted');
      assert.deepEqual([before.number,before.answers.length],[2,1]);
      const input = {issuanceId,runId,itemId:'q2',slotId:'slot1',witness:before.answers[0].witness};
      const ask = () => send('capture.clarifyPaperAnswer',input);
      assert.equal((await Promise.all([ask(),ask()])).reduce((sum,receipt)=>sum+receipt.wrote.length,0),1);
      await assert.rejects(send('capture.correctPaperAnswer',{...input,text:'0.5'}),/原件版本已变更/);
      const asked = (await item()).answers[0];
      assert.equal(asked.value.region.clarification,'asked');
      assert.equal((await item(retryId)).answers[0].value.region.clarification,'pending');
      await send('capture.correctPaperAnswer',{...input,witness:asked.witness,text:'0.5'});
      await confirmExtraction({target:(await current(source)).ref,blocks:[{...unknowable,id:'renamed',body:{...unknowable.body,status:'known',text:'0.8'}},red]});
      assert.deepEqual((await item()).answers.map(answer=>answer.value),[{status:'known',text:'0.5',sticky:true}]);
      assert.equal((await item(retryId)).answers[0].value.text,'0.8');
      console.log(JSON.stringify({checked:'paper-run answers pg',ingestMs,question:before.number,askWrites:1,original:asked.witness.originalSha256}));
    }
  }
  const run = paperRun((await current(runId)).value);
  assert.equal(run.pages.length,questionPages.length);
  await confirmExtraction({target:issue.source,blocks:blocks.map(block=>block.id==='prompt2' ? {...block,body:{...block.body,text:'新版本题面'}} : block)});
  const next = await send('capture.issuePaper',{...issue,source:(await current(base)).ref});
  assert.notEqual(next.wrote[0].id,issuanceId);
  await assert.rejects(read(ctx=>openPaperRun(ctx,{issuanceId:next.wrote[0].id,runId})),/回收与发卷不匹配/);
  assert.deepEqual(await read(ctx=>projectIssuedPaper(ctx,issue)),projected);
  assert.equal((await item()).status,'recognized');
  const photo = [firstPage('a')], source = stableId('paper witness photo');
  const captured = await ingestVisual(source, '手写', photo, { kind: 'paper-return' });
  const returned = {issuanceId,source:captured.wrote[0],page:questionPages[0],original:0};
  const [first,redo] = ['paper witness run','paper witness redo'].map(label=>stableId(label));
  for (const retryId of [first,redo]) await send('capture.collectPaper',{...returned,retryId});
  const key = {target:returned.source,accessEpoch:'0',modelMethod:'fixture/vision-v1'};
  const layerView = async runId => (await read(ctx=>openPaperRun(ctx,{issuanceId,runId,extraction:'layered'}),'storage',true))
    .items.find(item=>item.itemId==='q2').answers;
  const reopen = async runId => (await layerView(runId))[0].witness;
  const input = {issuanceId,runId:first,itemId:'q2',slotId:'slot1'};
  const wrongPage = {...unknowable.body.crop_ref,page:2};
  const legacyBlocks = [unknowable, captureBlock('invalid-page',{...unknowable.body,crop_ref:wrongPage}),
    captureBlock('child-of-invalid',unknowable.body,0,'invalid-page')];
  const previous = await extract(key,legacyBlocks,photo,{settle(plan,receipts) {
    assert.equal(settleLayeredExtraction(plan,receipts).kind,'unknown');
    return {kind:'value',value:{basis:plan.basis,originals:photo,blocks:sourceBlocks(legacyBlocks,'paper-return',photo)}};
  }});
  const legacySource = await current(source);
  assert.deepEqual(clarificationRegions(legacySource,previous.outcome).map(region=>region.id),[unknowable.id]);
  assert.deepEqual(mergeLayeredSource(legacySource,previous.outcome).source.unit.blocks.map(block=>block.id),[unknowable.id]);
  assert.deepEqual((await layerView(first)).map(answer=>answer.witness.originalPage),[1]);
  const old = await reopen(first);
  const latest = await extract(key,[{...unknowable,body:{...unknowable.body,candidates:['4','9']}}],photo);
  const fresh = await reopen(first);
  assert.deepEqual([old.basis.derivationId,fresh.basis.derivationId],[previous.sealed.id,latest.sealed.id]);
  assert.deepEqual(old.source,fresh.source);
  await assert.rejects(send('capture.correctPaperAnswer',{...input,witness:old,text:'0.5'}),/抽取版本已变更/);
  await assert.rejects(send('capture.clarifyPaperAnswer',{...input,witness:fresh,runId:redo}),/作答见证与发卷/);
  await assert.rejects(send('capture.clarifyPaperAnswer',{...input,witness:fresh,extraction:'saved'}),/见证与抽取方式/);
  await assert.rejects(send('capture.correctPaperAnswer',{...input,witness:{...fresh,originalPage:2},text:'4'}),/作答位置已变更/);
  assert.equal((await current(source)).ref.rev,old.source.rev);
  assert.equal((await send('capture.correctPaperAnswer',{...input,witness:fresh,text:'4'})).wrote.length,1);
  assert.equal((await send('capture.clarifyPaperAnswer',{...input,runId:redo,witness:await reopen(redo)})).wrote.length,1);
  const ink = (id, left, right, top = 0.2, bottom = 0.26) => captureBlock(id, { layer:'handwriting', status:'known', text:'9',
    itemId:'q2', slotId:'slot1', crop_ref:{original:0,page:1,bbox:[left,top,right,bottom]} });
  const rerun = async (...blocks) => extract({...key,target:(await current(source)).ref},blocks,photo);
  const values = async runId => (await layerView(runId)).map(answer =>
    answer.value.status === 'known' ? answer.value.text : answer.value.region.clarification);
  for (const [id,left] of [['renamed',0.1],[unknowable.id,0.11],['renamed',0.11]]) {
    await rerun(ink(id,left,0.8));
    assert.deepEqual(await values(first),['4']);
    assert.deepEqual(await values(redo),['asked']);
  }
  await rerun(ink(unknowable.id,0.1,0.8,0.21,0.27),ink('next-line',0.1,0.8,0.25,0.31));
  assert.deepEqual(await values(first),['4','9']);
  assert.deepEqual(await values(redo),['asked','9']);
  assert.equal((await send('capture.clarifyPaperAnswer',{...input,runId:redo,witness:await reopen(redo)})).wrote.length,0);
  const otherSlot = ink('other-slot',0.1,0.8);
  await rerun({...otherSlot,body:{...otherSlot.body,slotId:'slot2'}});
  assert.deepEqual((await layerView(first)).map(answer=>[answer.slotId,answer.value.text]),[['slot1','4'],['slot2','9']]);
  await rerun(ink('upper',0.11,0.8),ink('neighbor',0.12,0.81),ink('independent',0.82,0.95));
  assert.deepEqual(await values(first),['4','pending','pending','9']);
  const conflict = (await layerView(first)).find(answer=>answer.witness.blockId==='neighbor');
  assert.equal((await send('capture.clarifyPaperAnswer',{...input,witness:conflict.witness})).wrote.length,1);

  console.log(JSON.stringify({checked:'paper witness pg',first,redo,old:old.basis,current:fresh.basis,invalidWrites:0,currentWrites:2}));
  console.log(JSON.stringify({checked:'capture pg',pages:projected.pages.length,returned:run.pages.length,stickyText:'0.5'}));
}
