import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { commandId, factId, type FactId } from '../../../kernel/src/declarations/ids.ts';
import type { Json } from '../../../kernel/src/declarations/types.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { questionStateId, questionVerificationKey, questionVerificationMethodVersion, questionVerificationType } from '../../../modules/content/question-state.ts';
import { stableId, studioLearner } from '../identity.ts';
import { serve } from '../http.ts';
import { openIqdb } from '../iqdb.ts';
import { openOrganizer } from '../organizer.ts';
import { openTransparency } from '../transparency.ts';
import { openWorkbook } from '../workbook.ts';
import { w3RoutePack } from '../w3-routes.ts';
import { createStudioCommandHooks } from '../command-hooks.ts';
import { loadStudioTestModule } from './modules.ts';

const body = (input: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      probe.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

it.skipIf(!testDatabaseUrl)('W3 host: today campaign/reentry, metacognition, folding, backtrace, adversarial and near-miss verification', { timeout: 60_000 }, () =>
  withLearnerDatabase(studioLearner, async db => {
    const [activity, capture, companion, content, learnerMod, plan] = await Promise.all(
      ['activity', 'capture', 'companion', 'content', 'learner', 'plan'].map(name => loadStudioTestModule(name)),
    );
    const handle = createCommandHandler(db, { modules: [activity!, capture!, companion!, content!, learnerMod!, plan!], hooks: { async onFactsChanged() {} } });
    const send = (type: string, key: string, input: Json, purpose = 'storage') =>
      handle({ learner: studioLearner, actor: 'learner', purpose, id: commandId(stableId('w3-cmd', key)), type, input });

    const noteId = factId(stableId('w3', 'note'));
    await send('activity.organizerCreateNote', 'note', { id: noteId, title: '基础笔记', markdown: '极限与变式', materialId: null }, 'storage');
    await send('activity.setWorkspaceTeaching', 'note-teach', { id: noteId, expectedRev: 1, enabled: true }, 'storage');
    const noteUse = { id: noteId, rev: 1, epoch: '1' };
    const questionAsset = (title: string, prompt: string) => ({
      kind: 'question', title, promptBlockId: 'p',
      blocks: [{ id: 'p', parentId: null, body: { kind: 'text', text: prompt } }],
    });
    const q1 = factId(stableId('w3', 'q1'));
    const q3 = factId(stableId('w3', 'q3'));
    await send('content.saveQuestion', 'q1', { id: q1, purpose: 'teaching', asset: questionAsset('同构原题', '求 lim(x->0) sin(x)/x') }, 'teaching');
    const contractAsset = { ...questionAsset('未曝光同壳变式', '求 lim(x->0) sin(2x)/2x'),
      response_schema: [{ slotId: 'answer', schemaVersion: '1', fields: [{ kind: 'text', path: '' }] }],
      assessment_contract: [{ criterionId: 'result', inputs: [{ slotId: 'answer', path: '' }], maximum: 1, missingEvidence: 'insufficient-evidence', evaluator: { id: 'frozen-value-match', version: '1' }, parameters: { value: '1' } }] };
    await send('content.saveQuestion', 'q3', { id: q3, purpose: 'teaching', asset: contractAsset }, 'teaching');
    const c1 = factId(stableId('w3', 'c1'));
    await send('content.createKnowledgeEntity', 'c1', { id: c1, purpose: 'teaching', entity: { kind: 'concept', canonicalName: '极限', aliases: [], merged_into: null }, resolution: { decision: 'no-match', reason: '新概念', candidates: [], sourceUses: [{ id: noteId, rev: 2, accessEpoch: '1' }] } }, 'teaching');

    const wq1 = factId(stableId('w3', 'wq1'));
    await send('activity.saveWorkspaceEntry', 'wq1', { id: wq1, entry: { kind: 'question', title: '极限练手题', body: '求 lim(x->0) sin(x)/x', answer: '1', tags: [], links: [] }, basis: [{ id: noteId, rev: 2, epoch: '1' }] });
    const wq1Use = { id: wq1, rev: 1, accessEpoch: '0' };
    const epochOf = async (id: string) => (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ access_epoch: string }>('SELECT access_epoch::text FROM facts WHERE learner_id=$1 AND id=$2', [studioLearner, id]))).rows[0]!.access_epoch;
    const q1Use = { id: q1, rev: 1, accessEpoch: await epochOf(q1) };
    const c1Use = { id: c1, rev: 1, accessEpoch: await epochOf(c1) };
    await send('content.createKnowledgeEdge', 'e-q1', { id: factId(stableId('w3', 'e-q1')), purpose: 'teaching', edge: { kind: 'targets_concept', scope: 'calculus', from: { kind: 'question', sourceUse: q1Use }, to: { kind: 'concept', sourceUse: c1Use }, sourceUses: [q1Use, c1Use] } }, 'teaching');
    const q3Epoch = await epochOf(q3);
    await send('content.createKnowledgeEdge', 'e-v', { id: factId(stableId('w3', 'e-v')), purpose: 'teaching', edge: { kind: 'variant_of', scope: '同条件',
      from: { kind: 'question', sourceUse: q1Use }, to: { kind: 'question', sourceUse: { id: q3, rev: 1, accessEpoch: q3Epoch } },
      sourceUses: [q1Use, { id: q3, rev: 1, accessEpoch: q3Epoch }],
      variant: { familyId: q1, relation: 'single_condition', preserved: ['p'], changed: ['c'], spoilsNext: 'none' } } }, 'teaching');

    const paper1 = factId(stableId('w3', 'paper1'));
    const item = { id: 'it1', kind: 'numeric', prompt: '求 lim(x->0) sin(x)/x', answer: 1, tolerance: 0, unit: null, explanation: null, sourceQuestionRef: { id: q1, rev: 1 } };
    await send('activity.saveWorkbookPaper', 'paper1', { id: paper1, data: { title: '小测一', materialId: null, savedAt: '2026-11-25T09:00:00.000Z', questions: [item] } }, 'storage');
    const paper2 = factId(stableId('w3', 'paper2'));
    await send('activity.saveWorkbookPaper', 'paper2', { id: paper2, data: { title: '小测二', materialId: null, savedAt: '2026-11-26T09:00:00.000Z', questions: [{ ...item }] } }, 'storage');
    const att1 = factId(stableId('w3', 'att1'));
    const att2 = factId(stableId('w3', 'att2'));
    const attE = factId(stableId('w3', 'attE'));
    const attT = factId(stableId('w3', 'attT'));
    // 播种正曝光见证：paper1/it1 在 att1 提交前看过解析（solution 步）。
    await db.tx({ learner: studioLearner }, async tx => {
      const exposureId = factId(stableId('w3', 'exposure'));
      const cmdId2 = commandId(stableId('w3', 'exposure-cmd'));
      const data = { kind: 'displayed', mount: { activityId: paper1, issuance: { id: paper1, rev: 1 }, item: { itemId: 'it1' } },
        alsoAppliesTo: [], content: { id: paper1, rev: 1 }, step: { kind: 'solution', order: 1 } };
      await tx.query(`INSERT INTO commands(learner_id,id,type,input,state,tick) VALUES ($1,$2,'activity.recordHelpExposure','{}'::jsonb,'done',1)`, [studioLearner, cmdId2]);
      await tx.query(`INSERT INTO facts(learner_id,id,type,current_rev,access_epoch,purpose,sticky,created_tick,changed_tick) VALUES ($1,$2,'activity.helpExposure',1,0,'{storage}',false,1,1)`, [studioLearner, exposureId]);
      await tx.query(`INSERT INTO fact_revs(learner_id,fact_id,rev,data,purpose,sticky,kind,author,command_id,tick) VALUES ($1,$2,1,$3,'{storage}',false,'value','learner',$4,1)`,
        [studioLearner, exposureId, JSON.stringify(data), cmdId2]);
    });
    await send('activity.submitWorkbookAttempt', 'att1', { id: att1, data: { paperId: paper1, requestId: 'w3-req-att1', submittedAt: '2026-11-25T10:00:00.000Z', answers: { it1: '0' } } }, 'storage');
    await send('activity.submitWorkbookAttempt', 'att2', { id: att2, data: { paperId: paper2, requestId: 'w3-req-att2', submittedAt: '2026-11-26T10:00:00.000Z', answers: { it1: '0' } } }, 'storage');
    await send('activity.submitWorkbookAttempt', 'attE', { id: attE, data: { paperId: paper1, requestId: 'w3-req-attE', submittedAt: '2026-11-26T11:00:00.000Z', answers: { it1: '1' } } }, 'storage');
    await send('activity.setWorkspaceTeaching', 'p2-teach', { id: paper2, expectedRev: 1, enabled: true }, 'storage');
    await send('activity.submitWorkbookAttempt', 'attT', { id: attT, data: { paperId: paper2, requestId: 'w3-req-attT', submittedAt: '2026-11-26T12:00:00.000Z', answers: { it1: '0' } } }, 'teaching');

    // q3 的 release_ready 验收结果（复用 iqdb-storage-visibility 的 SQL 播种路径）。
    const q3Tick = (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ clock: string }>('SELECT clock::text FROM learners WHERE id=$1', [studioLearner]))).rows[0]!.clock;
    const q3StateId = await questionStateId(q3);
    const q3Recheck = (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ data: { recheck: number } }>('SELECT r.data FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev) WHERE f.learner_id=$1 AND f.id=$2', [studioLearner, q3StateId]))).rows[0]!.data.recheck;
    const executions = [1, 2, 3, 4].map(n => ({ kind: 'local_wasm', moduleDigest: String(n).repeat(64), executableDigest: String(n).repeat(64), feeMicroUsd: 0 }));
    await db.tx({ learner: studioLearner }, tx => tx.query(`INSERT INTO derivations(learner_id,id,slot_type,slot_key,deriver,scope_keys,value,lifecycle,freshness,gather_tick,effective_tick,manifest)
      VALUES ($1,$2,$3,$4,'content/question-verification','{}',$5,'effective','current',$7,$7,$6)`, [studioLearner, q3, questionVerificationType, questionVerificationKey({ id: q3, rev: 1, recheck: q3Recheck }), JSON.stringify({ kind: 'value', value: { status: 'ready', basis: { id: q3, rev: 1, accessEpoch: q3Epoch, recheck: q3Recheck, methodVersion: questionVerificationMethodVersion }, invocations: ['i1', 'i2', 'i3', 'i4'], executions, solutions: ['1'] } }), JSON.stringify({ version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: q3Tick, inputs: [{ kind: 'fact', id: q3, rev: 1, accessEpoch: q3Epoch, mode: 'following' }] }), q3Tick]));
    await db.tx({ learner: studioLearner }, tx => tx.query(`INSERT INTO slot_state(learner_id,slot_type,slot_key,current_id,scope_keys) VALUES ($1,$2,$3,$4,'{}') ON CONFLICT (learner_id,slot_type,slot_key) DO UPDATE SET current_id=EXCLUDED.current_id,pending='none',last_error=NULL`, [studioLearner, questionVerificationType, questionVerificationKey({ id: q3, rev: 1, recheck: q3Recheck }), q3]));

    const wb = openWorkbook(db, activity!);
    const injectedProvider = {
      baseUrl: 'http://127.0.0.1:3425/v1', model: 'w3-mock-model', protocol: 'openai' as const, reasoningEffort: 'low', apiKey: '',
      activeProviderId: 'w3-mock', providers: [], mcpServers: [], exaApiKey: '', allowSearch: false,
    };
    const spotPayload = {
      title: '找漏洞', flawedSteps: [{ statement: '第一步代入' }, { statement: '第二步错用连续性' }],
      plausibleConclusion: '结论 1',
      checkpoint: { flawedStepNumber: 2, divergencePoint: '第二步', hiddenTrapReason: '连续性未验证', correctionDirection: '先验证连续性' },
      sourceIds: [q1],
    };
    const transport = async () => ({ content: JSON.stringify(spotPayload) });
    const organizer = openOrganizer(db, activity!, plan!);
    const transparency = openTransparency(db);
    const iqdb = openIqdb(db, false, wb.issueBank, content!, createStudioCommandHooks(), activity!, capture!);
    const pack = w3RoutePack(db, wb.issueBank, { loadProvider: async () => injectedProvider, transport });
    const port = await freePort();
    const server = serve(db, {} as never, {} as never, {} as never, { organizer, transparency, iqdb, routePacks: [pack] } as never, port);
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${port}`;
    const get = async (path: string) => {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    const post = async (path: string, input: unknown) => {
      const res = await fetch(`${base}${path}`, { method: 'POST', ...body(input) });
      return { status: res.status, body: await res.json() as Record<string, unknown>, headers: res.headers };
    };
    try {
      // W3-A1 /api/today：campaignState 键、reentry 键恒存在；未达长假门槛时为 null，达到后透出完整计划。
      const today = await get('/api/today');
      expect(today.status).toBe(200);
      expect(today.body.campaignState).toMatchObject({ phase: expect.any(String) });
      expect(Object.hasOwn(today.body, 'reentry')).toBe(true);
      expect(today.body.reentry).toBeNull();
      expect(today.body.reentryPlan).toMatchObject({ triggered: false });
      const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
      const resumed = await get(`/api/today?lastOpenedAt=${encodeURIComponent(tenDaysAgo)}`);
      expect(resumed.status).toBe(200);
      expect(resumed.body.reentryPlan).toMatchObject({ triggered: true, inactiveDays: 10 });
      expect(resumed.body.reentry).toMatchObject({ triggered: true, inactiveDays: 10 });
      const micro = await get('/api/today?duration=3min');
      expect(micro.status).toBe(200);
      expect(micro.body.campaignState).toMatchObject({ phase: expect.any(String) });

      // W3-A2 /api/memory/overview：元认知三字段齐备。
      const memory = await get('/api/memory/overview');
      expect(memory.status).toBe(200);
      expect(memory.body).toMatchObject({ metacognitiveHabits: expect.any(Array), masteryIllusionAlerts: expect.any(Array), suppressedSingletonsCount: expect.any(Number) });

      // W3-B1 /api/iqdb/questions：archetypeFolding 键存在，全响应绝不泄漏 answer/solution/rubric。
      const questions = await get('/api/iqdb/questions');
      expect(questions.status).toBe(200);
      expect(Object.hasOwn(questions.body, 'archetypeFolding')).toBe(true);
      expect(questions.body.archetypeFolding).toMatchObject({ cards: expect.any(Array), standaloneQuestionIds: expect.any(Array) });
      const leaks: string[] = [];
      const scan = (value: unknown, path: string) => {
        if (Array.isArray(value)) value.forEach((entry, index) => scan(entry, `${path}[${index}]`));
        else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
          if (key === 'answer' || key === 'solution' || key === 'rubric') leaks.push(path ? `${path}.${key}` : key);
          scan(entry, path ? `${path}.${key}` : key);
        }
      };
      scan(questions.body, '');
      expect(leaks).toEqual([]);

      // W3-B2 双通道回溯：same_question 匹配；helpExposure 正曝光与未知隔离；excludeAttemptId 生效；teaching 专属作答不可见。
      const backtrace = await get(`/api/papers/${paper1}/items/it1/backtrace`);
      expect(backtrace.status).toBe(200);
      expect(backtrace.body.target).toMatchObject({ questionId: q1 });
      const mistakes = backtrace.body.similarMistakes as { evidence: { attemptId: string; helpExposure: string }; inference: { matchBasis: string[] } }[];
      expect(mistakes.map(row => row.evidence.attemptId).sort()).toEqual([att1, att2, attT].sort());
      expect(mistakes.find(row => row.evidence.attemptId === att1)?.evidence.helpExposure).toBe('solution_seen');
      expect(mistakes.find(row => row.evidence.attemptId === att2)?.evidence.helpExposure).toBe('unknown');
      expect(mistakes[0]?.inference.matchBasis).toContain('same_question');
      expect(backtrace.body.independentSuccesses).toEqual([]);
      expect(backtrace.body.excludedRevokedCount).toBe(0);
      expect(JSON.stringify(backtrace.body)).not.toContain(attE);
      const excluded = await get(`/api/papers/${paper1}/items/it1/backtrace?attemptId=${att1}`);
      expect(excluded.status).toBe(200);
      const excludedIds = (excluded.body.similarMistakes as { evidence: { attemptId: string } }[]).map(row => row.evidence.attemptId).sort();
      expect(excludedIds).toEqual([att2, attT].sort());
      // 撤回隔离：撤回 attT 后快照层即消失，绝不进入回溯。
      await db.tx({ learner: studioLearner }, tx => tx.query('UPDATE facts SET retracted_rev=current_rev WHERE learner_id=$1 AND id=$2', [studioLearner, attT]));
      const afterRevoke = await get(`/api/papers/${paper1}/items/it1/backtrace`);
      expect(afterRevoke.status).toBe(200);
      const afterIds = (afterRevoke.body.similarMistakes as { evidence: { attemptId: string } }[]).map(row => row.evidence.attemptId).sort();
      expect(afterIds).toEqual([att1, att2].sort());
      expect(JSON.stringify(afterRevoke.body)).not.toContain(attT);
      expect((await get(`/api/papers/${paper1}/items/backtrace-missing/backtrace`)).status).toBe(404);
      expect((await get('/api/papers/0000000000000000000000000Z/items/it1/backtrace')).status).toBe(404);

      // W3-C2 对抗活动：门禁校验、无锚点 fail-closed、注入传输闭环与幂等防重复扣费。
      expect((await post('/api/activities/adversarial', { kind: 'spot_the_flaw' })).status).toBe(400);
      expect((await post('/api/activities/adversarial', { requestId: 'w3-adv-bad-kind', kind: 'bogus' })).status).toBe(400);
      const bridge = await post('/api/activities/adversarial', { requestId: 'w3-adv-bridge', kind: 'mastery_bridge', targetConceptId: c1 });
      expect(bridge.status).toBe(400);
      const spot = await post('/api/activities/adversarial', { requestId: 'w3-adv-spot-1', kind: 'spot_the_flaw', questionId: q1 });
      expect(spot.status).toBe(200);
      expect(spot.body).toMatchObject({ activity: { kind: 'spot_the_flaw', title: '找漏洞', checkpoint: { flawedStepNumber: 2 } } });
      const replay = await post('/api/activities/adversarial', { requestId: 'w3-adv-spot-1', kind: 'spot_the_flaw', questionId: q1 });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ activity: { kind: 'spot_the_flaw' } });
      const conflict = await post('/api/activities/adversarial', { requestId: 'w3-adv-spot-1', kind: 'spot_the_flaw', questionId: q3 });
      expect(conflict.status).toBe(409);
      const missing = await post('/api/activities/adversarial', { requestId: 'w3-adv-missing', kind: 'spot_the_flaw', questionId: '0000000000000000000000000Z' });
      expect([400, 404]).toContain(missing.status);

      // 小能力 8 同壳换数验证：404/403 边界、variant_pool 命中与 201、曝光锁、pool_empty 诚实回退与幂等。
      expect((await post(`/api/papers/${paper1}/items/it1/near-miss-verify`, { kind: 'x' })).status).toBe(400);
      const hit = await post(`/api/papers/${paper1}/items/it1/near-miss-verify`, { requestId: 'w3-nm-hit-001' });
      expect(hit.status).toBe(201);
      expect(hit.body).toMatchObject({ source: 'variant_pool', questionId: q3, paperHref: expect.stringMatching(/^\/papers\//) });
      expect(hit.headers.get('x-deletion-watermark')).toBe('0');
      const issuedPaperId = (hit.body as { paperId: string }).paperId;
      const replayHit = await post(`/api/papers/${paper1}/items/it1/near-miss-verify`, { requestId: 'w3-nm-hit-001' });
      expect(replayHit.status).toBe(201);
      expect((replayHit.body as { paperId: string }).paperId).toBe(issuedPaperId);
      const locked = await post(`/api/papers/${paper1}/items/it1/near-miss-verify`, { requestId: 'w3-nm-locked01' });
      expect(locked.status).toBe(200);
      expect(locked.body).toMatchObject({ source: 'pool_empty', fallback: { action: 'author_mistake_variant', scheduledFollowupHours: 24 } });
      expect((await post('/api/papers/0000000000000000000000000Z/items/it1/near-miss-verify', { requestId: 'w3-nm-missing1' })).status).toBe(404);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }));
