import { factId, type FactSnapshot, type ReadContext } from '@mangekyo/kernel';
import { assetType, checkTextbookBasis, parseTextbookPage, questionAsset, questionPrompt, textbookPageType,
  type AssetReference } from '@mangekyo/module-content/facts/asset-contract';
import { captureObject as object, captureRef, captureText as text, sha256 } from './parse.ts';
import { captureSourceType, sourceEnvelope, type Block } from './source.ts';

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

export function paperIssuance(input: unknown) {
  const { source, epoch, layout } = object(input);
  if (typeof epoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(epoch)) throw new Error('发卷授权版本无效。');
  return { source: captureRef(source), epoch, layout: printLayout(layout) };
}

type Issuance = ReturnType<typeof paperIssuance>;

async function idFromDefinition(data: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)));
  return factId([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 26).toUpperCase());
}

export function paperIssuanceId(data: Issuance) {
  return idFromDefinition(['capture.paper', data.source.id, data.source.rev, data.epoch, data.layout.lines, data.layout.columns]);
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
function paginate(pieces: readonly PrintPiece[], { lines, columns }: Issuance['layout']): readonly PrintPage[] {
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
  if (reference.fact.learner !== learner || fact.ref.learner !== learner || fact.type !== reference.type)
    throw new Error('引用的卷面内容类型或归属不符。');
  return fact;
}

async function cleanQuestion(read: ReadContext, fact: FactSnapshot, itemId: string): Promise<readonly PrintPiece[]> {
  if (fact.type !== assetType) throw new Error('题目引用类型无效。');
  const question = questionAsset(fact.value);
  await checkTextbookBasis(read, question.basis ?? []);
  const pieces: PrintPiece[] = [];
  for (const { body, id } of question.blocks) {
    if (body.kind !== 'sharedMaterial') continue;
    const source = await openPrintReference(read, body.source, fact.ref.learner);
    if (source.type !== captureSourceType) throw new Error('共享打印材料须指向已分层原件。');
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

async function frozenPrintParts(read: ReadContext, fact: FactSnapshot): Promise<{ title: string; pieces: readonly PrintPiece[] }> {
  if (fact.type === captureSourceType) {
    const source = sourceEnvelope(fact.value);
    if (source.kind !== 'photo' && source.kind !== 'pdf') throw new Error('原件没有可打印卷面。');
    return { title: source.unit.title, pieces: cleanBlocks(source.unit.blocks) };
  }
  if (fact.type === assetType) {
    const question = questionAsset(fact.value);
    return { title: question.title, pieces: await cleanQuestion(read, fact, 'q1') };
  }
  if (fact.type === textbookPageType) {
    const page = parseTextbookPage(fact.value);
    await checkTextbookBasis(read, page.basis ?? []);
    const pieces: PrintPiece[] = [];
    for (const { id, body } of page.blocks) {
      if (body.kind !== 'reference' || body.role !== 'question' || body.presentation !== 'embed') continue;
      pieces.push(...await cleanQuestion(read, await openPrintReference(read, body.target, fact.ref.learner), id));
    }
    if (!pieces.length) throw new Error('教材页没有可打印的嵌入题目。');
    return { title: page.title, pieces };
  }
  if (fact.type === 'activity.retentionPosttest') {
    const issued = object(fact.value);
    const ref = captureRef(issued.paper);
    const paper = await read.fact(ref.id, { mode: 'pinned', rev: ref.rev });
    if (paper.type !== 'activity.retentionPaper' || paper.accessEpoch !== issued.paperEpoch) throw new Error('后测冻结卷授权已变更。');
    const print = await frozenPrintParts(read, paper);
    if (!print.pieces.some(piece => piece.itemId === issued.itemId)) throw new Error('后测发放题位与冻结卷不符。');
    return print;
  }
  if (fact.type !== 'activity.workbookPaper' && fact.type !== 'activity.retentionPaper') throw new Error('没有可打印的冻结卷。');
  // Activity owns this persisted frozen paper. Pick only its learner-visible
  // fields and reopen any pinned question dependencies under the same purpose.
  const paper = object(fact.value);
  if (!Array.isArray(paper.questions) || !paper.questions.length) throw new Error('冻结卷没有题目。');
  const pieces: PrintPiece[] = [];
  const seen = new Set<string>();
  for (const input of paper.questions) {
    const question = object(input);
    const itemId = text(question.id, '题位', 200);
    if (seen.has(itemId)) throw new Error('冻结卷题位重复。');
    seen.add(itemId);
    if (question.sourceQuestionRef !== undefined && question.sourceQuestionRef !== null) {
      const ref = captureRef(question.sourceQuestionRef);
      const source = await read.fact(ref.id, { mode: 'pinned', rev: ref.rev });
      if (source.type === 'activity.workspaceEntry') {
        const entry = object(source.value);
        if (entry.kind !== 'question' || entry.body !== question.prompt) throw new Error('来源题目与冻结题面不符。');
      } else {
        const sourcePieces = await cleanQuestion(read, source, itemId);
        pieces.push(...sourcePieces.filter(piece => piece.itemId === null));
      }
    }
    pieces.push({ blockId: itemId, itemId, text: text(question.prompt, '冻结题面', 2_000_000) });
  }
  return { title: text(paper.title, '冻结卷标题', 240), pieces };
}

export async function projectIssuedPaper(read: ReadContext, issuance: Issuance) {
  const fact = await read.fact(issuance.source.id, { mode: 'pinned', rev: issuance.source.rev });
  if (fact.accessEpoch !== issuance.epoch) throw new Error('原件发放版本或用途已变更。');
  const { title, pieces } = await frozenPrintParts(read, fact);
  return { issuanceId: await paperIssuanceId(issuance), title, pages: paginate(pieces, issuance.layout) };
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
