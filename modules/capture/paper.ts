import { factId, type ReadContext } from '@mangekyo/kernel';
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

export async function projectIssuedPaper(read: ReadContext, issuance: Issuance) {
  const fact = await read.fact(issuance.source.id, { mode: 'pinned', rev: issuance.source.rev });
  if (fact.type !== captureSourceType || fact.accessEpoch !== issuance.epoch)
    throw new Error('原件发放版本或用途已变更。');
  const source = sourceEnvelope(fact.value);
  if (source.kind !== 'photo' && source.kind !== 'pdf') throw new Error('原件没有可打印卷面。');
  return { issuanceId: await paperIssuanceId(issuance), title: source.unit.title, pages: paginate(cleanBlocks(source.unit.blocks), issuance.layout) };
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
