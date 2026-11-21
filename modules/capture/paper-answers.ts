import { derivationId, factId, FactNotFoundError, learnerId, type FactId, type FactWrite, type ReadContext } from '@mangekyo/kernel';
import { clarificationRegion, cropKey, firstAnswerBlocks, layeredExtractionSlot, mayExtract, mergeLayeredSource,
  type LayeredExtractionValue } from './extraction.ts';
import { paperInteger } from './paper-anchor.ts';
import { defaultPaperRunId, openIssuedPaper, paperRun, paperRunType } from './paper.ts';
import { captureObject as object, captureRef, captureText as text, sha256 } from './parse.ts';
import { captureSourceType, sourceEnvelope, validSourceCropPage, type Block } from './source.ts';

type PaperRunRequest = {
  readonly issuanceId: FactId;
  readonly runId?: FactId;
  readonly extraction?: 'saved' | 'layered';
};

type CollectedPage = ReturnType<typeof paperRun>['pages'][number];
type QuestionAnchor = Awaited<ReturnType<typeof openIssuedPaper>>['questionAnchors'][number];

async function openRun(read: ReadContext, request: PaperRunRequest, allowUnsubmitted = false) {
  const id = request.runId ?? await defaultPaperRunId(request.issuanceId);
  const fact = await read.fact(id, { mode: 'following' }).catch(error => {
    if (allowUnsubmitted && request.runId === undefined && error instanceof FactNotFoundError) return null;
    throw error;
  });
  if (fact && fact.type !== paperRunType) throw new Error('找不到纸卷作答。');
  const run = fact ? paperRun(fact.value) : { issuanceId: request.issuanceId, pages: [] };
  if (run.issuanceId !== request.issuanceId) throw new Error('回收与发卷不匹配。');
  const printed = await openIssuedPaper(read, run.issuanceId);
  return { id, run, printed };
}

async function openPage(read: ReadContext, page: CollectedPage, runId: FactId,
  questions: readonly QuestionAnchor[], extraction: PaperRunRequest['extraction']) {
  const fact = await read.fact(page.source.id, { mode: 'following' });
  if (fact.type !== captureSourceType || fact.ref.rev < page.source.rev) throw new Error('回收原件版本不符。');
  const source = sourceEnvelope(fact.value);
  if (source.kind !== 'paper-return' || source.originals[page.original]?.sha256 !== page.hash)
    throw new Error('回收原图已变更。');

  const blocks = new Map<string, Block>();
  const slot = { learner: fact.ref.learner, type: layeredExtractionSlot, key: fact.ref.id };
  const snapshot = extraction === 'layered' && mayExtract(fact)
    ? await read.slot<LayeredExtractionValue>(slot, { mode: 'following' }) : null;
  if (snapshot && (snapshot.slot.learner !== slot.learner || snapshot.slot.type !== slot.type || snapshot.slot.key !== slot.key))
    throw new Error('分层抽取与回收原件不匹配。');
  const basis = snapshot ? { mode: 'layered' as const, derivationId: snapshot.id } : { mode: 'saved' as const, derivationId: null };
  if (!mayExtract(fact)) return { fact, source, blocks, basis };
  const allowed = new Set(questions.filter(question => question.pages.includes(page.number)).map(question => question.itemId));
  function accept(block: Block) {
    const crop = block.body.crop_ref;
    return crop?.original === page.original && validSourceCropPage(crop, source.originals) && block.body.itemId &&
      allowed.has(block.body.itemId) && block.body.slotId;
  }
  const extracted = mergeLayeredSource(fact, snapshot?.outcome ?? null).source.unit.blocks;
  for (const block of firstAnswerBlocks(extracted)) {
    if (!accept(block)) continue;
    const key = cropKey(block)!;
    const prior = blocks.get(key);
    // Conflicting OCR assignments for the same ink need a new extraction.
    if (prior && (prior.body.itemId !== block.body.itemId || prior.body.slotId !== block.body.slotId))
      throw new Error('同一手写区域识别出冲突题位。');
    if (!prior || prior.body.status === 'known' && block.body.status === 'unknown') blocks.set(key, block);
  }
  const edits = (source.paperAnswerEdits ?? []).filter(edit => edit.runId === runId && accept(edit.block));
  // A retained edit keeps its region when extraction renames a block or moves
  // its box under the same block ID on the same original page.
  const location = (block: Block) => JSON.stringify([block.id, block.body.crop_ref!.page]);
  const retained = new Set(edits.map(edit => location(edit.block)));
  for (const [key, block] of blocks) {
    if (retained.has(location(block))) blocks.delete(key);
  }
  for (const { block } of edits) blocks.set(cropKey(block)!, block);
  return { fact, source, blocks, basis };
}

/**
 * Read through the recipient-authorized context. Recognition uses the exact itemId
 * from the printed question anchor. Pass an answer's witness to the clarification
 * or correction command unchanged. The command reopens the same read mode in
 * its transaction. For layered mode, both readers need authorized slot access.
 */
export async function openPaperRun(read: ReadContext, request: PaperRunRequest) {
  const { id, run, printed } = await openRun(read, request, true);
  const opened: { page: number; opened: Awaited<ReturnType<typeof openPage>> }[] = [];
  for (const page of run.pages.toSorted((left, right) => left.number - right.number)) {
    opened.push({ page: page.number, opened: await openPage(read, page, id, printed.questionAnchors, request.extraction) });
  }
  const items = printed.questionAnchors.map(question => {
    const answers = opened.flatMap(({ page, opened: { fact, source, blocks, basis } }) =>
      [...blocks].flatMap(([regionKey, block]) => {
        const { body } = block;
        if (body.itemId !== question.itemId) return [];
        const witness = { issuanceId: run.issuanceId, runId: id, itemId: question.itemId, slotId: body.slotId!, basis,
          page, original: body.crop_ref!.original, originalPage: body.crop_ref!.page, blockId: block.id,
          source: fact.ref, accessEpoch: fact.accessEpoch, regionKey,
          originalSha256: source.originals[body.crop_ref!.original]!.sha256 };
        return [{ slotId: body.slotId!, witness, value: body.status === 'unknown'
          ? { status: 'waiting' as const, region: clarificationRegion(fact, source, { id: block.id, body }) }
          : { status: 'known' as const, text: body.text, sticky: body.sticky === true } }];
      }));
    const missingPages = question.pages.filter(number => !opened.some(page => page.page === number));
    const status = missingPages.length ? 'unsubmitted' :
      answers.some(answer => answer.value.status === 'waiting') ? 'waiting' :
      answers.some(answer => answer.value.status === 'known' && answer.value.text.trim()) ? 'recognized' : 'unsubmitted';
    return { ...question, missingPages, status, answers };
  });
  return { runId: id, issuanceId: run.issuanceId, items };
}

export function paperAnswerInput(input: unknown) {
  const row = object(input);
  const witness = object(row.witness);
  const { extraction } = row;
  if (extraction !== undefined && extraction !== 'saved' && extraction !== 'layered')
    throw new Error('纸卷抽取方式无效。');
  const basis = object(witness.basis);
  const mode = basis.mode;
  if ((mode !== 'saved' && mode !== 'layered') || (mode === 'saved' && basis.derivationId !== null) ||
      (extraction !== undefined && extraction !== mode)) throw new Error('作答见证与抽取方式不符。');
  const context = paperAnswerContext(row);
  return {
    ...context,
    witness: {
      ...paperAnswerContext(witness),
      basis: { mode, derivationId: mode === 'layered' ? derivationId(text(basis.derivationId, '抽取版本', 26)) : null } as const,
      page: paperInteger(witness.page, 1, 1_000_000, '回收页码'),
      original: paperInteger(witness.original, 0, 1_000_000, '回收图片位置'),
      originalPage: paperInteger(witness.originalPage, 1, Number.MAX_SAFE_INTEGER, '原图页码'),
      blockId: text(witness.blockId, '手写块标识', 200),
      source: { ...captureRef(witness.source), learner: learnerId(text(object(witness.source).learner, '原件归属', 26)) },
      accessEpoch: text(witness.accessEpoch, '原件授权版本', 100),
      originalSha256: sha256(witness.originalSha256),
      regionKey: text(witness.regionKey, '手写区域', 500),
    },
  };
}

function paperAnswerContext(row: Record<string, unknown>) {
  return { issuanceId: factId(text(row.issuanceId, '发卷标识', 26)),
    runId: factId(text(row.runId, '作答标识', 26)),
    itemId: text(row.itemId, '固定题位', 200),
    slotId: text(row.slotId, '作答位', 200) };
}

export async function paperAnswerWrites(read: ReadContext, input: ReturnType<typeof paperAnswerInput>,
  correction?: string): Promise<readonly FactWrite[]> {
  const { witness, itemId, slotId } = input;
  if (witness.issuanceId !== input.issuanceId || witness.runId !== input.runId ||
      witness.itemId !== itemId || witness.slotId !== slotId)
    throw new Error('作答见证与发卷、作答或题位不符。');
  const { id, run, printed } = await openRun(read, input);
  const page = run.pages.find(page => page.number === witness.page);
  if (!page || page.source.id !== witness.source.id || page.hash !== witness.originalSha256 || page.original !== witness.original)
    throw new Error('已回收页与原图见证不符。');
  const { fact, source, blocks, basis } = await openPage(read, page, id, printed.questionAnchors, witness.basis.mode);
  if (basis.mode !== witness.basis.mode || basis.derivationId !== witness.basis.derivationId)
    throw new Error('纸卷抽取版本已变更，请重新打开作答。');
  const block = blocks.get(witness.regionKey);
  if (!block || block.id !== witness.blockId || block.body.crop_ref?.page !== witness.originalPage ||
      block.body.itemId !== itemId || block.body.slotId !== slotId || fact.ref.learner !== witness.source.learner ||
      fact.accessEpoch !== witness.accessEpoch || witness.source.rev < page.source.rev)
    throw new Error('原件授权或纸卷作答位置已变更。');
  const { body } = block;
  if (correction === undefined && (body.status === 'known' || body.clarification === 'asked')) return [];
  if (fact.ref.rev !== witness.source.rev) throw new Error('原件版本已变更。');
  const edit: Block = { id: block.id, parentId: null, body: correction === undefined && body.status === 'unknown'
    ? { ...body, clarification: 'asked' }
    : { kind: 'capture', layer: 'handwriting', itemId, slotId, crop_ref: body.crop_ref!,
      status: 'known', text: correction!, sticky: true, author: 'learner' } };
  const prior = (source.paperAnswerEdits ?? []).filter(entry => entry.runId !== id || cropKey(entry.block) !== witness.regionKey);
  return [{ kind: 'correct', id: fact.ref.id, expectedRev: fact.ref.rev,
    data: { ...source, paperAnswerEdits: [...prior, { runId: id, block: edit }] } }];
}
