import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { commandId, factId } from '../../../kernel/src/declarations/ids.ts';
import type { Json } from '../../../kernel/src/declarations/types.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { stableId, studioLearner } from '../identity.ts';
import { serve } from '../http.ts';
import { w4RoutePack } from '../w4-routes.ts';
import { openCarePause } from '../care-pause.ts';
import { openKnowledgeMaintenance } from '../research-maintenance.ts';
import { runLivingMineMaintenanceAddons } from '../../../modules/companion/living-mine-host.ts';
import { buildAuthoredTextbookCommands } from '../../../modules/content/textbook-authoring.ts';
import { loadStudioTestModule } from './modules.ts';

const body = (input: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject).listen(0, '127.0.0.1', () => {
    const addr = probe.address();
    probe.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
  });
});

it.skipIf(!testDatabaseUrl)('W4 host: gardening inbox/actions/undo, living-mine radar, playbook effectiveness, foreground yield', { timeout: 120_000 }, () =>
  withLearnerDatabase(studioLearner, async db => {
    const names = ['activity', 'capture', 'companion', 'content', 'learner', 'plan'] as const;
    const mods = Object.fromEntries(await Promise.all(names.map(async n => [n, await loadStudioTestModule(n)])));
    const handle = createCommandHandler(db, { modules: Object.values(mods) as never, hooks: { async onFactsChanged() {} } });
    const send = (type: string, key: string, input: Json, actor: 'learner' | 'companion' = 'learner') =>
      handle({ learner: studioLearner, actor, purpose: 'storage', id: commandId(stableId('w4-seed', key)), type, input });
    const carePause = openCarePause(db, mods.companion!);
    let agentCalls = 0;
    const maintenance = openKnowledgeMaintenance(db, {
      content: mods.content!, activity: mods.activity!, carePause, retentionDays: 0,
      agent: async () => { agentCalls += 1; return { proposal: { shouldAct: true, rationale: 't', suggestedEdges: [], suggestedSummaryUpdates: [] }, usage: { model: 'm', durationMs: 1 } }; },
      loadProvider: async () => ({ baseUrl: 'http://127.0.0.1:3425/v1', model: 'mock', protocol: 'openai', reasoningEffort: 'low', apiKey: '', activeProviderId: 'mock', providers: [], mcpServers: [], exaApiKey: '', allowSearch: false }) as never,
    });
    const port = await freePort();
    const server = serve(db, {} as never, {} as never, {} as never,
      { carePause, routePacks: [w4RoutePack(db, { carePause, content: mods.content!, learner: mods.learner! })] } as never, port);
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    const api = async (method: string, path: string, payload?: unknown, extraHeaders: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, payload === undefined
        ? { method, headers: extraHeaders }
        : { method, headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(payload) });
      return { status: res.status, watermark: res.headers.get('x-deletion-watermark'), body: await res.json().catch(() => null) as any };
    };
    const epochOf = async (id: string) =>
      (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ access_epoch: string }>(
        'SELECT access_epoch::text FROM facts WHERE learner_id=$1 AND id=$2', [studioLearner, id]))).rows[0]!.access_epoch;
    const readCurrent = async (id: string) => (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ rev: number; data: any; author: string }>(
      `SELECT f.current_rev AS rev, r.data, r.author FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
       WHERE f.learner_id=$1 AND f.id=$2`, [studioLearner, id]))).rows[0];
    try {
      const nid = factId(stableId('w4', 'witness'));
      await send('activity.organizerCreateNote', 'witness', { id: nid, title: '见证笔记', markdown: '见证', materialId: null });
      // 反思见证要求 teaching + background-research 双重获准用途。
      await db.tx({ learner: studioLearner }, async tx => {
        await tx.query(`UPDATE facts SET purpose = '{storage,teaching,background-research}' WHERE learner_id=$1 AND id=$2`, [studioLearner, nid]);
        await tx.query(`UPDATE fact_revs SET purpose = '{storage,teaching,background-research}' WHERE learner_id=$1 AND fact_id=$2`, [studioLearner, nid]);
      });
      const witnessUse = { id: nid, rev: 1, accessEpoch: await epochOf(nid) };
      const concept = (key: string, name: string) => send('content.createKnowledgeEntity', key, {
        id: factId(stableId('w4', key)), purpose: 'storage',
        entity: { kind: 'concept', canonicalName: name, aliases: [], merged_into: null },
        resolution: { decision: 'no-match', reason: '新概念', candidates: [], sourceUses: [witnessUse] },
      });
      const c1 = factId(stableId('w4', 'c1')), c2 = factId(stableId('w4', 'c2')), cS = factId(stableId('w4', 'cSticky'));
      const cP = factId(stableId('w4', 'cPeer')), cGone = factId(stableId('w4', 'cGone')), c5 = factId(stableId('w4', 'c5'));
      const cD1 = factId(stableId('w4', 'cD1')), cD2 = factId(stableId('w4', 'cD2'));
      // Duplicate concepts cannot be created through commands (name index rejects them): seed them directly.
      await db.tx({ learner: studioLearner }, async tx => {
        for (const [id, title, sticky] of [[c1, '极限', false], [c2, '极限', false], [cS, '无穷小', true], [cP, '无穷小', false], [cD1, '导数', false], [cD2, '导数', false]] as const) {
          await tx.query(`INSERT INTO facts (learner_id, id, type, current_rev, access_epoch, purpose, sticky, created_tick, changed_tick)
            VALUES ($1,$2,'content.asset',1,0,'{storage}',$3,1,1)`, [studioLearner, id, sticky]);
          await tx.query(`INSERT INTO fact_revs (learner_id, fact_id, rev, data, purpose, sticky, kind, author, command_id, tick)
            VALUES ($1,$2,1,$3,'{storage}',$4,'value','learner','seed',1)`,
            [studioLearner, id, JSON.stringify({ kind: 'concept', title, aliases: [], merged_into: null, blocks: [], basis: [] }), sticky]);
        }
      });
      await concept('cGone', '临时概念'); await concept('c5', '压缩目标概念');
      const questionAsset = (title: string) => ({ kind: 'question', title, promptBlockId: 'p',
        blocks: [{ id: 'p', parentId: null, body: { kind: 'text', text: title } }] });
      const qS = factId(stableId('w4', 'qStale')), qEmpty = factId(stableId('w4', 'qEmpty')), tbStale = factId(stableId('w4', 'tbStale'));
      const qUsed = factId(stableId('w4', 'qUsed')), usedPaper = factId(stableId('w4', 'usedPaper'));
      await send('content.saveQuestion', 'qStale', { id: qS, asset: questionAsset('闲置草稿题') });
      await send('content.saveQuestion', 'qUsed', { id: qUsed, asset: questionAsset('已出卷作答草稿题') });
      await send('content.saveQuestion', 'qEmpty', { id: qEmpty, asset: questionAsset('悬空引用载题') });
      await send('content.createTextbookPage', 'tbStale', { id: tbStale, clientEditSeq: 1, purpose: ['storage'],
        page: { title: '闲置伴生草稿页', blocks: [{ id: 'b1', parentId: null, body: { kind: 'text', text: '草稿' } }], tags: ['studio:companion-generated'] } }, 'companion');
      // 过期草稿以写入时钟回拨表达；qUsed 被真实试卷引用，绝不可进入 staleUnusedDrafts（P0-1）。
      await db.tx({ learner: studioLearner }, async tx => {
        await tx.query(`INSERT INTO facts (learner_id, id, type, current_rev, access_epoch, purpose, sticky, created_tick, changed_tick)
          VALUES ($1,$2,'activity.workbookPaper',1,0,'{storage}',false,1,1)`, [studioLearner, usedPaper]);
        await tx.query(`INSERT INTO fact_revs (learner_id, fact_id, rev, data, purpose, sticky, kind, author, command_id, tick)
          VALUES ($1,$2,1,$3,'{storage}',false,'value','learner','seed',1)`,
          [studioLearner, usedPaper, JSON.stringify({ title: '测试卷', questions: [{ id: 'it1', sourceQuestionRef: { id: qUsed, rev: 1 } }] })]);
        await tx.query('UPDATE learners SET clock = clock + $2 WHERE id = $1', [studioLearner, 24 * 90 + 10]);
        await tx.query('UPDATE facts SET changed_tick = 1, created_tick = 1 WHERE learner_id=$1 AND id=ANY($2::text[])', [studioLearner, [qS, qUsed, tbStale]]);
      });
      const qUse = async (id: string) => ({ id, rev: 1, accessEpoch: await epochOf(id) });
      const eMiss = factId(stableId('w4', 'eMiss'));
      const [emptyUse, goneUse] = await Promise.all([qUse(qEmpty), qUse(cGone)]);
      await send('content.createKnowledgeEdge', 'eMiss', { id: eMiss, purpose: 'storage', edge: {
        kind: 'targets_concept', scope: 't', from: { kind: 'question', sourceUse: emptyUse },
        to: { kind: 'concept', sourceUse: goneUse }, sourceUses: [emptyUse, goneUse] } });
      await db.tx({ learner: studioLearner }, tx => tx.query('UPDATE facts SET retracted_rev=current_rev WHERE learner_id=$1 AND id=$2', [studioLearner, cGone]));
      const secret = factId(stableId('w4', 'secretEntity'));
      await concept('secretEntity', '撤权保密概念');
      await db.tx({ learner: studioLearner }, tx => tx.query(
        `UPDATE facts SET purpose=ARRAY['teaching'] WHERE learner_id=$1 AND id=$2`, [studioLearner, secret]));
      for (const key of ['n1', 'n2', 'n3'])
        await send('activity.organizerCreateNote', key, { id: factId(stableId('w4', key)), title: `避坑${key}`, markdown: `踩坑细节${key}`, materialId: null });
      await db.tx({ learner: studioLearner }, async tx => {
        for (const key of ['n1', 'n2', 'n3']) await tx.query(
          `UPDATE fact_revs SET data = jsonb_set(data, '{source}', $3::jsonb) WHERE learner_id=$1 AND fact_id=$2 AND rev=1`,
          [studioLearner, factId(stableId('w4', key)), JSON.stringify({ id: c5, title: '压缩目标概念' })]);
      });

      // GET: plan shape with yellow duplicates/emergency/dangling, green archive, red sticky/user guards, no leaked secret.
      const inbox0 = await api('GET', '/api/kb/gardening');
      expect(inbox0.status).toBe(200);
      const plan0 = inbox0.body;
      expect(plan0.radar.duplicateConcepts.length).toBeGreaterThanOrEqual(2);
      expect(plan0.radar.compressionCandidates.some((c: any) => c.targetId === c5)).toBe(true);
      expect(plan0.radar.danglingReferences.some((d: any) => d.targetId === cGone && d.reason === 'revoked')).toBe(true);
      const pendingGreenQ = plan0.green.find((g: any) => g.actionId === `green:archive_draft:question:${qS}`);
      expect(pendingGreenQ).toBeTruthy();
      expect(pendingGreenQ.undo_token).toBe(''); // P1-4: 未执行绿灯不暴露假 undo_token
      expect(plan0.green.some((g: any) => g.actionId === `green:archive_draft:question:${qUsed}`)).toBe(false); // P0-1: 已出卷草稿不误归档
      expect(plan0.red.some((r: any) => r.assetId === cS && r.rule === 'sticky_protected')).toBe(true);
      const serialized = JSON.stringify(plan0);
      expect(serialized.includes('撤权保密概念')).toBe(false);
      // 已撤权实体的标题与 ID 均不得泄漏到 HTTP 响应。
      expect(serialized.includes(secret)).toBe(false);
      expect(plan0.radar.excludedCount).toBeGreaterThanOrEqual(2);
      const dupPair = plan0.yellow.filter((y: any) => y.proposalKind === 'merge_duplicate_concepts')
        .find((y: any) => y.targetIds.includes(c1) && y.targetIds.includes(c2));
      expect(dupPair).toBeTruthy();
      expect(plan0.yellow.some((y: any) => y.proposalKind === 'propose_emergency_card')).toBe(true);
      const emergencyYellow = plan0.yellow.find((y: any) => y.proposalKind === 'propose_emergency_card');
      expect(plan0.yellow.some((y: any) => y.proposalKind === 'merge_duplicate_concepts' && (y.targetIds.includes(cS) || y.targetIds.includes(cP)))).toBe(false);

      // accept merge: real merged_into redirect lands through content.evolveGraph.
      const mergeAccept = await api('POST', '/api/kb/gardening/actions', {
        requestId: 'w4-merge-1x', action: 'accept', proposalId: dupPair.proposalId,
        proposalKind: dupPair.proposalKind, targetIds: dupPair.targetIds });
      expect(mergeAccept.status).toBe(200);
      const mergeId = dupPair.detail.mergeEntityId, keepId = dupPair.detail.keepEntityId;
      expect((await readCurrent(mergeId))!.data.merged_into).toBe(keepId);
      // Idempotent replay with the identical payload returns the stored receipt; a different payload conflicts.
      expect((await api('POST', '/api/kb/gardening/actions', {
        requestId: 'w4-merge-1x', action: 'accept', proposalId: dupPair.proposalId,
        proposalKind: dupPair.proposalKind, targetIds: dupPair.targetIds })).status).toBe(200);
      expect((await api('POST', '/api/kb/gardening/actions', {
        requestId: 'w4-merge-1x', action: 'dismiss', proposalId: dupPair.proposalId })).body?.code).toBe('duplicate_request_conflict');
      expect((await api('POST', '/api/kb/gardening/actions', {
        requestId: 'w4-wm-1a', action: 'dismiss', proposalId: 'yellow:never', deletionWatermark: '999999' })).status).toBe(409);

      // emergency card accept: append-only companion page, original material untouched, then undo it back.
      const emergencyAccept = await api('POST', '/api/kb/gardening/actions', {
        requestId: 'w4-em-1x', action: 'accept', proposalId: emergencyYellow.proposalId,
        proposalKind: emergencyYellow.proposalKind, targetIds: emergencyYellow.targetIds });
      expect(emergencyAccept.status).toBe(200);
      const inbox1 = await api('GET', '/api/kb/gardening');
      const emergencyGreen = inbox1.body.green.find((g: any) => String(g.actionId).startsWith('green:emergency_card:'));
      expect(emergencyGreen).toBeTruthy();
      const pageRow = await readCurrent(emergencyGreen.targetId);
      expect(pageRow?.data.title).toContain('急救卡');
      expect(pageRow?.author).toBe('companion');
      expect(inbox1.body.yellow.some((y: any) => y.proposalId === emergencyYellow.proposalId)).toBe(false);

      // apply_green archive of the stale draft question, then undo by token; wrong token/second undo are refused.
      const greenAction = plan0.green.find((g: any) => g.actionId === `green:archive_draft:question:${qS}`);
      const applyGreen = await api('POST', '/api/kb/gardening/actions', {
        requestId: 'w4-green-1x', action: 'apply_green', actionId: greenAction.actionId });
      expect(applyGreen.status).toBe(200);
      const inbox2 = await api('GET', '/api/kb/gardening');
      const executed = inbox2.body.green.find((g: any) => g.actionId === greenAction.actionId);
      expect(executed.undo_token).toBeTruthy();
      // 执行元数据留痕：唯一 step_key 允许 执行 -> 撤回 -> 再执行 -> 再撤回（P0-2）。
      const greenMeta = (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ result: any }>(
        `SELECT result FROM effects WHERE learner_id=$1 AND step_key=$2 AND label='kb-gardening-green'`,
        [studioLearner, `green:w4-green-1x:${greenAction.actionId}`]))).rows[0]?.result;
      expect(greenMeta?.newRev).toBeGreaterThanOrEqual(1);
      expect((greenMeta?.commandIds ?? []).length).toBeGreaterThanOrEqual(1);
      const questionState = async () => (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ data: any }>(
        `SELECT r.data FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
         WHERE f.learner_id=$1 AND f.type='content.questionState' AND r.data->>'questionId'=$2`, [studioLearner, qS]))).rows[0]?.data;
      expect((await questionState())?.restrictions.length).toBe(1);
      const undo = await api('POST', '/api/kb/gardening/undo', {
        requestId: 'w4-undo-1x', actionId: greenAction.actionId, undo_token: executed.undo_token });
      expect(undo.status).toBe(200);
      expect(undo.body).toMatchObject({ status: 'undone', actionId: greenAction.actionId });
      expect((await questionState())?.restrictions.length).toBe(0);
      expect((await api('POST', '/api/kb/gardening/undo', {
        requestId: 'w4-undo-2x', actionId: greenAction.actionId, undo_token: 'undo:wrong' })).status).toBe(404);
      expect((await api('POST', '/api/kb/gardening/undo', {
        requestId: 'w4-undo-3x', actionId: greenAction.actionId, undo_token: executed.undo_token })).status).toBe(409);
      // 二次执行同一绿灯动作并二次撤回（P0-2）。
      expect((await api('POST', '/api/kb/gardening/actions', { requestId: 'w4-green-2x', action: 'apply_green', actionId: greenAction.actionId })).status).toBe(200);
      const executed2 = (await api('GET', '/api/kb/gardening')).body.green.find((g: any) => g.actionId === greenAction.actionId);
      expect(executed2.undo_token).toBeTruthy();
      expect(executed2.undo_token).not.toBe(executed.undo_token);
      expect((await api('POST', '/api/kb/gardening/undo', { requestId: 'w4-undo-4x', actionId: greenAction.actionId, undo_token: executed2.undo_token })).status).toBe(200);
      expect((await questionState())?.restrictions.length).toBe(0);
      // 伴生教材草稿归档 -> 撤权隐身与撤回拦截（P0-3）-> 恢复权限后撤回还原 archived=false。
      const tbActionId = `green:archive_draft:textbook_page:${tbStale}`;
      expect((await api('POST', '/api/kb/gardening/actions', { requestId: 'w4-tb-arch-1', action: 'apply_green', actionId: tbActionId })).status).toBe(200);
      expect((await readCurrent(tbStale))?.data.archived).toBe(true);
      const tbGreen = (await api('GET', '/api/kb/gardening')).body.green.find((g: any) => g.actionId === tbActionId);
      await db.tx({ learner: studioLearner }, tx => tx.query(`UPDATE facts SET purpose=ARRAY['teaching'] WHERE learner_id=$1 AND id=$2`, [studioLearner, tbStale]));
      expect(JSON.stringify((await api('GET', '/api/kb/gardening')).body).includes('闲置伴生草稿页')).toBe(false);
      expect((await api('POST', '/api/kb/gardening/undo', { requestId: 'w4-tb-undo-denied', actionId: tbActionId, undo_token: tbGreen.undo_token })).status).toBe(403);
      await db.tx({ learner: studioLearner }, tx => tx.query(`UPDATE facts SET purpose=ARRAY['storage'] WHERE learner_id=$1 AND id=$2`, [studioLearner, tbStale]));
      expect((await api('POST', '/api/kb/gardening/undo', { requestId: 'w4-tb-undo-1', actionId: tbActionId, undo_token: tbGreen.undo_token })).status).toBe(200);
      expect((await readCurrent(tbStale))?.data.archived).toBeFalsy();

      // batch dismiss of the two remaining merge/emergency-independent yellows; an invalid item rolls the batch back.
      const inbox3 = await api('GET', '/api/kb/gardening');
      const remaining = inbox3.body.yellow;
      expect(remaining.length).toBeGreaterThanOrEqual(2);
      const bad = await api('POST', '/api/kb/gardening/actions', {
        requestId: 'w4-batch-bad', batch: true, action: 'dismiss',
        proposals: [
          { proposalId: remaining[0].proposalId, proposalKind: remaining[0].proposalKind, targetIds: remaining[0].targetIds },
          { proposalId: 'yellow:bogus', proposalKind: 'merge_duplicate_concepts', targetIds: [] }] });
      expect(bad.status).toBe(404);
      expect((await api('GET', '/api/kb/gardening')).body.yellow.some((y: any) => y.proposalId === remaining[0].proposalId)).toBe(true);
      const good = await api('POST', '/api/kb/gardening/actions', {
        requestId: 'w4-batch-ok', batch: true, action: 'dismiss',
        proposals: remaining.slice(0, 2).map((y: any) => ({ proposalId: y.proposalId, proposalKind: y.proposalKind, targetIds: y.targetIds })) });
      expect(good.status).toBe(200);
      expect((await api('GET', '/api/kb/gardening')).body.yellow
        .some((y: any) => y.proposalId === remaining[0].proposalId || y.proposalId === remaining[1].proposalId)).toBe(false);
      // accept of a sticky-protected merge pair is strictly refused with 403 red_guardrail (P2-3).
      const redHit = await api('POST', '/api/kb/gardening/actions', { requestId: 'w4-red-1', action: 'accept',
        proposalId: `yellow:merge:${[cS, cP].sort().join('::')}`, proposalKind: 'merge_duplicate_concepts', targetIds: [cS, cP].sort() });
      expect(redHit.status).toBe(403);
      expect(redHit.body?.code).toBe('red_guardrail');

      // radar: supply_shortages reports 0-question concept (P1-5), pending work triggers foregroundActive (P2-1), care-pause zeroes.
      const radar1 = await api('GET', '/api/research/radar');
      expect(radar1.status).toBe(200);
      expect(radar1.body.maintenanceBudgetCapRatio).toBeLessThanOrEqual(0.2);
      expect(radar1.body.foregroundActive).toBe(false);
      expect(radar1.body.warmBackfillBatch.budgetShare).toBeLessThanOrEqual(0.2);
      expect(radar1.body.radar.metrics.supply_shortages.count).toBeGreaterThanOrEqual(1);
      await db.tx({ learner: studioLearner }, async tx => {
        await tx.query(`INSERT INTO slot_state (learner_id, slot_type, slot_key, scope_keys) VALUES ($1,'activity.teachingFeedback','fg','{}')`, [studioLearner]);
        await tx.query(`INSERT INTO work (learner_id, id, slot_type, slot_key, deriver, state, execution_ref) VALUES ($1,'wfg1','activity.teachingFeedback','fg','activity/test','pending','exfg1')`, [studioLearner]);
      });
      const radar2 = await api('GET', '/api/research/radar');
      expect(radar2.body.foregroundActive).toBe(true);
      expect(radar2.body.warmBackfillBatch.selected).toEqual([]);
      expect(radar2.body.warmBackfillBatch.blockedReason).toBe('foreground_active');
      expect(await maintenance.run({ force: false, now: () => new Date() })).toMatchObject({ ran: false, reason: 'yielded_to_foreground' });
      expect(agentCalls).toBe(0);
      await carePause.pause('test', Date.now());
      const radar3 = await api('GET', '/api/research/radar');
      expect(radar3.body.radar.carePaused).toBe(true);
      expect(radar3.body.radar.totalActionableCount).toBe(0);
      await carePause.resume();
      await db.tx({ learner: studioLearner }, tx => tx.query('DELETE FROM work WHERE learner_id=$1', [studioLearner]));

      // playbook effectiveness: positive lift verifies, negative lift proposes retirement, sticky blocks retirement.
      const pbPos = factId(stableId('w4', 'pbPos')), pbNeg = factId(stableId('w4', 'pbNeg')), pbSticky = factId(stableId('w4', 'pbSticky'));
      const playbookData = (strategy: string) => ({ version: 1, strategyId: strategy, preconditions: ['前置'],
        strategy_steps: [strategy], counterexamples: [], exit_conditions: ['退出'],
        reflection: { rationale: '依据', metric: '指标', evidence_refs: [witnessUse] } });
      await db.tx({ learner: studioLearner }, async tx => {
        for (const [pb, strategy, verdict, eligible] of [
          [pbPos, '正向策略', 'positive', 8], [pbNeg, '负向策略', 'negative', 8], [pbSticky, '置顶负向', 'negative', 8]] as const) {
          await tx.query(`INSERT INTO facts (learner_id, id, type, current_rev, access_epoch, purpose, sticky, created_tick, changed_tick)
            VALUES ($1,$2,'learner.playbook',1,0,'{storage,background-research,teaching}',$3,1,1)`, [studioLearner, pb, pb === pbSticky]);
          await tx.query(`INSERT INTO fact_revs (learner_id, fact_id, rev, data, purpose, sticky, kind, author, command_id, tick)
            VALUES ($1,$2,1,$3,'{storage,background-research,teaching}',$4,'value','companion','seed',1)`, [studioLearner, pb, JSON.stringify(playbookData(strategy)), pb === pbSticky]);
          const liftId = stableId('w4', 'lift', strategy);
          const liftValue = { kind: 'value', value: { playbookId: pb, version: 1, strategyId: strategy, verdict,
            pairedMean: verdict === 'positive' ? 0.4 : -0.4, interval: [0.1, 0.7], eligible, unresolved: 0, pending: 0,
            verificationRefs: [witnessUse] } };
          await tx.query(`INSERT INTO derivations (learner_id, id, slot_type, slot_key, deriver, scope_keys, value, lifecycle, freshness, gather_tick, effective_tick, manifest)
            VALUES ($1,$2,'learner.interventionLift',$3,'learner/intervention-lift@1','{}',$4,'effective','current',1,1,'{}')`,
            [studioLearner, liftId, JSON.stringify([pb, 1]), JSON.stringify(liftValue)]);
          await tx.query(`INSERT INTO slot_state (learner_id, slot_type, slot_key, current_id, scope_keys) VALUES ($1,'learner.interventionLift',$2,$3,'{}')
            ON CONFLICT (learner_id, slot_type, slot_key) DO UPDATE SET current_id=$3`,
            [studioLearner, JSON.stringify([pb, 1]), liftId]);
        }
      });
      const eff = await api('GET', '/api/research/playbooks/effectiveness');
      expect(eff.status).toBe(200);
      expect(eff.body.carePaused).toBe(false);
      expect(eff.body.verifiedPlaybooks.some((p: any) => p.playbookId === pbPos)).toBe(true);
      const demotedNeg = eff.body.demotedStrategies.find((p: any) => p.playbookId === pbNeg);
      expect(demotedNeg?.gardeningProposal).toBeTruthy();
      const demotedSticky = eff.body.demotedStrategies.find((p: any) => p.playbookId === pbSticky);
      expect(demotedSticky?.stickyProtected).toBe(true);
      expect(demotedSticky?.gardeningProposal).toBeUndefined();
      // P1-2: carePause 熔断期间禁止通过 gardening/actions 执行教法退场；恢复后可见于 yellow 且可采纳；sticky 严格 403。
      const retirePid = `yellow:retire_playbook:${demotedNeg.gardeningProposal.dedupKey}`;
      await carePause.pause('test-paused-retire', Date.now() + 1);
      expect((await api('GET', '/api/research/playbooks/effectiveness')).body.carePaused).toBe(true);
      expect((await api('GET', '/api/research/playbooks/effectiveness')).body.verifiedPlaybooks).toEqual([]);
      expect((await api('POST', '/api/kb/gardening/actions', { requestId: 'w4-retire-paused', action: 'accept', proposalId: retirePid })).status).toBe(404);
      await carePause.resume();
      expect((await api('GET', '/api/kb/gardening')).body.yellow.some((y: any) => y.proposalId === retirePid)).toBe(true);
      expect((await api('POST', '/api/kb/gardening/actions', { requestId: 'w4-retire-1', action: 'accept', proposalId: retirePid })).status).toBe(200);
      expect((await readCurrent(pbNeg))!.rev).toBe(2);
      const stickyRetire = await api('POST', '/api/kb/gardening/actions', {
        requestId: 'w4-retire-sticky', action: 'accept',
        proposalId: `yellow:retire_playbook:retire-playbook/${pbSticky}/1/${stableId('w4', 'lift', '置顶负向')}` });
      expect(stickyRetire.status).toBe(403);
      expect(stickyRetire.body?.code).toBe('red_guardrail');
      // P0-4: sticky 严格阻断，非 sticky 压缩候选真实走通 buildAuthoredTextbookCommands。
      const addonsSnaps = new Map<string, any>([
        [cS, { ref: { id: cS, rev: 1 }, type: 'content.asset', purpose: ['storage'], value: { kind: 'concept', title: '置顶概念' } }],
        [c5, { ref: { id: c5, rev: 1 }, type: 'content.asset', purpose: ['storage'], value: { kind: 'concept', title: '可压缩概念' } }],
        ...['n1', 'n2', 'n3'].map(k => [factId(stableId('w4', k)), { ref: { id: factId(stableId('w4', k)), rev: 1 }, type: 'activity.organizerNote', purpose: ['storage'], value: { title: k, markdown: k, source: { id: cS } } }] as const),
        ...['a1', 'a2', 'a3'].map(k => [factId(stableId('w4', k)), { ref: { id: factId(stableId('w4', k)), rev: 1 }, type: 'activity.workbookAttempt', purpose: ['storage'], value: { feedback: [{ result: 'incorrect', errorStage: 'concept' }] } }] as const),
      ]);
      const stickyAll = new Set([cS, factId(stableId('w4', 'a1')), factId(stableId('w4', 'a2')), factId(stableId('w4', 'a3'))]);
      let compressCalled = 0, reinterpretCalled = 0;
      const mockCard = { draft: { mode: 'cheatsheet', title: '考前急救卡', summary: '核心避坑摘要', sections: [{ heading: '错因坑', kind: 'pitfall', body: '注意极限前提条件。' }, { heading: '速查单', kind: 'checklist', body: '三步核查极限存在性。' }] } };
      await runLivingMineMaintenanceAddons({
        snapshots: addonsSnaps, stickyIds: stickyAll, purpose: 'storage', teachingIds: new Set(), nowMs: 1,
        witnesses: () => [{ id: c5, rev: 1, accessEpoch: '0', type: 'content.asset', kind: 'concept', title: '可压缩概念' }],
        pricedCall: async (_s, _i, fn) => ({ outcome: 'ok', value: await fn('pe1') }),
        executeCommand: async () => ({ state: 'done' }), compressionPurpose: 'storage',
        compress: async () => { compressCalled += 1; return mockCard; },
        reinterpret: async () => { reinterpretCalled += 1; return { proposals: [] }; },
        buildCommands: options => buildAuthoredTextbookCommands(options as never) as never,
      });
      expect([compressCalled, reinterpretCalled]).toEqual([0, 0]);
      const okAddon = await runLivingMineMaintenanceAddons({
        snapshots: addonsSnaps, stickyIds: new Set(), purpose: 'storage', teachingIds: new Set(), nowMs: 2,
        witnesses: () => [{ id: cS, rev: 1, accessEpoch: '0', type: 'content.asset', kind: 'concept', title: '置顶概念' }],
        pricedCall: async (_s, _i, fn) => ({ outcome: 'ok', value: await fn('pe2') }),
        executeCommand: async () => ({ state: 'done' }), compressionPurpose: 'storage',
        compress: async () => mockCard,
        buildCommands: options => buildAuthoredTextbookCommands(options as never) as never,
      });
      expect(okAddon.compressedEmergencyCards).toBe(1);
      // P1-1: 撤回 playbook & concept 底层见证 nid 后，effectiveness 排除策略且 radar 排除受影响概念 c5。
      expect(JSON.stringify((await api('GET', '/api/research/radar')).body).includes(c5)).toBe(true);
      await db.tx({ learner: studioLearner }, tx => tx.query(`UPDATE facts SET purpose=ARRAY['teaching'] WHERE learner_id=$1 AND id=$2`, [studioLearner, nid]));
      expect((await api('GET', '/api/research/playbooks/effectiveness')).body.verifiedPlaybooks).toEqual([]);
      const radarAfterRevoke = JSON.stringify((await api('GET', '/api/research/radar')).body);
      expect(radarAfterRevoke.includes(c5)).toBe(false);
      expect(radarAfterRevoke.includes('压缩目标概念')).toBe(false);
      // P1-4 + P2-2: body.allOf ({ field, id }) 触发粗粒度概念拆分提案，缺 children 必须 400 且不落 accept 决策。
      const cCoarse = factId(stableId('w4', 'cCoarse'));
      await db.tx({ learner: studioLearner }, async tx => {
        await tx.query(`INSERT INTO facts (learner_id, id, type, current_rev, access_epoch, purpose, sticky, created_tick, changed_tick)
          VALUES ($1,$2,'content.asset',1,0,'{storage}',false,1,1)`, [studioLearner, cCoarse]);
        await tx.query(`INSERT INTO fact_revs (learner_id, fact_id, rev, data, purpose, sticky, kind, author, command_id, tick)
          VALUES ($1,$2,1,$3,'{storage}',false,'value','learner','seed',1)`,
          [studioLearner, cCoarse, JSON.stringify({ kind: 'concept', title: '超粗概念', aliases: [], merged_into: null, blocks: [], basis: [] })]);
        for (let i = 0; i < 25; i += 1) {
          const qid = factId(stableId('w4', 'cCoarseQ', String(i)));
          await tx.query(`INSERT INTO facts (learner_id, id, type, current_rev, access_epoch, purpose, sticky, created_tick, changed_tick)
            VALUES ($1,$2,'content.asset',1,0,'{storage}',false,1,1)`, [studioLearner, qid]);
          await tx.query(`INSERT INTO fact_revs (learner_id, fact_id, rev, data, purpose, sticky, kind, author, command_id, tick)
            VALUES ($1,$2,1,$3,'{storage}',false,'value','learner','seed',1)`,
            [studioLearner, qid, JSON.stringify({ kind: 'question', title: `粗题${i}`, blocks: [{ id: 'r', parentId: null, body: { kind: 'related', allOf: [{ field: 'concept', id: cCoarse }] } }] })]);
        }
      });
      const splitProp = (await api('GET', '/api/kb/gardening')).body.yellow.find(
        (y: any) => y.proposalKind === 'propose_split_coarse_concept' && y.targetIds.includes(cCoarse));
      expect(splitProp).toBeTruthy();
      const splitNoChildren = await api('POST', '/api/kb/gardening/actions', {
        requestId: 'w4-split-no-children', action: 'accept', proposalId: splitProp.proposalId });
      expect(splitNoChildren.status).toBe(400);
      expect(splitNoChildren.body?.code).toBe('split_children_required');
      expect((await api('GET', '/api/kb/gardening')).body.yellow.some((y: any) => y.proposalId === splitProp.proposalId)).toBe(true);
      // P1-3: teaching 边指向已合并实体 mergeId 时，repoint 保留 teaching 用途并可一键撤回。
      await db.tx({ learner: studioLearner }, async tx => {
        await tx.query(`UPDATE facts SET purpose=ARRAY['storage','teaching'] WHERE learner_id=$1 AND id=ANY($2::text[])`, [studioLearner, [qEmpty, mergeId, keepId]]);
        await tx.query(`UPDATE fact_revs SET purpose=ARRAY['storage','teaching'] WHERE learner_id=$1 AND fact_id=ANY($2::text[])`, [studioLearner, [qEmpty, mergeId, keepId]]);
      });
      const mergeHead = (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ rev: number; epoch: string }>(
        'SELECT current_rev AS rev, access_epoch::text AS epoch FROM facts WHERE learner_id=$1 AND id=$2', [studioLearner, mergeId]))).rows[0]!;
      const eRep = factId(stableId('w4', 'eRepoint'));
      const [qRepUse, mRepUse] = [{ id: qEmpty, rev: 1, accessEpoch: await epochOf(qEmpty) }, { id: mergeId, rev: mergeHead.rev, accessEpoch: mergeHead.epoch }];
      await handle({ learner: studioLearner, actor: 'learner', purpose: 'teaching', id: commandId(stableId('w4-seed', 'eRep')), type: 'content.createKnowledgeEdge',
        input: { id: eRep, purpose: 'teaching', edge: { kind: 'targets_concept', scope: 't', from: { kind: 'question', sourceUse: qRepUse }, to: { kind: 'concept', sourceUse: mRepUse }, sourceUses: [qRepUse, mRepUse] } } });
      const repGreen = (await api('GET', '/api/kb/gardening')).body.green.find((g: any) => g.actionKind === 'repoint_redirected_reference' && g.targetId === eRep);
      expect(repGreen).toBeTruthy();
      expect((await api('POST', '/api/kb/gardening/actions', { requestId: 'w4-rep-1', action: 'apply_green', actionId: repGreen.actionId })).status).toBe(200);
      const repExec = (await api('GET', '/api/kb/gardening')).body.green.find((g: any) => g.actionId === repGreen.actionId);
      const repEdgeRow = (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ purpose: string[]; data: any }>(
        `SELECT f.purpose, r.data FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
         WHERE f.learner_id=$1 AND f.type='content.knowledgeEdge' AND f.retracted_rev IS NULL AND r.data->'to'->'sourceUse'->>'id'=$2`, [studioLearner, keepId]))).rows[0];
      expect(repEdgeRow?.purpose).toContain('teaching');
      expect((await api('POST', '/api/kb/gardening/undo', { requestId: 'w4-rep-undo-1', actionId: repGreen.actionId, undo_token: repExec.undo_token })).status).toBe(200);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }));
