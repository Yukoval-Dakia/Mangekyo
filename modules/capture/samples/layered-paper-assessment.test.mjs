import * as verification from '../../content/question-verification.ts';
import { bindQuestionExecution } from '../../content/question-effects.ts';
import { localVerificationExecution } from '../../content/samples/fixtures/question.ts';

export default async function ({
  learner, stableId, load, send, assert, current, gatherValue, publish, extract, confirmExtraction,
  captureBlock, ingestPhoto, jpeg, numericQuestion,
}) {
  const { clarificationRegions, openCapturedAssessment } = await load('modules/capture/extraction.ts');
  const sourceId = stableId('four-page-capture');
  const questionId = stableId('captured-distance-item');
  const currentSource = () => current(sourceId, 'teaching');
  const read = input => gatherValue(({ read }) => openCapturedAssessment(read, { sourceId, itemId: 'distance', ...input }));
  const originals = Array.from({ length: 4 }, (_, index) =>
    jpeg(`page-${index + 1}.jpg`, `fixture:${index}`, String(index + 1)));
  const block = (id, original, layer, data, parentId) => captureBlock(id, { layer, ...data }, original, parentId);
  const handwriting = { itemId:'distance', slotId:'answer' };
  const unknown = block('faint', 2, 'handwriting', { ...handwriting, status:'unknown', candidates:['30','36'] });
  const blocks = [
    block('material-1', 0, 'material', { status:'known', text:'第一段骑行速度为每小时 15 千米。' }),
    block('material-2', 1, 'material', { status:'known', text:'这段路一共用了 2 小时。' }, 'material-1'),
    block('prompt-1', 1, 'prompt', { status:'known', text:'按所给速度和时间计算。', itemId:'distance' }, 'material-2'),
    block('prompt-2', 2, 'prompt', { status:'known', text:'第一段骑行了多少千米？', itemId:'distance' }, 'prompt-1'),
    block('sibling-material', 1, 'material', { status: 'known', text: '第二段改为步行。' }, 'material-1'),
    block('second-prompt', 2, 'prompt', { status: 'known', text: '第二段步行了多久？', itemId: 'walking' }, 'sibling-material'),
    unknown,
    block('teacher', 3, 'correction', { ...handwriting, status:'known', text:'RED SECRET' }),
    block('teacher-child', 3, 'handwriting', { ...handwriting, status:'known', text:'RED CHILD SECRET' }, 'teacher'),
    block('school', 3, 'reference-answer', { status:'known', text:'SCHOOL SECRET' }),
    block('rubric', 3, 'rubric', { status:'known', text:'RUBRIC SECRET' }),
  ];
  await ingestPhoto(sourceId, '四页原件', originals);
  const { accessEpoch, ref } = await currentSource();
  const key = { target: ref, accessEpoch, modelMethod: 'fixture/layers', redInkMeaning: '红笔是事后订正' };
  const impossible = { ...unknown, body: { ...unknown.body, crop_ref: { ...unknown.body.crop_ref, page: 2 } } };
  const pageTwo = { ...impossible, body: { ...impossible.body, crop_ref: { ...impossible.body.crop_ref, original: 0 } } };
  const returned = { kind:'paper-return', occurredAt:null, recordedAt:null, retentionPolicy:'retained',
    originals:[originals[0]], unit:{kind:'capture', title:'第 2 页', blocks:[pageTwo]} };
  const id = stableId('capture original page validation');
  await assert.rejects(send('capture.ingest', {id, envelope:returned}), /单幅图片只支持/);
  await assert.rejects(confirmExtraction({ target:ref, blocks:[impossible] }), /单幅图片只支持/);
  assert.equal((await extract(key, [impossible], originals)).outcome.kind, 'unknown');
  const pdf = await send('capture.ingest', {id, purpose:['storage','teaching'], envelope:{...returned,
    originals:[{...originals[0], name:'paper.pdf', mediaType:'application/pdf'}]}});
  const pdfRegion = clarificationRegions(await current(id), null)[0];
  assert.equal(pdfRegion.page,2);
  assert.equal((await send('capture.clarifyExtraction',{target:pdf.wrote[0],blockId:pageTwo.id})).wrote.length,1);
  console.log(JSON.stringify({checked:'capture original crop page',jpegIngest:'rejected',jpegExtraction:'unknown',pdfPage:pdfRegion.page,pdfClarifyWrites:1}));
  const { sealed: extraction } = await extract(key, blocks, originals);
  const gap = (await read({ extraction:'layered' })).plan.data;
  assert.equal(gap.kind, 'question-gap');
  assert.deepEqual(gap.passages.map(({ blockId }) => blockId), ['material-1','material-2']);
  assert.doesNotMatch(JSON.stringify(gap), /SECRET|candidates|blobRef|第二段步行了多久/);

  const target = async () => (await currentSource()).ref;
  const confirmBlocks = (target, blocks) => confirmExtraction({ target, blocks });
  const invalid = block('invalid', 4, 'material', { status:'known', text:'未交原图' });
  await assert.rejects(confirmBlocks(ref, [invalid]), /内容块缺少原图/);
  await confirmBlocks(ref, blocks);
  const [region] = clarificationRegions(await currentSource(), null);
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
  assert.deepEqual(clarificationRegions(await currentSource(), null), []);

  const source = await currentSource();
  const materials = gap.passages.map(({ blockId }) => ({
    id:blockId, parentId:null, body:{kind:'sharedMaterial', source:{
      fact:source.ref, type:source.type, anchor:{kind:'block',blockId},
    }},
  }));
  const written = await send('content.saveQuestion', { id:questionId, purpose:'teaching', asset:{
    ...numericQuestion('骑行', gap.prompt, 'distance', 30, materials),
    basis: [{ id: sourceId, rev: source.ref.rev, epoch: source.accessEpoch, type: source.type }],
  } });
  const question = written.wrote.find(row => row.id === questionId);
  const slot = { learner, type: verification.questionVerificationType, key: verification.questionVerificationKey(question) };
  assert.deepEqual((await read({ questionId })).plan.targets, [{ kind: 'slot', ref: slot }]);
  const checked = await publish(slot.type, slot.key, 'content/question-verification', {
    plan: async ctx => {
      const plan = await verification.gather(ctx, question);
      // Bind distinct synthetic verifier identities before sealing the fixture plan.
      const effects = plan.effects.map((request, index) => bindQuestionExecution(request, localVerificationExecution((index + 1).toString(16))));
      return { ...plan, effects };
    },
    invoke: (request, invocation) => {
      assert.doesNotMatch(JSON.stringify(request.input), /SECRET|candidates|blobRef/);
      assert.equal(request.input.prompt, gap.prompt);
      return verification.questionVerificationEffectResult(invocation, {
        answerKey:'30 km', conditionKey:'constant speed for two hours', reasoning:'fixture receipt', eligible:true,
      }, request.input.execution);
    },
    settle: (sealed, receipts) => {
      const wrong = { ...receipts[1], result: { ...receipts[1].result, result: { answerKey:'36 km' } } };
      assert.equal(verification.settle(sealed, [receipts[0], wrong, ...receipts.slice(2)]).value.status, 'needs-review');
      return verification.settle(sealed, receipts);
    },
  });
  const observed = await read({ questionId, extraction:'layered' });
  const ready = observed.plan.data;
  assert.equal(ready.kind, 'ready');
  assert.deepEqual(ready.answers.map(({ id, body }) => [id, body.text, body.sticky, body.crop_ref.original]), [['faint','30',true,2]]);
  assert.deepEqual(source.value.originals, originals);
  assert.ok(observed.manifest.inputs.some(entry => entry.kind === 'slot' && entry.derivationId === checked.sealed.id));
  console.log(JSON.stringify({
    pages: originals.length, captureRev: source.ref.rev, extraction: extraction.id, verification: checked.sealed.id,
    questionSlot: slot.key, firstHandwriting: ready.answers[0].body.text, state: ready.kind,
  }));
}
