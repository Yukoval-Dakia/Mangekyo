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
      await send('content.saveQuestion', 'qStale', { id: qS, asset: questionAsset('闲置草稿题') });
      await send('content.saveQuestion', 'qEmpty', { id: qEmpty, asset: questionAsset('悬空引用载题') });
      await send('content.createTextbookPage', 'tbStale', { id: tbStale, clientEditSeq: 1, purpose: ['storage'],
        page: { title: '闲置伴生草稿页', blocks: [{ id: 'b1', parentId: null, body: { kind: 'text', text: '草稿' } }], tags: ['studio:companion-generated'] } }, 'companion');
      // 过期草稿以写入时钟回拨表达（资产数据不允许存 updatedAt 字段）。
      await db.tx({ learner: studioLearner }, async tx => {
        await tx.query('UPDATE learners SET clock = clock + $2 WHERE id = $1', [studioLearner, 24 * 90 + 10]);
        await tx.query('UPDATE facts SET changed_tick = 1, created_tick = 1 WHERE learner_id=$1 AND id=ANY($2::text[])', [studioLearner, [qS, tbStale]]);
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
      expect(plan0.green.some((g: any) => g.actionId === `green:archive_draft:question:${qS}`)).toBe(true);
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
      // 执行元数据留痕：真实 newRev 与 commandIds 可随时审计与撤回。
      const greenMeta = (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ result: any }>(
        `SELECT result FROM effects WHERE learner_id=$1 AND step_key=$2 AND label='kb-gardening-green'`, [studioLearner, `green:${greenAction.actionId}`]))).rows[0]?.result;
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
      // 伴生教材草稿归档与一键撤回闭环（验证 undoTextbookWrite 真正还原 archived=false）。
      const tbActionId = `green:archive_draft:textbook_page:${tbStale}`;
      expect((await api('POST', '/api/kb/gardening/actions', { requestId: 'w4-tb-arch-1', action: 'apply_green', actionId: tbActionId })).status).toBe(200);
      expect((await readCurrent(tbStale))?.data.archived).toBe(true);
      const tbGreen = (await api('GET', '/api/kb/gardening')).body.green.find((g: any) => g.actionId === tbActionId);
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
      // accept of a sticky-protected merge pair is refused by the red rail.
      const redHit = await api('POST', '/api/kb/gardening/actions', { requestId: 'w4-red-1', action: 'accept',
        proposalId: `yellow:merge:${[cS, cP].sort().join('::')}`, proposalKind: 'merge_duplicate_concepts', targetIds: [cS, cP].sort() });
      expect([403, 404, 409]).toContain(redHit.status); // sticky 合并对被红灯护栏拒绝

      // radar: normal batch share cap, foreground yield, care-pause circuit breaker.
      const radar1 = await api('GET', '/api/research/radar');
      expect(radar1.status).toBe(200);
      expect(radar1.body.maintenanceBudgetCapRatio).toBeLessThanOrEqual(0.2);
      expect(radar1.body.foregroundActive).toBe(false);
      expect(radar1.body.warmBackfillBatch.budgetShare).toBeLessThanOrEqual(0.2);
      await db.tx({ learner: studioLearner }, async tx => {
        await tx.query(`INSERT INTO slot_state (learner_id, slot_type, slot_key, scope_keys) VALUES ($1,'activity.test','fg','{}')`, [studioLearner]);
        await tx.query(`INSERT INTO work (learner_id, id, slot_type, slot_key, deriver, state, execution_ref) VALUES ($1,'wfg1','activity.test','fg','activity/test','ready','exfg1')`, [studioLearner]);
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
      const retireAccept = await api('POST', '/api/kb/gardening/actions', {
        requestId: 'w4-retire-1', action: 'accept',
        proposalId: `yellow:retire_playbook:${demotedNeg.gardeningProposal.dedupKey}` });
      expect(retireAccept.status).toBe(200);
      expect((await readCurrent(pbNeg))!.rev).toBe(2); // retirePlaybook retracts the fact
      // sticky playbook retirement stays impossible even when guessed through the protocol.
      const stickyRetire = await api('POST', '/api/kb/gardening/actions', {
        requestId: 'w4-retire-sticky', action: 'accept',
        proposalId: `yellow:retire_playbook:retire-playbook/${pbSticky}/1/${stableId('w4', 'lift', '置顶负向')}` });
      expect([403, 404]).toContain(stickyRetire.status);
      await carePause.pause('test-paused-twice', Date.now() + 1);
      const effPaused = await api('GET', '/api/research/playbooks/effectiveness');
      expect(effPaused.body.carePaused).toBe(true);
      expect(effPaused.body.verifiedPlaybooks).toEqual([]);
      await carePause.resume();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }));
