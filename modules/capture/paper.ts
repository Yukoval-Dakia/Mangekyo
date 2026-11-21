import {
  derivationId, factId, FactNotFoundError, type DerivationId, type DerivationSnapshot, type FactId, type FactSnapshot, type FactWrite,
  type LearnerId, type ReadContext,
} from '@mangekyo/kernel';
import { assetType, checkQuestionTeachingSources, checkTextbookBasis, parseTextbookPage, questionAsset, questionPrompt, textbookPageType,
  type AssetReference } from '@mangekyo/module-content/facts/asset-contract';
import { openQuestionForRelease, questionVerificationType } from '@mangekyo/module-content/facts/question-release';
import { captureObject as object, captureRef, captureText as text, sha256 } from './parse.ts';
import { captureSourceType, sourceEnvelope, type Block } from './source.ts';
import { layeredExtractionDeriver, layeredExtractionSlot, mergeLayeredSource, type LayeredExtractionValue } from './extraction.ts';

export const paperIssuanceType = 'capture.paperIssuance';
export const paperRunType = 'capture.paperRun';

type SourceRef = ReturnType<typeof captureRef>;
type PrintPiece = { readonly blockId: string; readonly itemId: string | null; readonly text: string };
type PrintPage = { readonly number: number; readonly pieces: readonly PrintPiece[] };

function integer(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${label}无效。`);
  return value;
}

export function printLayout(input: unknown) {
  const { lines, columns } = object(input);
  return { lines: integer(lines, 10, 120, '每页行数'), columns: integer(columns, 16, 240, '每行字符数') };
}

type ExtractionPin = {
  readonly derivationId: DerivationId;
  readonly sourceRev: number;
  readonly modelMethod: string;
};

export type PaperIssuance = {
  readonly source: SourceRef;
  readonly epoch: string;
  readonly layout: ReturnType<typeof printLayout>;
  readonly extraction?: ExtractionPin;
};

export function paperIssuance(input: unknown): PaperIssuance {
  const { source: target, epoch, layout, extraction } = object(input);
  if (typeof epoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(epoch)) throw new Error('发卷授权版本无效。');
  const source = captureRef(target);
  const base = { source, epoch, layout: printLayout(layout) };
  if (extraction === undefined) return base;
  const pin = object(extraction);
  return { ...base, extraction: {
    derivationId: derivationId(text(pin.derivationId, '抽取标识', 26)),
    sourceRev: integer(pin.sourceRev, 1, source.rev, '抽取原件版本'),
    modelMethod: text(pin.modelMethod, '识别方法版本', 200),
  } };
}

type ExtractionRequest = Pick<PaperIssuance, 'source' | 'epoch'> & {
  readonly learner: LearnerId;
  readonly extraction: ExtractionPin;
};

/**
 * The runtime must bind this reader to the same authorized snapshot as the
 * source read, under the learner lock for a write. It selects the exact ID,
 * rejects shadow and invalidated results, and revalidates both the manifest's
 * purpose and the caller's purpose. Current requires the effective slot head.
 * Pinned also allows a superseded result with a still-authorized manifest.
 */
export type PaperExtractionReader = (request: ExtractionRequest, mode: 'current' | 'pinned') => Promise<{
  readonly deriver: string;
  readonly snapshot: DerivationSnapshot<LayeredExtractionValue>;
  readonly manifest: { readonly learner: LearnerId; readonly inputs: readonly unknown[] };
}>;

const paperExtraction = Symbol.for('@mangekyo/module-capture/paper.extraction-reader');
type BoundPaperRead = ReadContext & { readonly [paperExtraction]?: PaperExtractionReader };

export function bindPaperCommandRead(
  base: ReadContext, {
    readExtraction,
    readQuestionSlot,
  }: { readonly readExtraction?: PaperExtractionReader; readonly readQuestionSlot?: ReadContext['slot'] },
): ReadContext {
  const read: BoundPaperRead = {
    fact: base.fact.bind(base),
    range: base.range.bind(base),
    slot: (ref, options) => readQuestionSlot && ref.type === questionVerificationType && options.mode === 'following'
      ? readQuestionSlot(ref, options) : base.slot(ref, options),
    ...(readExtraction ? { [paperExtraction]: readExtraction } : {}),
  };
  return read;
}

async function idFromDefinition(data: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)));
  return factId([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 26).toUpperCase());
}

export function paperIssuanceId(data: PaperIssuance) {
  const base = ['capture.paper', data.source.id, data.source.rev, data.epoch, data.layout.lines, data.layout.columns];
  const pin = data.extraction;
  return idFromDefinition(pin ? [...base, pin.derivationId, pin.sourceRev, pin.modelMethod] : base);
}

export function defaultPaperRunId(issuanceId: string) {
  return idFromDefinition(['capture.paperRun', factId(issuanceId)]);
}

function cleanBlocks(blocks: readonly Block[]) {
  const permitted = new Set<string>();
  const pieces: PrintPiece[] = [];
  for (const { id, parentId, body } of blocks) {
    if ((body.layer !== 'material' && body.layer !== 'prompt') || (parentId !== null && !permitted.has(parentId))) continue;
    if (body.status === 'unknown') throw new Error('请先澄清卷面题干或材料。');
    if (body.layer === 'prompt' && !body.itemId) throw new Error('题干缺少题位。');
    permitted.add(id);
    pieces.push({ blockId: id, itemId: body.layer === 'prompt' ? body.itemId! : null, text: body.text });
  }
  if (!pieces.some(piece => piece.itemId !== null)) throw new Error('没有可打印的题目。');
  return pieces;
}

// This is the display payload. It contains no source blob handles or grading
// fields. The renderer adds printed page/position markers outside the text.
function paginate(pieces: readonly PrintPiece[], { lines, columns }: PaperIssuance['layout']): readonly PrintPage[] {
  const pages: { number: number; pieces: PrintPiece[] }[] = [{ number: 1, pieces: [] }];
  let page = pages[0]!;
  let used = 0;
  for (const piece of pieces) {
    let chunk = '';
    let width = 0;
    for (const character of piece.text) {
      chunk += character;
      const advance = character.codePointAt(0)! > 255 ? 2 : 1;
      width += advance;
      if (character === '\n' || width >= columns) {
        page.pieces.push({ ...piece, text: chunk });
        chunk = '';
        width = 0;
        used++;
        if (used === lines) {
          page = { number: pages.length + 1, pieces: [] };
          pages.push(page);
          used = 0;
        }
      }
    }
    if (chunk || !piece.text) {
      page.pieces.push({ ...piece, text: chunk });
      used++;
      if (used === lines) {
        page = { number: pages.length + 1, pieces: [] };
        pages.push(page);
        used = 0;
      }
    }
  }
  return pages.filter(page => page.pieces.length > 0);
}

async function openPrintReference(read: ReadContext, reference: AssetReference, learner: FactSnapshot['ref']['learner']) {
  const { id, rev } = reference.fact;
  const fact = await read.fact(id, { mode: 'pinned', rev });
  if (reference.fact.learner !== learner || fact.ref.learner !== learner || fact.type !== reference.type ||
      fact.ref.id !== id || fact.ref.rev !== rev)
    throw new Error('引用的卷面内容类型或归属不符。');
  return fact;
}

type QuestionUse = 'practice' | 'diagnose';

async function verifyTeachingSource(read: ReadContext, pinned: FactSnapshot) {
  const current = await read.fact(pinned.ref.id, { mode: 'following' });
  if (current.type !== pinned.type || current.ref.id !== pinned.ref.id || current.ref.learner !== pinned.ref.learner ||
      ![pinned, current].every(fact => fact.purpose.includes('teaching') || fact.purpose.includes('all')))
    throw new Error('题目或来源未授权教学用途。');
}

async function authorizedPrintQuestion(read: ReadContext, fact: FactSnapshot, releaseUse: QuestionUse | null) {
  if (fact.type !== assetType) throw new Error('题目引用类型无效。');
  const question = questionAsset(fact.value);
  if (releaseUse) {
    const released = await openQuestionForRelease(read, fact.ref.id, ['print', releaseUse]);
    if (released.ref.id !== fact.ref.id || released.ref.learner !== fact.ref.learner || released.ref.rev !== fact.ref.rev)
      throw new Error('题库当前版本与卷面引用不符。');
  } else {
    await verifyTeachingSource(read, fact);
    await checkQuestionTeachingSources(read, question);
  }
  return question;
}

async function cleanQuestion(
  read: ReadContext, fact: FactSnapshot, itemId: string, releaseUse: QuestionUse | null,
): Promise<readonly PrintPiece[]> {
  const question = await authorizedPrintQuestion(read, fact, releaseUse);
  const pieces: PrintPiece[] = [];
  for (const { body, id } of question.blocks) {
    if (body.kind !== 'sharedMaterial') continue;
    const source = await openPrintReference(read, body.source, fact.ref.learner);
    if (source.type !== captureSourceType) throw new Error('共享打印材料须指向已分层原件。');
    await verifyTeachingSource(read, source);
    const anchor = body.source.anchor;
    if (anchor.kind === 'path') throw new Error('共享打印材料须指向材料块或完整原件。');
    const permitted = new Set<string>();
    const materials: PrintPiece[] = [];
    for (const block of sourceEnvelope(source.value).unit.blocks) {
      const { body, parentId } = block;
      if (body.layer !== 'material' || (parentId !== null && !permitted.has(parentId))) continue;
      permitted.add(block.id);
      if (anchor.kind === 'block' && block.id !== anchor.blockId) continue;
      if (body.status !== 'known') throw new Error('请先澄清共享打印材料。');
      materials.push({ blockId: `${itemId}.${id}.${block.id}`, itemId: null, text: body.text });
    }
    if (!materials.length) throw new Error('找不到共享打印材料。');
    pieces.push(...materials);
  }
  pieces.push({ blockId: `${itemId}.${question.promptBlockId}`, itemId, text: questionPrompt(question) });
  return pieces;
}

async function frozenPrintParts(read: ReadContext, fact: FactSnapshot, preview: boolean): Promise<{ title: string; pieces: readonly PrintPiece[] }> {
  if (fact.type === captureSourceType) {
    const source = sourceEnvelope(fact.value);
    if (source.kind !== 'photo' && source.kind !== 'pdf') throw new Error('原件没有可打印卷面。');
    return { title: source.unit.title, pieces: cleanBlocks(source.unit.blocks) };
  }
  if (fact.type === assetType) {
    const question = questionAsset(fact.value);
    return { title: question.title, pieces: await cleanQuestion(read, fact, 'q1', preview ? 'practice' : null) };
  }
  if (fact.type === textbookPageType) {
    const page = parseTextbookPage(fact.value);
    await checkTextbookBasis(read, page.basis ?? []);
    const pieces: PrintPiece[] = [];
    for (const { id, body } of page.blocks) {
      if (body.kind !== 'reference' || body.role !== 'question' || body.presentation !== 'embed') continue;
      pieces.push(...await cleanQuestion(read, await openPrintReference(read, body.target, fact.ref.learner), id, preview ? 'practice' : null));
    }
    if (!pieces.length) throw new Error('教材页没有可打印的嵌入题目。');
    return { title: page.title, pieces };
  }
  if (fact.type === 'activity.retentionPosttest') {
    const issued = object(fact.value);
    const ref = captureRef(issued.paper);
    const paper = await read.fact(ref.id, { mode: 'pinned', rev: ref.rev });
    if (paper.type !== 'activity.retentionPaper' || paper.accessEpoch !== issued.paperEpoch) throw new Error('后测冻结卷授权已变更。');
    return workbookPrintParts(read, paper, preview ? 'diagnose' : null, text(issued.itemId, '后测发放题位', 200));
  }
  if (fact.type !== 'activity.workbookPaper' && fact.type !== 'activity.retentionPaper') throw new Error('没有可打印的冻结卷。');
  return workbookPrintParts(read, fact, preview ? (fact.type === 'activity.retentionPaper' ? 'diagnose' : 'practice') : null);
}

async function workbookPrintParts(read: ReadContext, fact: FactSnapshot, releaseUse: QuestionUse | null, issuedItemId?: string) {
  // Activity owns this persisted frozen paper. Pick only its learner-visible
  // fields and reopen any pinned question dependencies under the same purpose.
  const paper = object(fact.value);
  if (!Array.isArray(paper.questions) || !paper.questions.length) throw new Error('冻结卷没有题目。');
  const releaseItems = paper.assessmentRelease === undefined ? [] : object(paper.assessmentRelease).items;
  if (!Array.isArray(releaseItems)) throw new Error('冻结卷的评估题项无效。');
  const assessments = new Map(releaseItems.map(input => {
    const item = object(input);
    return [item.itemId, item];
  }));
  const pieces: PrintPiece[] = [];
  const seen = new Set<string>();
  for (const input of paper.questions) {
    const question = object(input);
    const itemId = text(question.id, '题位', 200);
    if (seen.has(itemId)) throw new Error('冻结卷题位重复。');
    seen.add(itemId);
    if (issuedItemId !== undefined && itemId !== issuedItemId) continue;
    const storedPrompt = text(question.prompt, '冻结题面', 2_000_000);
    const sourceRef = question.sourceQuestionRef == null ? undefined : captureRef(question.sourceQuestionRef);
    const assessmentPrompt = assessments.get(itemId)?.promptRef;
    const promptRef = assessmentPrompt === undefined ? undefined : captureRef(assessmentPrompt);
    // Inline assessment prompts may refer to the frozen workbook itself. Other
    // addresses are independent sources, even when only the contract names them.
    const refs = sourceRef ? [sourceRef] : [];
    if (promptRef && promptRef.id !== fact.ref.id && (promptRef.id !== sourceRef?.id || promptRef.rev !== sourceRef?.rev)) refs.push(promptRef);
    for (const ref of refs) {
      const source = await openWorkbookQuestionSource(read, fact, ref);
      if (ref === sourceRef && question.sourceAccessEpoch !== undefined && source.accessEpoch !== question.sourceAccessEpoch)
        throw new Error('来源题目权限已变更。');
      if (source.type === assetType && object(source.value).kind === 'question') {
        pieces.push(...await workbookQuestionMaterials(read, source, itemId, storedPrompt, releaseUse));
        continue;
      }
      if (source.type === 'activity.workspaceEntry') {
        await checkFrozenWorkspaceBasis(read, source, releaseUse);
        const entry = object(source.value);
        if (entry.kind === 'question' && entry.body === storedPrompt) continue;
        if (entry.kind === 'question' || ref === sourceRef) throw new Error('来源题目与冻结题面不符。');
      } else {
        if (ref === sourceRef) throw new Error('来源题目类型不符。');
        await verifyTeachingSource(read, source);
      }
    }
    pieces.push({ blockId: itemId, itemId, text: storedPrompt });
  }
  if (!pieces.length) throw new Error('后测发放题位与冻结卷不符。');
  return { title: text(paper.title, '冻结卷标题', 240), pieces };
}

// Activity checked the frozen item against this legacy question on save. Its
// provenance can include other workspace entries and pinned IQDB questions.
async function checkFrozenWorkspaceBasis(read: ReadContext, root: FactSnapshot, releaseUse: QuestionUse | null) {
  const checked = new Set<string>();
  const visiting = new Set<string>();
  async function visit(source: FactSnapshot) {
    const key = `${source.ref.id}:${source.ref.rev}`;
    if (checked.has(key)) return;
    await verifyTeachingSource(read, source);
    if (source.type === 'activity.workspaceEntry') {
      if (visiting.has(source.ref.id)) throw new Error('工作区来源依据形成循环。');
      const { basis } = object(source.value);
      if (!Array.isArray(basis)) throw new Error('冻结工作区题目缺少来源依据。');
      visiting.add(source.ref.id);
      for (const use of basis) {
        const opened = await openWorkbookQuestionSource(read, root, captureRef(use));
        if (opened.accessEpoch !== object(use).epoch) throw new Error('冻结工作区题目的来源权限已变更。');
        await visit(opened);
      }
      visiting.delete(source.ref.id);
    } else if (source.type === assetType && object(source.value).kind === 'question') {
      await authorizedPrintQuestion(read, source, releaseUse);
    }
    checked.add(key);
  }
  await visit(root);
}

async function openWorkbookQuestionSource(read: ReadContext, workbook: FactSnapshot, ref: SourceRef) {
  const source = await read.fact(ref.id, { mode: 'pinned', rev: ref.rev });
  if (source.ref.learner !== workbook.ref.learner || source.ref.id !== ref.id || source.ref.rev !== ref.rev)
    throw new Error('来源题目版本或权限已变更。');
  return source;
}

async function workbookQuestionMaterials(
  read: ReadContext, fact: FactSnapshot, itemId: string, prompt: string, releaseUse: QuestionUse | null,
) {
  const pieces = await cleanQuestion(read, fact, itemId, releaseUse);
  const question = pieces.find(piece => piece.itemId === itemId);
  if (question?.text !== prompt) throw new Error('来源题目与冻结题面不符。');
  return pieces.filter(piece => piece.itemId === null);
}

async function frozenExtractionParts(fact: FactSnapshot, issuance: PaperIssuance, mode: 'current' | 'pinned', readExtraction?: PaperExtractionReader) {
  const pin = issuance.extraction;
  if (!pin || !readExtraction) throw new Error('分层发卷需要经过授权的抽取读入口。');
  if (fact.type !== captureSourceType) throw new Error('分层发卷须使用卷面原件。');
  const source = sourceEnvelope(fact.value);
  if (source.kind !== 'photo' && source.kind !== 'pdf') throw new Error('原件没有可打印卷面。');
  const { learner, id, rev } = fact.ref;
  if (id !== issuance.source.id || rev !== issuance.source.rev) throw new Error('分层发卷原件版本不符。');
  const { deriver, snapshot, manifest } = await readExtraction({ learner, source: issuance.source, epoch: issuance.epoch, extraction: pin }, mode);
  if (deriver !== layeredExtractionDeriver || snapshot.id !== pin.derivationId ||
      snapshot.slot.learner !== learner || snapshot.slot.type !== layeredExtractionSlot || snapshot.slot.key !== id ||
      manifest.learner !== learner || snapshot.outcome.kind !== 'value')
    throw new Error('分层抽取未获准用于此卷。');
  const pinnedSource = manifest.inputs.some(input => {
    const witness = object(input);
    return witness.kind === 'fact' && witness.mode === 'pinned' && witness.id === id &&
      witness.rev === pin.sourceRev && witness.accessEpoch === issuance.epoch;
  });
  const { basis, originals } = snapshot.outcome.value;
  if (!pinnedSource || basis.learner !== learner || basis.target.id !== id || basis.target.rev !== pin.sourceRev ||
      basis.accessEpoch !== issuance.epoch || basis.modelMethod !== pin.modelMethod ||
      originals.length !== source.originals.length || source.originals.some((original, i) => {
        const extracted = originals[i];
        return !extracted || original.blobRef !== extracted.blobRef || original.sha256 !== extracted.sha256 ||
          original.size !== extracted.size || original.mediaType !== extracted.mediaType || original.name !== extracted.name;
      })) throw new Error('分层抽取的原件、授权或识别方法不符。');
  const merged = mergeLayeredSource(fact, snapshot.outcome).source;
  return { title: merged.unit.title, pieces: cleanBlocks(merged.unit.blocks) };
}

async function projectPaper(
  read: ReadContext, issuance: PaperIssuance, mode: 'current' | 'pinned',
  readExtraction = (read as BoundPaperRead)[paperExtraction],
) {
  const fact = await read.fact(issuance.source.id, { mode: 'pinned', rev: issuance.source.rev });
  if (fact.accessEpoch !== issuance.epoch || fact.ref.id !== issuance.source.id || fact.ref.rev !== issuance.source.rev)
    throw new Error('原件发放版本或用途已变更。');
  const { title, pieces } = issuance.extraction
    ? await frozenExtractionParts(fact, issuance, mode, readExtraction)
    : await frozenPrintParts(read, fact, mode === 'current');
  return { issuanceId: await paperIssuanceId(issuance), title, pages: paginate(pieces, issuance.layout) };
}

async function checkedPaperIssuance(fact: FactSnapshot, id: ReturnType<typeof factId>) {
  if (fact.type !== paperIssuanceType || fact.ref.id !== id) throw new Error('发卷标识已被使用。');
  const data = paperIssuance(fact.value);
  if (await paperIssuanceId(data) !== id) throw new Error('发卷标识与冻结卷不符。');
  return data;
}

async function storedPaperIssuance(read: ReadContext, id: ReturnType<typeof factId>) {
  let fact: FactSnapshot;
  try {
    fact = await read.fact(id, { mode: 'following' });
  } catch (error) {
    if (error instanceof FactNotFoundError) return null;
    throw error;
  }
  return checkedPaperIssuance(fact, id);
}

/** Evaluate a new release even when the same source and layout were issued before. */
export function projectNewPaper(read: ReadContext, issuance: PaperIssuance) {
  return projectPaper(read, issuance, 'current');
}

export async function projectIssuedPaper(read: ReadContext, issuance: PaperIssuance, readExtraction?: PaperExtractionReader) {
  const stored = await storedPaperIssuance(read, await paperIssuanceId(issuance));
  return stored ? projectPaper(read, stored, 'pinned', readExtraction) : projectPaper(read, issuance, 'current', readExtraction);
}

export async function issuePaperWrites(read: ReadContext, data: PaperIssuance, readExtraction?: PaperExtractionReader): Promise<readonly FactWrite[]> {
  const id = await paperIssuanceId(data);
  const stored = await storedPaperIssuance(read, id);
  if (stored) {
    await projectPaper(read, stored, 'pinned', readExtraction);
    return [];
  }
  await projectPaper(read, data, 'current', readExtraction);
  return [{ kind: 'create', id, factType: paperIssuanceType, data, purpose: ['storage'] }];
}

function paperPage(input: unknown) {
  const { number, source, original, hash } = object(input);
  return {
    number: integer(number, 1, 1_000_000, '回收页码'),
    source: captureRef(source),
    original: integer(original, 0, 1_000_000, '回收图片位置'),
    hash: sha256(hash),
  };
}

export function paperRun(input: unknown) {
  const { issuanceId, pages } = object(input);
  if (!Array.isArray(pages)) throw new Error('回收页无效。');
  const returned = pages.map(paperPage);
  if (new Set(returned.map(page => page.number)).size !== returned.length ||
      new Set(returned.map(page => page.hash)).size !== returned.length)
    throw new Error('回收页码或图片重复。');
  return { issuanceId: factId(text(issuanceId, '发卷标识', 26)), pages: returned };
}

export function collectPaperInput(input: unknown) {
  const row = object(input);
  return {
    issuanceId: factId(text(row.issuanceId, '发卷标识', 26)),
    source: captureRef(row.source),
    page: row.page,
    original: row.original,
    ...(row.retryId === undefined ? {} : { retryId: factId(text(row.retryId, '再做标识', 26)) }),
  };
}

export function paperReturnSelection(input: {issuanceId: unknown; page: unknown; purpose: unknown; retryId?: unknown}, id: FactId) {
  const selected = typeof input.page === 'string' && /^\d+$/.test(input.page) ? Number(input.page) : null;
  const {page, original: _, ...refs} = collectPaperInput({...input,page:selected,source:{id,rev:1},original:0});
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 ||
      (input.purpose !== 'storage' && input.purpose !== 'learning' && input.purpose !== 'teaching' && input.purpose !== 'background-research'))
    throw new Error('请选择发放页码和原件用途。');
  return {...refs,page,original:0,purpose:input.purpose};
}

export function validPaperReturnIndices(page: unknown, original: unknown) {
  return typeof page === 'number' && Number.isSafeInteger(page) && page >= 1 &&
    typeof original === 'number' && Number.isSafeInteger(original) && original >= 0;
}

export function paperReturnView(id: FactId, rev: number, captured: ReturnType<typeof sourceEnvelope>) {
  return { title: captured.unit.title, source: { id, rev },
    originals: captured.originals.map(({ name }, index) => ({ name, index })) };
}

export function paperCollectionReceipt(data: ReturnType<typeof collectPaperInput>, runId: FactId, rev: number) {
  return { issuanceId: data.issuanceId, runId, rev, page: data.page, independence: 'unknown' as const };
}

export function readPaperReprintInput(body: Record<string, unknown>) {
  if (Object.keys(body).length !== 1 || typeof body.issuanceId !== 'string') throw new Error('请选择已发放的纸卷。');
  return factId(body.issuanceId);
}

export function readPaperDisplayInput(body: Record<string, unknown>) {
  if (Object.keys(body).length !== 2 || typeof body.issuanceId !== 'string' || typeof body.permit !== 'string')
    throw new Error('显示回执格式无效。');
  return [factId(body.issuanceId), factId(body.permit)] as const;
}

export async function collectPaperWrites(
  read: ReadContext, { issuanceId, source, page, original, retryId }: ReturnType<typeof collectPaperInput>,
  readExtraction?: PaperExtractionReader,
): Promise<readonly FactWrite[]> {
  const issuance = await read.fact(issuanceId, { mode: 'following' });
  const printed = await projectPaper(read, await checkedPaperIssuance(issuance, issuanceId), 'pinned', readExtraction);
  const fact = await read.fact(source.id, { mode: 'pinned', rev: source.rev });
  if (fact.type !== captureSourceType) throw new Error('回收图片必须来自原件。');
  const captured = sourceEnvelope(fact.value);
  if (captured.kind !== 'paper-return' || !printed.pages.some(p => p.number === page) ||
      typeof original !== 'number' || !Number.isSafeInteger(original) || original < 0 || !captured.originals[original])
    throw new Error('回收图片或页码无效。');
  const hash = captured.originals[original].sha256;
  const entry = { number: page, source, original, hash };
  const defaultId = await defaultPaperRunId(issuanceId);
  if (retryId === defaultId) throw new Error('再做须使用新的标识。');
  const id = retryId ?? defaultId;
  let run: FactSnapshot;
  try {
    run = await read.fact(id, { mode: 'following' });
  } catch (error) {
    if (!(error instanceof FactNotFoundError)) throw error;
    return [{ kind: 'create', id, factType: paperRunType, data: paperRun({ issuanceId, pages: [entry] }), purpose: ['storage'] }];
  }
  if (run.type !== paperRunType) throw new Error('回收标识已被使用。');
  const prior = paperRun(run.value);
  if (prior.issuanceId !== issuanceId) throw new Error('回收与发卷不匹配。');
  const priorPage = prior.pages.find(p => p.number === page || p.hash === hash);
  if (priorPage?.hash === hash && priorPage.number === page) return [];
  if (priorPage) throw new Error('回收页已存在，请确认原页或另起一次作答。');
  return [{ kind: 'correct', id, expectedRev: run.ref.rev, data: paperRun({ issuanceId, pages: [...prior.pages, entry] }) }];
}

export function paperReturnCoverage(pages: readonly PrintPage[], returned: readonly number[]) {
  const present = new Set(returned);
  const required = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const { itemId } of page.pieces) {
      if (itemId === null) continue;
      const seen = required.get(itemId) ?? new Set<number>();
      seen.add(page.number);
      required.set(itemId, seen);
    }
  }
  return [...required].map(([itemId, pageNumbers]) => ({
    itemId,
    status: [...pageNumbers].every(page => present.has(page)) ? 'pages-received' as const : 'unsubmitted' as const,
  }));
}

export function matchPaperReturn(
  marker: { readonly issuanceId: string; readonly page: number } | null,
  candidates: readonly { readonly issuanceId: string; readonly pageCount: number }[],
) {
  const match = marker && candidates.find(candidate => candidate.issuanceId === marker.issuanceId && Number.isSafeInteger(marker.page) &&
    marker.page >= 1 && marker.page <= candidate.pageCount);
  return marker && match ? { kind: 'matched' as const, ...marker }
    : { kind: 'confirm' as const, candidates: candidates.map(candidate => candidate.issuanceId) };
}
