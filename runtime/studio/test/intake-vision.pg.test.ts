import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aroundAll, describe, expect, it, vi } from 'vitest';
import { factId } from '../../../kernel/src/declarations/ids.ts';
import { acknowledgeStartedWork, relayPending, type WorkRef } from '../../../kernel/src/work/index.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { intakeIdFor } from '../intake-lifecycle.ts';
import { openVisionIntakeWork, visionIntakeRoute } from '../intake-vision.ts';
import { handleIntakeRequest, openIntake, type IntakeMetadata } from '../intake.ts';
import { stableId, studioLearner } from '../identity.ts';
import { openTransparency } from '../transparency.ts';
import { loadStudioTestModule } from './modules.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');
describe.skipIf(!testDatabaseUrl)('async vision intake in PostgreSQL', () => {
  let db: Parameters<typeof openIntake>[0], intake: ReturnType<typeof openIntake>, origin = '', modelOrigin = '', directory = '', settingsFile = '';
  const modelRequests: unknown[] = [];
  aroundAll(run => withLearnerDatabase(studioLearner, async database => {
    db = database;
    directory = await mkdtemp(join(tmpdir(), 'mangekyo-intake-vision-'));
    settingsFile = join(directory, 'provider.json');
    vi.stubEnv('MANGEKYO_INTAKE_DATA_DIR', directory);
    vi.stubEnv('MANGEKYO_VISION_OCR_BASE_URL', '');
    vi.stubEnv('MANGEKYO_SETTINGS_FILE', settingsFile);
    intake = openIntake(db, await loadStudioTestModule('capture'), await loadStudioTestModule('content'));
    const serve = (body: (request: unknown) => unknown) => createServer((request, response) => {
      let raw = ''; request.on('data', chunk => raw += chunk); request.on('end', () => {
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body(JSON.parse(raw))));
      });
    });
    const api = createServer((request, response) => void handleIntakeRequest(
      intake, request, response, new URL(request.url!, 'http://127.0.0.1').pathname, request.method));
    const ocr = {
      version: 'vision-paper-ocr-v1', paperTitle: '视觉试卷', subject: '数学', pageNote: null,
      questions: [{ index: 1, number: '1', questionType: 'calculation', stem: '计算 $\\frac{1}{2}$', options: [],
        studentAnswer: { status: 'present', text: '$\\frac{1}{2}$' }, redInk: { verdict: 'correct', marks: [], correction: null, score: '1' }, unclearSegments: [] }],
      freeformText: null, warnings: [] };
    const model = serve(body => (modelRequests.push(body), { model: 'vision-strong',
      choices: [{ message: { content: JSON.stringify(ocr) } }],
      usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540 } }));
    for (const [server, name] of [[api, ''], [model, 'model']] as const) {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
      if (name) modelOrigin = `http://127.0.0.1:${address.port}`; else origin = `http://127.0.0.1:${address.port}`;
    }
    try { await run(); } finally {
      for (const server of [api, model]) if (server.listening) await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs();
    }
  }));
  async function capture(requestId: string) {
    const form = new FormData(); form.set('requestId', requestId); form.set('deletionWatermark', '0');
    form.set('file', new Blob([png], { type: 'image/png' }), 'paper.png');
    const started = Date.now(), response = await fetch(origin + '/api/intake', { method: 'POST', body: form });
    return { response, elapsed: Date.now() - started, receipt: await response.json() as IntakeMetadata };
  }
  async function capturePages(requestId: string, pages: readonly Buffer[]) {
    const form = new FormData(); form.set('requestId', requestId); form.set('deletionWatermark', '0');
    for (const [index, bytes] of pages.entries()) form.append('files', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), `p${index + 1}.png`);
    const response = await fetch(origin + '/api/intake', { method: 'POST', body: form });
    return { response, receipt: await response.json() as IntakeMetadata };
  }
  async function appendPages(materialId: string, requestId: string, expectedRev: number, page: Buffer) {
    const form = new FormData(); form.set('requestId', requestId); form.set('expectedRev', String(expectedRev));
    form.append('files', new Blob([new Uint8Array(page)], { type: 'image/png' }), 'p3.png');
    const response = await fetch(`${origin}/api/materials/${materialId}/pages`, { method: 'POST', body: form });
    return { response, receipt: await response.json() as IntakeMetadata };
  }
  async function workFor(receipt: IntakeMetadata) {
    const owner = intakeIdFor(factId(receipt.id)); let selected: WorkRef | undefined;
    await relayPending(db, async (_, intent) => {
      const ref = await acknowledgeStartedWork(db, intent, visionIntakeRoute);
      if (ref && (await db.query('SELECT 1 FROM work WHERE id=$1 AND execution_ref=$2', [ref.workId, intent])).rowCount) selected = ref;
    }, visionIntakeRoute);
    if (!selected) throw new Error('missing vision work'); return selected;
  }
  it('reads strong settings, rejects weak settings, and respects manual corrections', async () => {
    const first = await capture('vision-success'); const receipt = first.receipt;
    expect(first.response.status).toBe(202); expect(first.elapsed).toBeLessThan(2000);
    expect(receipt).toMatchObject({ requestedExtraction: 'vision_llm', intakeStatus: 'queued', extraction: { status: 'pending' } });
    expect((await db.query("SELECT o.state FROM work w JOIN work_outbox o ON o.work_id=w.id WHERE w.slot_type='activity.intakeVisionExtraction' AND w.slot_key=$1", [intakeIdFor(factId(receipt.id))])).rows[0]).toEqual({ state: 'routed_pending' });
    expect(await (await fetch(origin + '/api/intake/options')).json()).toMatchObject({visionOcr: false});
    await writeFile(settingsFile, JSON.stringify({version: 2, providers: [{id: 'studio', label: 'Studio', baseUrl: modelOrigin, protocol: 'openai', model: 'group/powerful', reasoningEffort: 'default', apiKey: 'test-key'}], activeProviderId: 'studio', mcpServers: [], allowSearch: false}));
    expect(await (await fetch(origin + '/api/intake/options')).json()).toMatchObject({visionOcr: true});
    await openVisionIntakeWork(db, intake).execute(await workFor(receipt));
    expect(modelRequests[0]).toMatchObject({model: 'group/powerful', messages: expect.any(Array)});
    expect(await intake.metadata(receipt.id)).toMatchObject({ fullText: expect.stringContaining('计算 $\\frac{1}{2}$'), intakeStatus: 'ready',
      extraction: { method: 'vision_llm', status: 'ok', drafts: { pendingConfirmationCount: 1 } } });
    const calls = async () => (await openTransparency(db).aiActivity()).usage.recentCalls.filter(c => c.label === 'vision-ocr');
    expect(await calls()).toContainEqual(expect.objectContaining({ ownerId: receipt.id, model: 'vision-strong',
      promptTokens: 1200, completionTokens: 340, totalTokens: 1540 }));
    const { receipt: fallback } = await capture('vision-fallback'); const ref = await workFor(fallback);
    await writeFile(settingsFile, JSON.stringify({version: 2, providers: [{id: 'studio', label: 'Studio', baseUrl: modelOrigin, protocol: 'openai', model: 'group/flash', reasoningEffort: 'default', apiKey: 'test-key'}], activeProviderId: 'studio', mcpServers: [], allowSearch: false}));
    await openVisionIntakeWork(db, intake, {fallbackExtractLocal: async () => ({
      status: 'ok', method: 'vision', text: '本地识别', error: null, warnings: [], pages: 1, truncated: false, characterCount: 4 }) }).execute(ref);
    expect(await intake.metadata(fallback.id)).toMatchObject({ fullText: '本地识别', intakeStatus: 'fallback', extraction: { method: 'vision_fallback', status: 'ok' } });
    expect((await calls()).every(c => c.ownerId !== fallback.id)).toBe(true);
    const { receipt: corrected } = await capture('vision-corrected'); const stale = await workFor(corrected);
    await intake.correct({ materialId: corrected.id, expectedRev: corrected.revision, text: '人工更正', requestId: 'manual-vision' });
    await openVisionIntakeWork(db, intake).execute(stale);
    expect(await intake.metadata(corrected.id)).toMatchObject({ fullText: '人工更正', extraction: { status: 'corrected', method: 'learner' } });
    expect((await db.query("SELECT count(*)::int AS count FROM facts WHERE type ILIKE '%question%'")).rows[0]).toEqual({ count: 0 });
  });
  it('merges multi-page photo capture with per-page retry and erasure', async () => {
    const { response, receipt } = await capturePages('mp-capture', [png, png]);
    expect(response.status).toBe(202);
    expect(receipt).toMatchObject({ requestedExtraction: 'vision_llm', intakeStatus: 'queued', pageCount: 2 });
    expect(receipt.originals).toHaveLength(2);
    await writeFile(settingsFile, JSON.stringify({version: 2, providers: [{id: 'studio', label: 'Studio', baseUrl: modelOrigin, protocol: 'openai', model: 'group/powerful', reasoningEffort: 'default', apiKey: 'test-key'}], activeProviderId: 'studio', mcpServers: [], allowSearch: false}));
    await openVisionIntakeWork(db, intake).execute(await workFor(receipt));
    const merged = await intake.metadata(receipt.id);
    expect(merged).toMatchObject({ intakeStatus: 'ready', pageCount: 2 });
    expect(merged.extraction.pageExtractions).toHaveLength(2);
    const pageTwo = await fetch(`${origin}/api/materials/${receipt.id}/pages/2/original`);
    expect(pageTwo.status).toBe(200);
    const appended = await appendPages(receipt.id, 'mp-append', merged.revision, png);
    expect(appended.response.status).toBe(202);
    expect(appended.receipt.pageCount).toBe(3);
    expect(appended.receipt.originals).toHaveLength(3);
    await openVisionIntakeWork(db, intake, {resolveVisionConfig: () => null, fallbackExtractLocal: async () => ({
      status: 'ok', method: 'vision', text: '本地识别', error: null, warnings: [], pages: 1, truncated: false, characterCount: 4 }) }).execute(await workFor(appended.receipt));
    const afterAppend = await intake.metadata(receipt.id);
    expect(afterAppend.extraction.pageExtractions).toHaveLength(3);
    expect(afterAppend.retryableVisionPages.length).toBeGreaterThan(0);
    const retry = await fetch(`${origin}/api/materials/${receipt.id}/retry-vision`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'mp-retry', expectedRev: afterAppend.revision, pages: [2] }) });
    expect(retry.status).toBe(202);
    const retryWork = await workFor(appended.receipt);
    await openVisionIntakeWork(db, intake).execute(retryWork);
    const retried = await intake.metadata(receipt.id);
    expect(retried.extraction.pageExtractions?.find(p => p.page === 2)?.status).toBe('ready');
    const erase = await fetch(`${origin}/api/materials/${receipt.id}/erasure`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'mp-erase', expectedRev: retried.revision, confirmation: 'permanently-delete-original' }) });
    expect(erase.status).toBe(200);
    expect((await fetch(`${origin}/api/materials/${receipt.id}`)).status).toBe(404);
    expect((await openTransparency(db).aiActivity()).usage.recentCalls.every(c => !(c.label === 'vision-ocr' && c.ownerId === receipt.id))).toBe(true);
  });
});
