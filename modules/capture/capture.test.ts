import { expect, it } from 'vitest';
import { factId, learnerId, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import applyExtraction from './commands/apply-extraction.ts';
import clarifyExtraction from './commands/clarify-extraction.ts';
import correctExtraction from './commands/correct-extraction.ts';
import { visualExtractionRequest, visualExtractionResult, voiceTranscriptionRequest, voiceTranscriptionResult, waitingAnswerSlots } from './extraction.ts';
import { archivedIntake, intakeDocument } from './intake-values.ts';
import { paperReturnCoverage, projectIssuedPaper } from './paper.ts';
import { captureSourceType, createSourceWrite, reviseSourceWrite, sourceEnvelope, type SourceEnvelope } from './source.ts';

const learner = learnerId('01KFS4AAA00000000000000000');
const id = factId('01KFS4AAA00000000000000001');
const at = '2026-11-21T01:00:00.000Z';
const sha = 'a'.repeat(64);
const original = { blobRef: 'intake:fixture', name: 'page.jpg', mediaType: 'image/jpeg', size: 200, sha256: sha };
const crop_ref = { original: 0, page: 1, bbox: [0.1, 0.2, 0.3, 0.4] };
const envelope = (blocks: readonly unknown[] = []) => sourceEnvelope({
  kind: 'photo', occurredAt: at, recordedAt: at, retentionPolicy: 'retained',
  originals: [original], unit: { kind: 'capture', title: '样卷', blocks },
});
function block(id: string, value: Record<string, unknown>) {
  return { id, parentId: null, body: { kind: 'capture', layer: 'handwriting', itemId: 'q1', slotId: 'part1', crop_ref, ...value } };
}
const rev = (n: number) => n as Revision;
function readSource(data: SourceEnvelope, version: number, epoch = '1') {
  const fact: FactSnapshot = { type: captureSourceType, value: data, ref: { id, learner, rev: rev(version) },
    accessEpoch: epoch as Tick, purpose: ['storage', 'teaching'] };
  const unavailable = async () => { throw new Error('Only fact reads are expected'); };
  const read: ReadContext = { fact: async <Value>() => fact as FactSnapshot<Value>, slot: unavailable, range: unavailable };
  return { learner, read, fact };
}

it('keeps legacy import/full text round trips and Notion uses the common block with its original semantics', () => {
  const legacy = {
    materialId: id, title: '旧档', original: { ...original, mediaType: 'text/plain' },
    extraction: { status: 'corrected', method: 'learner', text: '文字', error: null, warnings: [],
      pages: null, truncated: false, characterCount: 2 },
  };
  expect(intakeDocument(archivedIntake(legacy))).toEqual(intakeDocument(legacy));
  expect(archivedIntake(legacy).envelope.unit.blocks[0]?.body).toMatchObject({ sticky: true, text: '文字' });

  const snapshot = sourceEnvelope({
    kind: 'notion', externalId: 'remote-page', sourceSelectionId: 'root-a', occurredAt: at, recordedAt: at,
    retentionPolicy: 'retained', originals: [], unit: {
      kind: 'capture', title: '课堂', blocks: [{ id: 'remote-block', parentId: null, body: {
        kind: 'capture', layer: 'source', status: 'known', contentHash: sha,
        text: '交作业', notionBody: { type: 'to_do', checked: true },
      } }],
    },
  });
  const { data } = createSourceWrite(id, snapshot);
  expect(data.unit.blocks[0]?.body).toMatchObject({ notionBody: { checked: true } });
  const { fact } = readSource(data, 1);
  const cleared = { ...snapshot, unit: { ...snapshot.unit, blocks: [] } };
  expect(reviseSourceWrite(fact, 1, cleared).data.unit.blocks).toEqual([]);
  expect(() => reviseSourceWrite(fact, 1, { ...cleared, sourceSelectionId: 'root-b' })).toThrow();
});

it('validates effect receipts and keeps unknown and learner corrections through re-extraction', async () => {
  const unknown = block('answer', { status: 'unknown', candidates: ['0.5', '0.8'] });
  const source = envelope([unknown]);
  const request = visualExtractionRequest(source, '红笔是事后订正');
  expect(visualExtractionResult(source, [{ request, state: 'done', result: { version: request.stepKey, blocks: [unknown] } }])).toMatchObject({
    kind: 'value', value: [{ body: { status: 'unknown', clarification: 'pending' } }],
  });
  const spoof = block('answer', { status: 'known', text: '猜测', sticky: true, author: 'learner' });
  expect(visualExtractionResult(source, [{ request, state: 'done', result: { version: request.stepKey, blocks: [spoof] } }]).kind).toBe('unknown');
  const voice = voiceTranscriptionRequest('ephemeral-audio');
  expect(voiceTranscriptionResult([{ request: voice, state: 'done', result: { version: voice.stepKey, transcript: '待我确认' } }])).toEqual({
    kind: 'value', value: '待我确认',
  });

  const clarify = clarifyExtraction.schema.parse({ target: { id, rev: 1 }, blockId: 'answer' });
  const [notice] = await clarifyExtraction.write(readSource(source, 1), clarify, undefined);
  if (notice?.kind !== 'correct') throw new Error('expected clarification receipt');
  const asked = sourceEnvelope(notice.data);
  expect(waitingAnswerSlots(asked.unit.blocks)).toEqual([{ blockId: 'answer', itemId: 'q1', slotId: 'part1', status: 'waiting' }]);
  expect(await clarifyExtraction.write(readSource(asked, 2), { ...clarify, target: { id, rev: rev(2) } }, undefined)).toEqual([]);
  const changedOcr = block('different-id', { status: 'known', text: '猜测' });
  const replacement = (rev: number) => applyExtraction.schema.parse({ target: { id, rev }, blocks: [changedOcr] });
  expect(await applyExtraction.write(readSource(asked, 2), replacement(2), undefined)).toEqual([]);

  const [fix] = await correctExtraction.write(readSource(asked, 2), correctExtraction.schema.parse({
    target: { id, rev: 2 }, blockId: 'answer', text: '0.5',
  }), undefined);
  if (fix?.kind !== 'correct') throw new Error('expected learner correction');
  const fixed = sourceEnvelope(fix.data);
  expect(fixed.unit.blocks[0]?.body).toMatchObject({ status: 'known', text: '0.5', sticky: true, author: 'learner' });
  expect(await applyExtraction.write(readSource(fixed, 3), replacement(3), undefined)).toEqual([]);
});

it('freezes a clean cross-page print and keeps missing pages unsubmitted', async () => {
  const passage = '这是跨页原文🙂。'.repeat(50);
  const source = envelope([
    block('passage', { layer: 'material', status: 'known', text: passage }),
    block('prompt', { layer: 'prompt', status: 'known', text: '答题'.repeat(100) }),
    block('solution', { layer: 'reference-answer', status: 'known', text: 'SOLUTION SECRET' }),
    block('rubric', { layer: 'rubric', status: 'known', text: 'RUBRIC SECRET' }),
    block('red', { layer: 'correction', status: 'known', text: 'CORRECTION SECRET' }),
  ]);
  const issued = { epoch: '1', source: { id, rev: rev(1) }, layout: { lines: 10, columns: 16 } };
  const { read } = readSource(source, 1);
  const sheet = await projectIssuedPaper(read, issued);
  expect(sheet.pages.length).toBeGreaterThan(2);
  expect(sheet.pages.flatMap(page => page.pieces).filter(piece => piece.blockId === 'passage').map(piece => piece.text).join('')).toEqual(passage);
  expect(JSON.stringify(sheet)).not.toMatch(/SECRET|blobRef|crop_ref|sha256/);
  expect((await projectIssuedPaper(read, issued)).issuanceId).toBe(sheet.issuanceId);
  await expect(projectIssuedPaper(readSource(source, 1, '2').read, issued)).rejects.toThrow('用途已变更');
  const submitted = sheet.pages.filter(page => page.pieces.some(piece => piece.itemId === 'q1')).map(page => page.number);
  expect(paperReturnCoverage(sheet.pages, submitted.slice(0, -1))).toEqual([{ itemId: 'q1', status: 'unsubmitted' }]);
  expect(paperReturnCoverage(sheet.pages, submitted)).toEqual([{ itemId: 'q1', status: 'pages-received' }]);
});

it('machine extraction proposes a non-sticky revision and leaves the original locator intact', async () => {
  const source = envelope();
  const candidate = applyExtraction.schema.parse({
    target: { id, rev: 1 },
    blocks: [block('answer', { status: 'known', text: '0.5' })],
  });
  expect(applyExtraction.destructive).toBe(false);
  const writes = await applyExtraction.write(readSource(source, 1), candidate, undefined);
  expect(writes).toMatchObject([{ kind: 'revise', expectedRev: 1, data: {
    originals: source.originals,
    unit: { blocks: [{ body: { status: 'known', text: '0.5' } }] },
  } }]);
});

it('uses a frozen question for a textbook print and omits unclassified textbook prose', async () => {
  const questionId = factId('01KFS4AAA00000000000000002');
  const assetRef = { learner, id: questionId, rev: rev(1) };
  const page: FactSnapshot = {
    type: 'content.textbookPage', ref: { learner, id, rev: rev(1) }, accessEpoch: '1' as Tick, purpose: ['storage'],
    value: { title: '教材应用题', blocks: [
      { id: 'exposition', parentId: null, body: { kind: 'text', text: 'EXPOSITION SECRET' } },
      { id: 'question', parentId: null, body: { kind: 'reference', role: 'question', presentation: 'embed',
        target: { fact: assetRef, type: 'content.asset', anchor: { kind: 'whole' } } } },
    ] },
  };
  const question: FactSnapshot = {
    type: 'content.asset', ref: assetRef, accessEpoch: '2' as Tick, purpose: ['storage'],
    value: { kind: 'question', title: '应用题', promptBlockId: 'statement', blocks: [
      { id: 'statement', parentId: null, body: { kind: 'text', text: '2 + 3 = ?' } },
      { id: 'solution', parentId: null, body: { kind: 'text', text: 'SOLUTION SECRET' } },
    ] },
  };
  const unused = async () => { throw new Error('Only fact reads are expected'); };
  const read: ReadContext = {
    fact: async <Value>(target: typeof id, options: Parameters<ReadContext['fact']>[1]) => {
      expect(options).toEqual({ mode: 'pinned', rev: rev(1) });
      return (target === id ? page : question) as FactSnapshot<Value>;
    },
    slot: unused,
    range: unused,
  };
  const issued = { source: { id, rev: rev(1) }, epoch: '1', layout: { lines: 10, columns: 30 } };
  const sheet = await projectIssuedPaper(read, issued);
  expect(sheet.pages[0]?.pieces).toEqual([{ blockId: 'question.statement', itemId: 'question', text: '2 + 3 = ?' }]);
  expect(JSON.stringify(sheet)).not.toMatch(/SECRET/);
});
