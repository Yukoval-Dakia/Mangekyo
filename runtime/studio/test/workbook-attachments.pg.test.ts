import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aroundAll, describe, expect, it, vi } from 'vitest';
import { acknowledgeStartedWork, finishWork, readWork, relayPending, type WorkRef } from '../../../kernel/src/work/index.ts';
import { factId, type Revision } from '../../../kernel/src/declarations/ids.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import type { WorkbookAttachmentEvidence } from '../../../modules/activity/workbook-attachments.ts';
import { workbookTextEvaluator } from '../../../modules/activity/workbook-assessment-values.ts';
import { workbookDraft } from '../../../modules/activity/workbook-values.ts';
import { stableId, studioLearner } from '../identity.ts';
import { openIntake } from '../intake.ts';
import { serve } from '../http.ts';
import { openResearch } from '../research.ts';
import { saveSettings } from '../settings.ts';
import { openWorkbook } from '../workbook.ts';
import { openWorkbookAssessment, prepareWorkbookRelease, workbookAssessmentSlot } from '../workbook-assessment.ts';
import { loadStudioTestModule } from './modules.ts';

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x50, 0x50, 0x56, 0x50, 0x38, 0x20]);

describe.skipIf(!testDatabaseUrl)('workbook question photo attachments (PG + Studio HTTP)', () => {
  let db: Parameters<typeof openWorkbook>[0], origin: string, directory: string;
  let research: ReturnType<typeof openResearch>, assessment: ReturnType<typeof openWorkbookAssessment>;
  const seenResearch: { attachments?: WorkbookAttachmentEvidence[] }[] = [];
  const seenGrading: (readonly WorkbookAttachmentEvidence[] | undefined)[] = [];
  const releaseRef = { id: factId(stableId('workbook-paper', 'paper-attach-001')), rev: 1 as Revision };
  const paperDraft = {
    requestId: 'paper-attach-001', title: '单题拍照综合卷',
    questions: [{ kind: 'numeric' as const, prompt: '求 6 × 7', answer: 42, tolerance: 0 }, { kind: 'rubric' as const, prompt: '写推导', rubric: '写出关键步' }],
  };
  const rawRelease = {
    items: [{ itemId: 'q2', promptRef: releaseRef, slots: [{ slotId: 'main', schemaVersion: '1', fields: [{ path: '', kind: 'attachment' as const }] }],
      criteria: [{ criterionId: 'steps', inputs: [{ slotId: 'main', path: '' }], evaluator: workbookTextEvaluator, maximum: 5,
        source: { kind: 'product-rubric' as const, ref: releaseRef, path: '/questions/1/rubric' }, missingEvidence: 'insufficient-evidence' as const, parameters: { routeId: 'vision-route-v1' } }] }],
  };
  const frozenItem = prepareWorkbookRelease(rawRelease, releaseRef.id, workbookDraft(paperDraft)).items[0]!;
  const sampleRef = { id: factId('01ARZ3NDEKTSV4RRFFQ69G5F20'), rev: 1 as Revision }, submissionRef = { id: factId('01ARZ3NDEKTSV4RRFFQ69G5F21'), rev: 1 as Revision };
  const witnessRef = { id: factId('01ARZ3NDEKTSV4RRFFQ69G5F22'), rev: 1 as Revision }, receiptRef = { id: factId('01ARZ3NDEKTSV4RRFFQ69G5F23'), rev: 1 as Revision };
  const sampleOutcome = { releaseRef, submissionRef, outcomes: [{ itemId: 'q2', criterionId: 'steps', state: 'scored', earned: 5, evidence: [{ slotId: 'main', path: '' }] }] };

  aroundAll(run => withLearnerDatabase(studioLearner, async database => {
    db = database;
    directory = await mkdtemp(join(tmpdir(), 'mangekyo-wb-attach-'));
    vi.stubEnv('MANGEKYO_INTAKE_DATA_DIR', directory);
    vi.stubEnv('MANGEKYO_SETTINGS_FILE', join(directory, 'provider.json'));
    const llm = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] };
      const payload = JSON.parse(body.messages[1]!.content) as { source?: { attachments?: WorkbookAttachmentEvidence[] } };
      if (payload.source) seenResearch.push(payload.source);
      res.writeHead(200, { 'content-type': 'application/json', 'x-actual-usd-micros': '1000' });
      res.end(JSON.stringify({ model: 'test-vision', choices: [{ message: { content: JSON.stringify({ title: '单题图证复习', steps: ['对照手写过程检查关键一步。'] }) } }] }));
    });
    await new Promise<void>(resolve => llm.listen(0, '127.0.0.1', resolve));
    const llmPort = (llm.address() as { port: number }).port;
    await saveSettings({ baseUrl: `http://127.0.0.1:${llmPort}/v1`, apiKey: 'test-key', model: 'test-vision', protocol: 'openai' });
    const tariff = { route: 'vision-research', endpoint: `http://127.0.0.1:${llmPort}/v1/chat/completions`, model: 'test-vision', reserveUsdMicros: 5000, retentionDays: 0, protocol: 'openai' as const };
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
    const [activity, capture, content, companion] = await Promise.all(['activity', 'capture', 'content', 'companion'].map(loadStudioTestModule));
    research = openResearch(db, activity!, companion!, undefined, undefined, undefined, tariff);
    assessment = openWorkbookAssessment(db, {
      readVerifiedEvidence: target => target.releaseRef.id === releaseRef.id && target.itemId === 'q2' ? {
        witness: { ref: witnessRef, origin: 'independent-solution', releaseRef, frozenItem, requiredSampleRefs: [sampleRef],
          requiredCoverage: [{ kind: 'normal', criterionId: 'steps', sampleRef }, { kind: 'partial', criterionId: 'steps', sampleRef, applies: false }, { kind: 'negative', criterionId: 'steps', sampleRef, applies: false }] },
        samples: [{ sample: { sampleRef, expected: sampleOutcome, submission: { releaseRef, submissionRef, answers: [{ itemId: 'q2', slotId: 'main', path: '', schemaVersion: '1', value: { kind: 'attachment', ref: { id: factId('01ARZ3NDEKTSV4RRFFQ69G5F24'), rev: 1 as Revision } } }] } },
          run: { state: 'completed', witnessRef, sampleRef, receiptRef, evaluators: [{ criterionId: 'steps', evaluator: workbookTextEvaluator }], actual: sampleOutcome } }],
      } : null,
      resolveAssessmentRoute: async routeId => routeId === 'vision-route-v1' ? {
        id: routeId, reserve: async () => true,
        score: async input => { seenGrading.push(input.attachments); return { state: 'scored', earned: 5, feedback: '手写推导完整。', quote: '关键步骤正确', reportedModel: 'vision-v1' }; },
      } : null,
    });
    const intake = openIntake(db, capture!, content!);
    const workbook = openWorkbook(db, activity!, { capture: capture!, assessment, onResearchFactsChanged: research.workbookChanged });
    const server = serve(db, {} as never, {} as never, {} as never, {
      notion: {} as never, textbook: {} as never, relationReview: {} as never, workbook, takeaways: {} as never,
      organizer: {} as never, memory: {} as never, memoryManagement: {} as never, intake, capturePapers: {} as never,
      workspace: {} as never, research, recall: {} as never, retention: {} as never, retentionComparison: {} as never, iqdb: {} as never,
      carePause: {} as never,
    }, port);
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${port}`;
    try { await run(); } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await new Promise<void>(resolve => llm.close(() => resolve()));
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  }));

  async function api(path: string, method = 'GET', data?: unknown) {
    const res = await fetch(origin + path, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
  }
  async function upload(paperId: string, bytes: Uint8Array, filename: string, type: string, fields: Record<string, string> = {}) {
    const form = new FormData(); form.append('file', new Blob([bytes.slice()], { type }), filename);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const res = await fetch(`${origin}/api/papers/${paperId}/attachments`, { method: 'POST', body: form });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  }
  async function drainWork() {
    for (let round = 0; round < 8; round += 1) {
      const ready: WorkRef[] = [];
      await relayPending(db, async (_, intent) => { const acked = await acknowledgeStartedWork(db, intent); if (acked) ready.push(acked); });
      if (!ready.length) break;
      for (const ref of ready) {
        const work = await readWork(db, ref);
        if (work?.slotType === workbookAssessmentSlot) await assessment.execute(ref);
        else if (work?.slotType === 'companion.researchWake') {
          await finishWork(db, ref);
          const { rows: [row] } = await db.query<{ ref: string }>(`SELECT r.data->>'coordinatorRef' AS ref FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev) WHERE f.learner_id=$1 AND f.type='companion.researchSettings' AND f.retracted_rev IS NULL`, [studioLearner]);
          if (row?.ref) for (let step = 0; step < 6; step += 1) if ((await research.advance({ coordinatorRef: row.ref }, new AbortController().signal)).status !== 'advanced') break;
        } else await research.execute(ref);
      }
    }
  }

  it('enforces upload magic, scope once vs inherit, grading/research binding, revocation, erasure, and legacy compatibility', async () => {
    const saved = await api('/api/papers', 'POST', { ...paperDraft, assessmentRelease: rawRelease });
    expect(saved.status).toBe(201); const paperId = saved.json.id as string;
    expect((await upload(paperId, new TextEncoder().encode('%PDF-1.7'), 'fake.png', 'image/png')).status).toBe(415);
    expect((await upload(paperId, pngBytes, 'wrong.jpg', 'image/jpeg')).status).toBe(415);
    expect((await upload(paperId, pngBytes, 'bad.png', 'image/png', { itemId: 'q99' })).status).toBe(400);
    expect((await upload('01ARZ3NDEKTSV4RRFFQ69G5F99', pngBytes, 'miss.png', 'image/png')).status).toBe(404);

    const png = (await upload(paperId, pngBytes, 'q1.png', 'image/png', { itemId: 'q1', requestId: 'req-png-0001' })).json as { originalId: string; rev: number; url: string; mimeType: string; scope: string };
    expect(png).toMatchObject({ rev: 1, mimeType: 'image/png', scope: 'inherit', url: `/api/materials/${png.originalId}/original` });
    expect((await upload(paperId, pngBytes, 'q1.png', 'image/png', { itemId: 'q1', requestId: 'req-png-0001' })).json).toEqual(png);
    expect((await upload(paperId, jpegBytes, 'q1.jpg', 'image/jpeg', { itemId: 'q1', requestId: 'req-png-0001' })).status).toBe(409);
    const jpeg = (await upload(paperId, jpegBytes, 'q1.jpg', 'image/jpeg', { itemId: 'q1', scope: 'once', requestId: 'req-jpg-0001' })).json as { originalId: string; rev: number; url: string; mimeType: string; scope: string };
    expect(jpeg).toMatchObject({ rev: 1, mimeType: 'image/jpeg', scope: 'once' });
    const webp = (await upload(paperId, webpBytes, 'q2.webp', 'image/webp', { itemId: 'q2', requestId: 'req-webp-001' })).json as { originalId: string; rev: number; url: string; mimeType: string; scope: string };
    expect(webp).toMatchObject({ rev: 1, mimeType: 'image/webp', scope: 'inherit' });

    const originalRead = await fetch(origin + png.url);
    expect(originalRead.status).toBe(200); expect(originalRead.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await originalRead.arrayBuffer())).toEqual(pngBytes);

    const legacy = await api(`/api/papers/${paperId}/attempts`, 'POST', { requestId: 'attempt-legacy-1', answers: { q1: '42' } });
    expect(legacy.status).toBe(200); expect((legacy.json.attempts as Record<string, unknown>[])[0]).not.toHaveProperty('questionAttachments');
    expect((await api(`/api/papers/${paperId}/attempts`, 'POST', { requestId: 'attempt-bad-item', answers: { q1: '42' }, questionAttachments: { q2: [{ originalId: png.originalId, rev: 1 }] } })).status).toBe(409);

    const submitted = await api(`/api/papers/${paperId}/attempts`, 'POST', {
      requestId: 'attempt-photo-01', answers: { q1: '41', q2: null }, assessmentConsent: 'send-question-answer-rubric',
      questionAttachments: { q1: [{ originalId: png.originalId, rev: 1 }, { originalId: jpeg.originalId, rev: 1 }], q2: [{ originalId: webp.originalId, rev: 1 }] },
    });
    expect(submitted.status).toBe(200);
    const attempt = (submitted.json.attempts as { id: string; requestId: string; questionAttachments?: Record<string, unknown[]> }[]).find(item => item.requestId === 'attempt-photo-01')!;
    expect(attempt.questionAttachments).toEqual({
      q1: [{ originalId: png.originalId, rev: 1, url: png.url, available: true }, { originalId: jpeg.originalId, rev: 1, url: jpeg.url, available: true }],
      q2: [{ originalId: webp.originalId, rev: 1, url: webp.url, available: true }],
    });
    expect((await api(`/api/papers/${paperId}/attempts`, 'POST', { requestId: 'attempt-reuse-01', answers: { q1: '42' }, questionAttachments: { q1: [{ originalId: jpeg.originalId, rev: 1 }] } })).status).toBe(409);

    await drainWork();
    expect(seenGrading).toEqual([[{ originalId: webp.originalId, rev: 1, url: webp.url, mimeType: 'image/webp' }]]);

    const offer = ((await api('/api/research/settings')).json.workerOffers as Record<string, unknown>[])[0]!;
    expect((await api('/api/research/settings', 'PUT', { requestId: 'res-cfg-001', revision: 0, enabled: true, workerGrant: {
      profile: 'heavy_tutor_prep', ...offer, limitMicros: Number(offer.maxPerCallMicros) * 4, expiresAtMs: Date.now() + 3_600_000,
    } })).status).toBe(200);
    expect((await api(`/api/papers/${paperId}/attempts/${attempt.id}/research-permission`, 'PUT', { requestId: 'res-perm-001', revision: 1, allowed: true })).status).toBe(200);
    await drainWork();
    expect(((await api(`/api/papers/${paperId}`)).json.attempts as { id: string; formalAssessment?: { state: string } }[]).find(item => item.id === attempt.id)?.formalAssessment?.state).toBe('complete');
    expect(seenResearch).toHaveLength(1);
    expect(seenResearch[0]?.attachments).toEqual([{ originalId: png.originalId, rev: 1, url: png.url, mimeType: 'image/png' }]);
    const wsId = ((await api(`/api/papers/${paperId}/attempts/${attempt.id}/research`)).json.worksheet as { id: string }).id;
    expect((await api(`/api/papers/${paperId}/attempts/${attempt.id}/research/${wsId}/source`)).json.attachments).toEqual([{ originalId: png.originalId, rev: 1, url: png.url, mimeType: 'image/png' }]);

    await db.query('UPDATE facts SET access_epoch = access_epoch + 1, purpose = ARRAY[]::text[] WHERE learner_id=$1 AND id=$2', [studioLearner, jpeg.originalId]);
    expect((await fetch(origin + jpeg.url)).status).toBe(404);
    const revoked = ((await api(`/api/papers/${paperId}`)).json.attempts as { id: string; questionAttachments?: Record<string, { originalId: string }[]> }[]).find(item => item.id === attempt.id)!;
    expect(revoked.questionAttachments?.q1?.map(item => item.originalId)).toEqual([png.originalId]);
    expect(JSON.stringify(revoked)).not.toContain(jpeg.originalId);

    expect((await api(`/api/materials/${png.originalId}/erasure`, 'POST', { confirmation: 'permanently-delete-original', expectedRev: 1, requestId: 'erase-png-001' })).json.original).toBe('removed');
    expect((await fetch(origin + png.url)).status).toBe(404);
    expect((await api(`/api/papers/${paperId}/attempts/${attempt.id}/research/${wsId}/source`)).status).toBe(404);
    expect((await api(`/api/papers/${paperId}/attempts/${attempt.id}/research`)).json.worksheet).toBeNull();
    expect((await api(`/api/materials/${webp.originalId}/erasure`, 'POST', { confirmation: 'permanently-delete-original', expectedRev: 1, requestId: 'erase-webp-001' })).status).toBe(200);
    const erased = ((await api(`/api/papers/${paperId}`)).json.attempts as { id: string; questionAttachments?: unknown; formalAssessment?: { state: string } }[]).find(item => item.id === attempt.id)!;
    expect(erased.questionAttachments).toBeUndefined(); expect(erased.formalAssessment?.state).toBe('blocked');
    expect(JSON.stringify(erased)).not.toContain(png.originalId); expect(JSON.stringify(erased)).not.toContain(webp.originalId);

    await drainWork();
    expect(seenResearch.slice(1).every(item => !item.attachments?.length)).toBe(true);
    const watermark = (await api('/api/lifecycle')).json.watermark as string;
    expect((await api(`/api/papers/${paperId}/attempts`, 'POST', { requestId: 'attempt-erased-1', deletionWatermark: watermark, answers: { q1: '42' }, questionAttachments: { q1: [{ originalId: png.originalId, rev: 1 }] } })).status).toBe(410);
  });
});
