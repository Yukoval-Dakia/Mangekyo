import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { factId } from '@mangekyo/kernel';
import { archivedIntake, intakeDocument } from './intake-values.ts';
import { voiceTranscriptionRequest, voiceTranscriptionResult } from './extraction.ts';

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

it('binds editable voice transcription to the requested recording', () => {
  const voice = voiceTranscriptionRequest('ephemeral-audio');
  const receipt = { request: voice, state: 'done' as const, result: { version: voice.stepKey, transcript: '待我确认' } };
  expect(voiceTranscriptionResult(voiceTranscriptionRequest('other-recording'), [receipt]).kind).toBe('unknown');
  expect(voiceTranscriptionResult(voice, [receipt])).toEqual({
    kind: 'value', value: '待我确认',
  });
});

it('runs layered capture, paper return, Notion and textbook workflows through the command handler', { timeout: 45_000 }, async () => {
  const script = fileURLToPath(new URL('samples/capture-acceptance.test.mjs', import.meta.url));
  const tsx = fileURLToPath(new URL('../../runtime/studio/node_modules/.bin/tsx', import.meta.url));
  await promisify(execFile)(tsx, [script]);
});
