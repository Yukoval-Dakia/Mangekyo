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
    const questionAsset = (title: string, prompt: string) => ({
      kind: 'question', title, promptBlockId: 'p',
      blocks: [{ id: 'p', parentId: null, body: { kind: 'text', text: prompt } }],
    });
    const q1 = factId(stableId('w3', 'q1')), q2 = factId(stableId('w3', 'q2')), q3 = factId(stableId('w3', 'q3')), qAnchor = factId(stableId('w3', 'qAnchor'));
    await send('content.saveQuestion', 'q1', { id: q1, purpose: 'teaching', asset: questionAsset('同构原题', '求 lim(x->0) sin(x)/x') }, 'teaching');
    await send('content.saveQuestion', 'q2', { id: q2, purpose: 'teaching', asset: questionAsset('同概念独立迁移题', '求 lim(x->0) tan(x)/x') }, 'teaching');
    await send('content.saveQuestion', 'qAnchor', { id: qAnchor, purpose: 'teaching', asset: questionAsset('旧稳锚点题', '计算 6/2') }, 'teaching');
    const contractAsset = { ...questionAsset('未曝光同壳变式', '求 lim(x->0) sin(2x)/2x'),
      response_schema: [{ slotId: 'answer', schemaVersion: '1', fields: [{ kind: 'text', path: '' }] }],
      assessment_contract: [{ criterionId: 'result', inputs: [{ slotId: 'answer', path: '' }], maximum: 1, missingEvidence: 'insufficient-evidence', evaluator: { id: 'frozen-value-match', version: '1' }, parameters: { value: '1' } }] };
    await send('content.saveQuestion', 'q3', { id: q3, purpose: 'teaching', asset: contractAsset }, 'teaching');
    const c1 = factId(stableId('w3', 'c1')), cSolid = factId(stableId('w3', 'cSolid'));
    await send('content.createKnowledgeEntity', 'c1', { id: c1, purpose: 'teaching', entity: { kind: 'concept', canonicalName: '极限', aliases: [], merged_into: null }, resolution: { decision: 'no-match', reason: '新概念', candidates: [], sourceUses: [{ id: noteId, rev: 2, accessEpoch: '1' }] } }, 'teaching');
    await send('content.createKnowledgeEntity', 'cSolid', { id: cSolid, purpose: 'teaching', entity: { kind: 'concept', canonicalName: '整数除法', aliases: [], merged_into: null }, resolution: { decision: 'no-match', reason: '旧稳概念', candidates: [], sourceUses: [{ id: noteId, rev: 2, accessEpoch: '1' }] } }, 'teaching');

    const wq1 = factId(stableId('w3', 'wq1'));
    await send('activity.saveWorkspaceEntry', 'wq1', { id: wq1, entry: { kind: 'question', title: '极限练手题', body: '求 lim(x->0) sin(x)/x', answer: '1', tags: [], links: [] }, basis: [{ id: noteId, rev: 2, epoch: '1' }] });
    const epochOf = async (id: string) => (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ access_epoch: string }>('SELECT access_epoch::text FROM facts WHERE learner_id=$1 AND id=$2', [studioLearner, id]))).rows[0]!.access_epoch;
    const q1Use = { id: q1, rev: 1, accessEpoch: await epochOf(q1) };
    const q2Use = { id: q2, rev: 1, accessEpoch: await epochOf(q2) };
    const c1Use = { id: c1, rev: 1, accessEpoch: await epochOf(c1) };
    const qAnchorUse = { id: qAnchor, rev: 1, accessEpoch: await epochOf(qAnchor) };
    const cSolidUse = { id: cSolid, rev: 1, accessEpoch: await epochOf(cSolid) };
    await send('content.createKnowledgeEdge', 'e-q1', { id: factId(stableId('w3', 'e-q1')), purpose: 'teaching', edge: { kind: 'targets_concept', scope: 'calculus', from: { kind: 'question', sourceUse: q1Use }, to: { kind: 'concept', sourceUse: c1Use }, sourceUses: [q1Use, c1Use] } }, 'teaching');
    await send('content.createKnowledgeEdge', 'e-q2', { id: factId(stableId('w3', 'e-q2')), purpose: 'teaching', edge: { kind: 'targets_concept', scope: 'calculus', from: { kind: 'question', sourceUse: q2Use }, to: { kind: 'concept', sourceUse: c1Use }, sourceUses: [q2Use, c1Use] } }, 'teaching');
    await send('content.createKnowledgeEdge', 'e-anchor', { id: factId(stableId('w3', 'e-anchor')), purpose: 'teaching', edge: { kind: 'targets_concept', scope: 'arith', from: { kind: 'question', sourceUse: qAnchorUse }, to: { kind: 'concept', sourceUse: cSolidUse }, sourceUses: [qAnchorUse, cSolidUse] } }, 'teaching');
    const q3Epoch = await epochOf(q3);
    await send('content.createKnowledgeEdge', 'e-v', { id: factId(stableId('w3', 'e-v')), purpose: 'teaching', edge: { kind: 'variant_of', scope: '同条件',
      from: { kind: 'question', sourceUse: q1Use }, to: { kind: 'question', sourceUse: { id: q3, rev: 1, accessEpoch: q3Epoch } },
      sourceUses: [q1Use, { id: q3, rev: 1, accessEpoch: q3Epoch }],
      variant: { familyId: q1, relation: 'single_condition', preserved: ['p'], changed: ['c'], spoilsNext: 'none' } } }, 'teaching');

    const wb = openWorkbook(db, activity!);
    const paper1 = factId(stableId('w3', 'paper1')), paper2 = factId(stableId('w3', 'paper2')), paper3 = factId(stableId('w3', 'paper3'));
    const item = { id: 'it1', kind: 'numeric', prompt: '求 lim(x->0) sin(x)/x', answer: 1, tolerance: 0, unit: null, explanation: null, sourceQuestionRef: { id: q1, rev: 1 } };
    const item2 = { id: 'it2', kind: 'numeric', prompt: '求 lim(x->0) tan(x)/x', answer: 1, tolerance: 0, unit: null, explanation: null, sourceQuestionRef: { id: q2, rev: 1 } };
    const anchorItem = { id: 'itA', kind: 'numeric', prompt: '计算 6/2', answer: 3, tolerance: 0, unit: null, explanation: null, sourceQuestionRef: { id: qAnchor, rev: 1 } };
    await send('activity.saveWorkbookPaper', 'paper1', { id: paper1, data: { title: '小测一', materialId: null, savedAt: '2026-11-25T09:00:00.000Z', questions: [item] } }, 'storage');
    await send('activity.saveWorkbookPaper', 'paper2', { id: paper2, data: { title: '小测二', materialId: null, savedAt: '2026-11-26T09:00:00.000Z', questions: [{ ...item }] } }, 'storage');
    await send('activity.saveWorkbookPaper', 'paper3', { id: paper3, data: { title: '独立验证卷', materialId: null, savedAt: '2026-11-26T09:30:00.000Z', questions: [item2, anchorItem] } }, 'storage');
    const att1 = factId(stableId('w3', 'att1')), att2 = factId(stableId('w3', 'att2')), attE = factId(stableId('w3', 'attE'));
    const attT = factId(stableId('w3', 'attT')), attTeachOnly = factId(stableId('w3', 'attTeachOnly')), attIndep = factId(stableId('w3', 'attIndep')), attAnchor2 = factId(stableId('w3', 'attAnchor2'));
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
    // paper3/it2 记录完整无助呈现见证（permit -> displayed）以产生真实 independentSuccesses。
    const permit = (await wb.recordPresentation(paper3, { kind: 'question', paper: { id: paper3, rev: 1 }, items: ['it2'], phase: 'permit' })) as { permit: string };
    await wb.recordPresentation(paper3, { kind: 'question', paper: { id: paper3, rev: 1 }, items: ['it2'], phase: 'displayed', permit: permit.permit });
    await send('activity.submitWorkbookAttempt', 'att1', { id: att1, data: { paperId: paper1, requestId: 'w3-req-att1', submittedAt: '2026-11-25T10:00:00.000Z', answers: { it1: '0' } } }, 'storage');
    await send('activity.submitWorkbookAttempt', 'att2', { id: att2, data: { paperId: paper2, requestId: 'w3-req-att2', submittedAt: '2026-11-26T10:00:00.000Z', answers: { it1: '0' } } }, 'storage');
    await send('activity.submitWorkbookAttempt', 'attE', { id: attE, data: { paperId: paper1, requestId: 'w3-req-attE', submittedAt: '2026-11-26T11:00:00.000Z', answers: { it1: '1' } } }, 'storage');
    await send('activity.submitWorkbookAttempt', 'attIndep', { id: attIndep, data: { paperId: paper3, requestId: 'w3-req-attIndep', submittedAt: '2026-11-26T11:30:00.000Z', answers: { it2: '1', itA: '3' } } }, 'storage');
    await send('activity.submitWorkbookAttempt', 'attAnchor2', { id: attAnchor2, data: { paperId: paper3, requestId: 'w3-req-attAnchor2', submittedAt: '2026-11-26T11:45:00.000Z', answers: { itA: '3' } } }, 'storage');
    await send('activity.submitWorkbookAttempt', 'attT', { id: attT, data: { paperId: paper2, requestId: 'w3-req-attT', submittedAt: '2026-11-26T12:00:00.000Z', answers: { it1: '0' } } }, 'storage');
    await send('activity.submitWorkbookAttempt', 'attTeachOnly', { id: attTeachOnly, data: { paperId: paper2, requestId: 'w3-req-attTeachOnly', submittedAt: '2026-11-26T12:30:00.000Z', answers: { it1: '0' } } }, 'storage');
    // 将 attTeachOnly 显式收窄为仅 teaching 用途（不含 storage），验证 storage 回溯隔离。
    await db.tx({ learner: studioLearner }, tx => tx.query(`UPDATE facts SET purpose='{teaching}' WHERE learner_id=$1 AND id=$2`, [studioLearner, attTeachOnly]));
    // 授予 paper3 与两次正确作答 teaching 用途，使 cSolid 在 mastery_bridge 中达成 solid (score>=0.85, >=2 次) 锚点。
    await send('activity.setWorkspaceTeaching', 'p3-teach', { id: paper3, expectedRev: 1, enabled: true }, 'storage');
    await send('activity.setWorkspaceTeaching', 'attIndep-teach', { id: attIndep, expectedRev: 1, enabled: true }, 'storage');
    await send('activity.setWorkspaceTeaching', 'attAnchor2-teach', { id: attAnchor2, expectedRev: 1, enabled: true }, 'storage');

    // q3 的 release_ready 验收结果（复用 iqdb-storage-visibility 的 SQL 播种路径）。
    const q3Tick = (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ clock: string }>('SELECT clock::text FROM learners WHERE id=$1', [studioLearner]))).rows[0]!.clock;
    const q3StateId = await questionStateId(q3);
    const q3Recheck = (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ data: { recheck: number } }>('SELECT r.data FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev) WHERE f.learner_id=$1 AND f.id=$2', [studioLearner, q3StateId]))).rows[0]!.data.recheck;
    const executions = [1, 2, 3, 4].map(n => ({ kind: 'local_wasm', moduleDigest: String(n).repeat(64), executableDigest: String(n).repeat(64), feeMicroUsd: 0 }));
    await db.tx({ learner: studioLearner }, tx => tx.query(`INSERT INTO derivations(learner_id,id,slot_type,slot_key,deriver,scope_keys,value,lifecycle,freshness,gather_tick,effective_tick,manifest)
      VALUES ($1,$2,$3,$4,'content/question-verification','{}',$5,'effective','current',$7,$7,$6)`, [studioLearner, q3, questionVerificationType, questionVerificationKey({ id: q3, rev: 1, recheck: q3Recheck }), JSON.stringify({ kind: 'value', value: { status: 'ready', basis: { id: q3, rev: 1, accessEpoch: q3Epoch, recheck: q3Recheck, methodVersion: questionVerificationMethodVersion }, invocations: ['i1', 'i2', 'i3', 'i4'], executions, solutions: ['1'] } }), JSON.stringify({ version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: q3Tick, inputs: [{ kind: 'fact', id: q3, rev: 1, accessEpoch: q3Epoch, mode: 'following' }] }), q3Tick]));
    await db.tx({ learner: studioLearner }, tx => tx.query(`INSERT INTO slot_state(learner_id,slot_type,slot_key,current_id,scope_keys) VALUES ($1,$2,$3,$4,'{}') ON CONFLICT (learner_id,slot_type,slot_key) DO UPDATE SET current_id=EXCLUDED.current_id,pending='none',last_error=NULL`, [studioLearner, questionVerificationType, questionVerificationKey({ id: q3, rev: 1, recheck: q3Recheck }), q3]));

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
    const bridgePayload = {
      anchorId: cSolid, headline: '用除法理解极限比值', bridgeExplanation: '先看整数除法再过渡到极限比值',
      structuralMappings: [{ anchorElement: '被除数', targetElement: '分子', whyItMaps: '同作比值上项' }, { anchorElement: '除数', targetElement: '分母', whyItMaps: '同作比值下项' }],
      analogyLimits: ['分母趋零不能直接代入'], quickCheckPrompt: 'sin(x)/x 在 x=0 处能否直接代入？',
    };
    let providerAvailable = true;
    const transport = async (_url: string, reqBody: string) => ({
      content: JSON.stringify(reqBody.includes('masteredAnchors') ? bridgePayload : spotPayload),
    });
    let isPaused = false;
    const organizer = openOrganizer(db, activity!, plan!, createStudioCommandHooks(), { paused: async () => isPaused });
    const transparency = openTransparency(db);
    const iqdb = openIqdb(db, false, wb.issueBank, content!, createStudioCommandHooks(), activity!, capture!);
    const pack = w3RoutePack(db, wb.issueBank, { loadProvider: async () => (providerAvailable ? injectedProvider : null), transport });
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
      // W3-A1 /api/today：campaignState、reentryPlan 完整输出，reentry 恒为 null 避免压死 ResumeBreadcrumb；受保护锁项不被微过滤误杀；paused 抑制摸底。
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
      expect(resumed.body.reentry).toBeNull();
      // 推迟 concept:<c1>@1 后，reentryPlan 必须尊重该拒绝/推迟规则并计入 filteredRefusedCount，绝不继续推送 c1 摸底。
      const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      await send('plan.saveRule', 'defer-c1', { id: factId(stableId('w3', 'defer-c1')), expectedRev: null, data: { kind: 'defer', activityId: `concept:${c1}@1`, until: nextWeek } }, 'storage');
      const deferredReentry = await get(`/api/today?lastOpenedAt=${encodeURIComponent(tenDaysAgo)}`);
      expect((deferredReentry.body.reentryPlan as { filteredRefusedCount: number }).filteredRefusedCount).toBeGreaterThanOrEqual(1);
      expect(((deferredReentry.body.reentryPlan as { probeItems: { conceptId: string }[] }).probeItems).map(p => p.conceptId)).not.toContain(c1);
      // 锁定一份 12 分钟手写自编卷后使用 duration=3min，该锁定卷必须保留在 protectedItems 中且不产生伪冲突。
      const paperLock = factId(stableId('w3', 'paperLock'));
      const plainQ = (idx: number) => ({ id: `lq${idx}`, kind: 'numeric', prompt: `算 ${idx}+1`, answer: idx + 1, tolerance: 0, unit: null, explanation: null });
      await send('activity.saveWorkbookPaper', 'paperLock', { id: paperLock, data: { title: '锁定手写卷', materialId: null, savedAt: '2026-11-26T08:00:00.000Z', questions: [1, 2, 3, 4].map(plainQ) } }, 'storage');
      await send('plan.saveRule', 'lock-p1', { id: factId(stableId('w3', 'lock-p1')), expectedRev: null, data: { kind: 'lock', date: today.body.day as string, activityId: `${paperLock}@1` } }, 'storage');
      const micro = await get('/api/today?duration=3min');
      expect(micro.status).toBe(200);
      expect((micro.body.protectedItems as { id: string }[]).map(x => x.id)).toContain(`${paperLock}@1`);
      expect((micro.body.conflicts as { constraints: string[] }[]).some(c => c.constraints.includes('锁定材料当前不可打开'))).toBe(false);
      isPaused = true;
      const pausedRes = await get(`/api/today?lastOpenedAt=${encodeURIComponent(tenDaysAgo)}`);
      expect(pausedRes.status).toBe(200);
      expect(pausedRes.body.paused).toBe(true);
      expect(pausedRes.body.reentryPlan).toMatchObject({ triggered: false, probeItems: [] });
      isPaused = false;

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

      // W3-B2 双通道回溯：same_question 匹配；真实无助作答 attIndep 进入 independentSuccesses；看解析的 attE 绝不混入；teaching-only attTeachOnly 被隔离；撤回隔离。
      const backtrace = await get(`/api/papers/${paper1}/items/it1/backtrace`);
      expect(backtrace.status).toBe(200);
      expect(backtrace.body.target).toMatchObject({ questionId: q1 });
      const mistakes = backtrace.body.similarMistakes as { evidence: { attemptId: string; helpExposure: string }; inference: { matchBasis: string[] } }[];
      const successes = backtrace.body.independentSuccesses as { evidence: { attemptId: string; helpExposure: string } }[];
      expect(mistakes.map(row => row.evidence.attemptId).sort()).toEqual([att1, att2, attT].sort());
      expect(mistakes.find(row => row.evidence.attemptId === att1)?.evidence.helpExposure).toBe('solution_seen');
      expect(mistakes.find(row => row.evidence.attemptId === att2)?.evidence.helpExposure).toBe('unknown');
      expect(mistakes[0]?.inference.matchBasis).toContain('same_question');
      expect(successes.map(row => row.evidence.attemptId)).toEqual([attIndep]);
      expect(successes[0]?.evidence.helpExposure).toBe('none');
      expect(JSON.stringify(backtrace.body)).not.toContain(attE);
      expect(JSON.stringify(backtrace.body)).not.toContain(attTeachOnly);
      const excluded = await get(`/api/papers/${paper1}/items/it1/backtrace?attemptId=${att1}`);
      expect((excluded.body.similarMistakes as { evidence: { attemptId: string } }[]).map(row => row.evidence.attemptId).sort()).toEqual([att2, attT].sort());
      await db.tx({ learner: studioLearner }, tx => tx.query('UPDATE facts SET retracted_rev=current_rev WHERE learner_id=$1 AND id=$2', [studioLearner, attT]));
      const afterRevoke = await get(`/api/papers/${paper1}/items/it1/backtrace`);
      expect((afterRevoke.body.similarMistakes as { evidence: { attemptId: string } }[]).map(row => row.evidence.attemptId).sort()).toEqual([att1, att2].sort());
      expect((await get(`/api/papers/${paper1}/items/backtrace-missing/backtrace`)).status).toBe(404);
      expect((await get('/api/papers/0000000000000000000000000Z/items/it1/backtrace')).status).toBe(404);

      // W3-C2 对抗活动：无模型 503、锚点 >= 0.8 正向成功、无锚点 400、同 requestId 跨 kind 与跨 stickingPoint 冲突 409。
      expect((await post('/api/activities/adversarial', { kind: 'spot_the_flaw' })).status).toBe(400);
      expect((await post('/api/activities/adversarial', { requestId: 'w3-adv-bad-kind', kind: 'bogus' })).status).toBe(400);
      providerAvailable = false;
      expect((await post('/api/activities/adversarial', { requestId: 'w3-adv-noprov', kind: 'spot_the_flaw', questionId: q1 })).status).toBe(503);
      providerAvailable = true;
      const bridgeOk = await post('/api/activities/adversarial', { requestId: 'w3-adv-bridge-ok', kind: 'mastery_bridge', targetConceptId: c1, learnerStickingPoint: '不懂极限比值' });
      expect(bridgeOk.status).toBe(200);
      expect(bridgeOk.body).toMatchObject({ analogy: { kind: 'mastery_bridge', anchorId: cSolid } });
      expect((await post('/api/activities/adversarial', { requestId: 'w3-adv-bridge-ok', kind: 'mastery_bridge', targetConceptId: c1, learnerStickingPoint: '改了卡点' })).status).toBe(409);
      // 目标为自身 cSolid 时无其他 >=0.8 锚点，fail-closed 400。
      expect((await post('/api/activities/adversarial', { requestId: 'w3-adv-bridge-none', kind: 'mastery_bridge', targetConceptId: cSolid })).status).toBe(400);
      const spot = await post('/api/activities/adversarial', { requestId: 'w3-adv-spot-1', kind: 'spot_the_flaw', questionId: q1 });
      expect(spot.status).toBe(200);
      expect(spot.body).toMatchObject({ activity: { kind: 'spot_the_flaw', title: '找漏洞', checkpoint: { flawedStepNumber: 2 } } });
      const replay = await post('/api/activities/adversarial', { requestId: 'w3-adv-spot-1', kind: 'spot_the_flaw', questionId: q1 });
      expect(replay.status).toBe(200);
      expect((await post('/api/activities/adversarial', { requestId: 'w3-adv-spot-1', kind: 'mastery_bridge', targetConceptId: c1 })).status).toBe(409);
      expect((await post('/api/activities/adversarial', { requestId: 'w3-adv-spot-1', kind: 'spot_the_flaw', questionId: q3 })).status).toBe(409);
      expect([400, 404]).toContain((await post('/api/activities/adversarial', { requestId: 'w3-adv-missing', kind: 'spot_the_flaw', questionId: '0000000000000000000000000Z' })).status);

      // 小能力 8 同壳换数验证：单锁发卷、同 requestId 重放、跨 (paperId,itemId) 409、缺失卷 404、水位冲突 409、曝光锁与撤回源题重放 403。
      expect((await post(`/api/papers/${paper1}/items/it1/near-miss-verify`, { kind: 'x' })).status).toBe(400);
      const hit = await post(`/api/papers/${paper1}/items/it1/near-miss-verify`, { requestId: 'w3-nm-hit-001' });
      expect(hit.status).toBe(201);
      expect(hit.body).toMatchObject({ source: 'variant_pool', questionId: q3, paperHref: expect.stringMatching(/^\/papers\//) });
      expect(hit.headers.get('x-deletion-watermark')).toBe('0');
      const issuedPaperId = (hit.body as { paperId: string }).paperId;
      const replayHit = await post(`/api/papers/${paper1}/items/it1/near-miss-verify`, { requestId: 'w3-nm-hit-001' });
      expect(replayHit.status).toBe(201);
      expect((replayHit.body as { paperId: string }).paperId).toBe(issuedPaperId);
      expect((await post(`/api/papers/${paper2}/items/it1/near-miss-verify`, { requestId: 'w3-nm-hit-001' })).status).toBe(409);
      expect((await post('/api/papers/0000000000000000000000000Z/items/it1/near-miss-verify', { requestId: 'w3-nm-hit-001' })).status).toBe(404);
      expect((await post(`/api/papers/${paper1}/items/it1/near-miss-verify`, { requestId: 'w3-nm-hit-001', deletionWatermark: '999' })).status).toBe(409);
      const locked = await post(`/api/papers/${paper1}/items/it1/near-miss-verify`, { requestId: 'w3-nm-locked01' });
      expect(locked.status).toBe(200);
      expect(locked.body).toMatchObject({ source: 'pool_empty', fallback: { action: 'author_mistake_variant', scheduledFollowupHours: 24 } });
      expect((await post(`/api/papers/${paper1}/items/it1/near-miss-verify`, { requestId: 'w3-nm-locked01', deletionWatermark: '999' })).status).toBe(409);
      // 撤回 q3 后，旧发出的题库卷重放与回溯均须 fail-closed 返回 403。
      await db.tx({ learner: studioLearner }, tx => tx.query('UPDATE facts SET retracted_rev=current_rev WHERE learner_id=$1 AND id=$2', [studioLearner, q3]));
      expect((await post(`/api/papers/${paper1}/items/it1/near-miss-verify`, { requestId: 'w3-nm-hit-001' })).status).toBe(403);
      expect((await get(`/api/papers/${issuedPaperId}/items/q1/backtrace`)).status).toBe(403);
      // 撤回 q1 后，attemptId 不得借内嵌副本外发已撤回题干。
      await db.tx({ learner: studioLearner }, tx => tx.query('UPDATE facts SET retracted_rev=current_rev WHERE learner_id=$1 AND id=$2', [studioLearner, q1]));
      await send('activity.setWorkspaceTeaching', 'att1-teach', { id: att1, expectedRev: 1, enabled: true }, 'storage');
      expect((await post('/api/activities/adversarial', { requestId: 'w3-adv-revoked-att', kind: 'spot_the_flaw', attemptId: att1 })).status).toBe(404);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }));
