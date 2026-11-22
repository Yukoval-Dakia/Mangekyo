import { expect, it, vi } from 'vitest';
import { commandId, factId, learnerId } from '@mangekyo/kernel';
import { archivedIntake, intakeDocument } from './intake-values.ts';
import { voiceTranscriptionRequest, voiceTranscriptionResult } from './extraction.ts';
import { buildVisionPaperOcrPrompt } from './vision-paper-ocr.ts';
import { consumePublicLink, openPublicLink, publicLinkEffect, publicLinkVersion, type PublicLinkReadRequest } from './public-link.ts';

it('keeps the original private intake record readable after projecting its content blocks', () => {
  const id = factId('01KFS4AAA00000000000000001');
  const original = { blobRef: 'intake:fixture', name: 'note.txt', size: 200, sha256: 'a'.repeat(64) };
  const legacy = {
    materialId: id, title: '旧档', original: { ...original, mediaType: 'text/plain' },
    extraction: { status: 'corrected', method: 'learner', text: '文字', error: null, warnings: [],
      pages: null, truncated: false, characterCount: 2 },
  };
  expect(intakeDocument(archivedIntake(legacy))).toEqual(intakeDocument(legacy));
  expect(archivedIntake(legacy).envelope.unit.blocks[0]?.body).toMatchObject({ sticky: true, text: '文字' });
});

it('keeps vision paper OCR prompts constrained to faithful transcription', () => {
  const { systemPrompt, userPrompt } = buildVisionPaperOcrPrompt();
  expect(`${systemPrompt}\n${userPrompt}`).toContain('严禁解题、推导计算或判断学生选项对错');
  expect(`${systemPrompt}\n${userPrompt}`).toContain('保留题干开头的真题来源标注');
  expect(`${systemPrompt}\n${userPrompt}`).toContain('忽略OMR答题卡填涂泡与条码噪点');
});

it('binds editable voice transcription to the requested recording', () => {
  const voice = voiceTranscriptionRequest('ephemeral-audio');
  const receipt = { request: voice, state: 'done' as const, result: { version: voice.stepKey, transcript: '待我确认' } };
  expect(voiceTranscriptionResult(voiceTranscriptionRequest('other-recording'), [receipt]).kind).toBe('unknown');
  expect(voiceTranscriptionResult(voice, [receipt])).toEqual({
    kind: 'value', value: '待我确认',
  });
});

it('requires a current explicit grant before dispatching or reopening a link', async () => {
  const id = '01KFS4AAA00000000000000001';
  const basis = { learner: learnerId(id), requestId: commandId(id), target: { id: factId(id), rev: 1 },
    accessEpoch: '0', purpose: 'learning', recipient: 'public-reader', intent: 'read-link' } as PublicLinkReadRequest;
  const resolve = async () => null;
  const readPublicText = vi.fn();
  const read = { fact: vi.fn(), range: vi.fn(), slot: vi.fn() };
  expect(await consumePublicLink({ label: publicLinkEffect, stepKey: publicLinkVersion, input: basis }, resolve,
    { recipient: basis.recipient, readPublicText })).toEqual({ status: 'unauthorized' });
  await expect(openPublicLink(read, basis, resolve)).rejects.toThrow('当前授权');
  expect(readPublicText).not.toHaveBeenCalled();
  expect(read.slot).not.toHaveBeenCalled();
});

it('runs layered capture, paper return, Notion, textbook and graph workflows through the command handler', { timeout: 45_000 }, async () => {
  await import(new URL('./samples/capture-acceptance.test.mjs', import.meta.url).href);
});
