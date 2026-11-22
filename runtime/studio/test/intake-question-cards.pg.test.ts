import { createServer } from 'node:http';
import { aroundAll, describe, expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { commandId, factId } from '../../../kernel/src/declarations/ids.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import {
  completeVisionExtraction,
  completeVisionIntakeCommand,
  failedVisionExtraction,
  type IntakeExtraction,
} from '../../../modules/capture/intake-values.ts';
import type { StructuredPaperOcr } from '../../../modules/capture/vision-paper-ocr.ts';
import { handleIntakeRequest, intakeWriteTargets, openIntake, type IntakeMetadata } from '../intake.ts';
import { intakeIdFor } from '../intake-lifecycle.ts';
import { openOrganizer } from '../organizer.ts';
import { openWorkbook } from '../workbook.ts';
import { stableId, studioLearner } from '../identity.ts';
import { loadStudioTestModule } from './modules.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');
const ocr = (wrong: boolean): StructuredPaperOcr => ({
  version: 'vision-paper-ocr-v1', paperTitle: '视觉试卷', subject: '数学', pageNote: null,
  questions: [{ index: 1, number: '1', questionType: 'calculation', stem: '计算 1+1', options: [],
    studentAnswer: { status: 'present', text: '3' },
    redInk: { verdict: wrong ? 'wrong' : 'correct', marks: [], correction: wrong ? '2' : null, score: wrong ? '0' : '1' },
    unclearSegments: [] }],
  freeformText: null, warnings: [],
});

describe.skipIf(!testDatabaseUrl)('intake question cards in PostgreSQL', () => {
  let origin = '', intake: ReturnType<typeof openIntake>, workbook: ReturnType<typeof openWorkbook>, organizer: ReturnType<typeof openOrganizer>, db: Parameters<typeof openIntake>[0];
  aroundAll(run => withLearnerDatabase(studioLearner, async database => {
    db = database;
    const [activity, plan, capture, content] = [
      await loadStudioTestModule('activity'),
      await loadStudioTestModule('plan'),
      await loadStudioTestModule('capture'),
      await loadStudioTestModule('content'),
    ];
    if (!activity || !plan || !capture || !content) throw new Error('missing test module');
    const hooks = { onFactsChanged: async () => {} };
    workbook = openWorkbook(db, activity, { capture });
    intake = openIntake(db, capture, content, hooks, workbook);
    organizer = openOrganizer(db, activity, plan, hooks);
    const server = createServer((request, response) => void handleIntakeRequest(
      intake, request, response, new URL(request.url!, 'http://127.0.0.1').pathname, request.method, undefined, workbook,
    ));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    try { await run(); } finally { await new Promise(resolve => server.close(resolve)); }
  }));

  async function capture(key: string) {
    const form = new FormData();
    form.set('requestId', 'request-' + key); form.set('deletionWatermark', '0');
    form.set('file', new Blob([png], { type: 'image/png' }), key + '.png');
    const response = await fetch(origin + '/api/intake', { method: 'POST', body: form });
    return { response, receipt: await response.json() as IntakeMetadata };
  }

  async function finish(key: string, extraction: IntakeExtraction) {
    const { receipt } = await capture(key), material = factId(receipt.id);
    const before = await intake.metadata(material);
    await createCommandHandler(db, {
      modules: await Promise.all([loadStudioTestModule('capture'), loadStudioTestModule('content')]),
      hooks: { onFactsChanged: async () => {} }, crossModuleWrites: intakeWriteTargets,
    })({
      learner: studioLearner, actor: 'learner', purpose: 'storage', type: completeVisionIntakeCommand,
      id: commandId(stableId('test-complete', key)), input: {
        intakeId: intakeIdFor(material), expectedRev: receipt.revision, expectedMaterialRev: 1, extraction,
      },
    });
    return { receipt: await intake.metadata(material), id: receipt.id, before };
  }

  async function post(id: string, body: unknown, path = 'confirm-drafts') {
    const response = await fetch(`${origin}/api/materials/${id}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { response, body: await response.json() as Record<string, unknown> };
  }

  it('retries failed vision, rejects stale or manual states, and exposes exact card revisions', async () => {
    const failed = await finish('failed', failedVisionExtraction('failed'));
    const retry = await post(failed.id, { requestId: 'retry-failed-0001', expectedRev: failed.receipt.revision, expectedMaterialRev: failed.receipt.revision }, 'retry-vision');
    expect(retry.response.status).toBe(202);
    expect(retry.body).toMatchObject({ intakeStatus: 'queued', canRetryVision: false, revision: failed.receipt.revision + 1 });
    const stale = await post(failed.id, { requestId: 'retry-stale-0001', expectedRev: failed.receipt.revision }, 'retry-vision');
    expect(stale.response.status).toBe(409);
    const corrected = await finish('manual', completeVisionExtraction(ocr(false)));
    await intake.correct({ materialId: corrected.id, expectedRev: corrected.receipt.revision, text: '人工更正', requestId: 'manual-0001' });
    const blocked = await post(corrected.id, { requestId: 'retry-manual', expectedRev: corrected.receipt.revision + 1 }, 'retry-vision');
    expect(blocked.response.status).toBe(409);
  });

  it('confirms workbooks and bank questions with explicit consent and idempotence', async () => {
    const material = await finish('cards', completeVisionExtraction(ocr(true)));
    const bundle = await (await fetch(`${origin}/api/materials/${material.id}/question-cards`)).json() as {
      materialId: string; materialRev: number; intakeRev: number; title: string;
      questionCards: { draftId: string; isRedPenError: boolean }[];
    };
    expect(bundle).toMatchObject({ materialId: material.id, materialRev: 2, intakeRev: 2, title: 'cards' });
    expect(bundle.questionCards[0]).toMatchObject({ draftId: expect.any(String), isRedPenError: true });
    expect(await (await fetch(`${origin}/api/materials/${material.id}`)).json()).toMatchObject({ questionCards: bundle.questionCards });
    const draftId = bundle.questionCards[0]!.draftId;
    const item = { draftId, title: '第 1 题', stem: '计算 1+1', options: [{ label: 'A', text: '1' }] };
    const withoutConsent = await post(material.id, { requestId: 'bank-no-0001', mode: 'bank', expectedMaterialRev: bundle.materialRev, items: [item] });
    expect(withoutConsent.response.status).toBe(400);
    const saved = await post(material.id, { requestId: 'bank-1-00000001', mode: 'bank', confirmedByLearner: true, expectedMaterialRev: bundle.materialRev, purpose: 'storage', items: [item] });
    expect(saved.response.status).toBe(201);
    expect(saved.body).toMatchObject({ kind: 'bank', savedCount: 1, skippedCount: 0, questionIds: [expect.any(String)] });
    const repeated = await post(material.id, { requestId: 'bank-2-00000001', mode: 'bank', confirmedByLearner: true, expectedMaterialRev: bundle.materialRev, purpose: 'storage', items: [item] });
    expect(repeated.body).toMatchObject({ kind: 'bank', savedCount: 0, skippedCount: 1, questionIds: saved.body.questionIds });
    const stale = await post(material.id, { requestId: 'bank-stale-0001', mode: 'bank', confirmedByLearner: true, expectedMaterialRev: bundle.materialRev + 1, items: [item] });
    expect(stale.response.status).toBe(409);
    const paper = await post(material.id, { requestId: 'workbook-00001', mode: 'workbook', items: [draftId] });
    expect(paper.response.status).toBe(201);
    expect(await workbook.get(String(paper.body.paperId))).toMatchObject({ id: paper.body.paperId, title: 'cards（错题复盘）' });
  });

  it('passes red-pen hints into today candidates', async () => {
    const material = await finish('fresh', completeVisionExtraction(ocr(true)));
    const today = await organizer.today(new URLSearchParams());
    const candidate = [...today.alternatives, ...today.items.map(item => item.candidate)]
      .find(item => item.id === `material:${material.id}@2`);
    expect(candidate?.freshMaterial).toMatchObject({ questionCount: 1, redPenErrorCount: 1 });
    expect(candidate?.title).toBe('复盘刚拍《fresh》里的 1 道错题');
  });
});
