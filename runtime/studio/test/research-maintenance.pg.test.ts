import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { commandId, factId } from '../../../kernel/src/declarations/ids.ts';
import type { Json } from '../../../kernel/src/declarations/types.ts';
import { TeachingError } from '../../../executors/teaching/provider.ts';
import type { ProviderSettings } from '../../../executors/teaching/provider-settings.ts';
import { stableId, studioLearner } from '../identity.ts';
import { serve } from '../http.ts';
import { openTransparency } from '../transparency.ts';
import { openKnowledgeMaintenance } from '../research-maintenance.ts';
import { openCarePause } from '../care-pause.ts';
import { loadStudioTestModule } from './modules.ts';

const port = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject).listen(0, '127.0.0.1', () => { const a = probe.address(); probe.close(() => resolve(typeof a === 'object' && a ? a.port : 0)); });
});
const provider: ProviderSettings = { baseUrl: 'http://127.0.0.1:3425/v1', model: 'mock-model', protocol: 'openai',
  reasoningEffort: 'low', apiKey: '', activeProviderId: 'mock', providers: [], mcpServers: [], exaApiKey: '', allowSearch: false };

it.skipIf(!testDatabaseUrl)('runs knowledge maintenance host end-to-end on PostgreSQL', () =>
  withLearnerDatabase(studioLearner, async db => {
    const [activity, capture, companion, content, plan] = await Promise.all(['activity', 'capture', 'companion', 'content', 'plan'].map(loadStudioTestModule));
    const handle = createCommandHandler(db, { modules: [activity!, capture!, companion!, content!, plan!], hooks: { async onFactsChanged() {} } });
    const send = (type: string, key: string, input: Json, actor: 'learner' | 'companion' = 'learner', purpose = 'teaching') =>
      handle({ learner: studioLearner, actor, purpose, id: commandId(stableId('mt', key)), type, input });
    const carePause = openCarePause(db, companion!);
    let agentCalls = 0, activeProvider = provider, nextAgentErr: Error | null = null, lastFrom = '';
    let edgeSpec: { kind: 'related_to' | 'prereq_of'; swap?: boolean } = { kind: 'related_to' };
    let onAgentEnter: (() => void) | null = null, agentGate: Promise<void> | null = null;
    const maintenance = openKnowledgeMaintenance(db, { content: content!, activity: activity!, carePause,
      loadProvider: async () => activeProvider, agent: async (ctx) => {
        onAgentEnter?.(); if (agentGate) await agentGate; if (nextAgentErr) throw nextAgentErr;
        agentCalls += 1;
        const [a, b] = [ctx.concepts[0]?.id, ctx.concepts[1]?.id].filter(Boolean), [fromId, toId] = edgeSpec.swap ? [b, a] : [a, b];
        lastFrom = fromId ?? '';
        return { proposal: { shouldAct: true, rationale: '发现孤立概念需要连接',
            suggestedEdges: fromId && toId ? [{ fromId, toId, kind: edgeSpec.kind, rationale: '同主题关联' }] : [], suggestedSummaryUpdates: [],
            ...(a ? { suggestedPrepNote: { title: '极限复习单', focusConceptIds: [a], summary: '先复盘孤立概念，再补练错题', actionSteps: ['打开概念', '练一道题'] } } : {}) },
          usage: { model: 'mock-model', reportedModel: 'served-model', inputTokens: 200, outputTokens: 80, durationMs: 42 } };
      }, now: () => new Date('2026-11-24T08:00:00+08:00') });
    const transparency = openTransparency(db), free = await port();
    const server = serve(db, {} as never, {} as never, {} as never, { transparency, maintenance, carePause } as never, free);
    await new Promise<void>(resolve => server.listen(free, '127.0.0.1', resolve));
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${free}${path}`, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as Record<string, any> };
    };
    try {
      const c1 = factId(stableId('mt', 'c1')), c2 = factId(stableId('mt', 'c2'));
      await send('activity.saveWorkspaceEntry', 'c1', { id: c1, entry: { kind: 'concept', title: '极限', body: 'lim 定义与几何意义', tags: [], links: [] }, basis: [] });
      await send('activity.saveWorkspaceEntry', 'c2', { id: c2, entry: { kind: 'concept', title: '导数', body: 'f prime x 定义', tags: [], links: [] }, basis: [] });
      const settingsId = factId(stableId('research-settings', studioLearner));
      await send('companion.configureResearch', 'research-enabled', { id: settingsId, revision: 0, enabled: true });

      const run = await call('POST', '/api/research/maintenance/run');
      expect(run.status).toBe(200);
      expect(run.body).toMatchObject({ ran: true, proposedEdges: 1 });
      expect(run.body.prepNoteId).toBeTruthy();
      expect(agentCalls).toBe(1);

      const ai = await call('GET', '/api/ai/activity');
      expect(ai.status).toBe(200);
      expect((ai.body.pendingProposals as any[]).find(p => p.commandType === 'content.createKnowledgeEdge')).toBeTruthy();
      expect((ai.body.usage.recentCalls as any[]).some(c => c.label === 'knowledge-maintenance-v1')).toBe(true);
      const prepRow = await db.snapshot({ learner: studioLearner }, async tx => (await tx.query<{ type: string; basis: unknown }>(
        `SELECT f.type, r.data->'basis' AS basis FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
         WHERE f.learner_id=$1 AND f.id=$2 AND f.retracted_rev IS NULL`, [tx.learner, run.body.prepNoteId])).rows[0]);
      expect(prepRow?.type).toBe('activity.workspaceEntry');
      expect((prepRow!.basis as any[]).length).toBeGreaterThan(0);

      // D06: 仅授权 teaching 的概念对 force:false 空闲巡航不可见（即便跨过冷却期）
      const t2 = new Date('2026-11-24T10:00:00+08:00'), t3 = new Date('2026-11-24T12:00:00+08:00');
      expect(await maintenance.run({ force: false, now: () => t2 })).toMatchObject({ ran: false, reason: 'no_maintenance_needed' });
      expect(agentCalls).toBe(1);

      // D07: 开放 background-research 后，远程付费模型无预算必须拒绝；预算只够一次时第二次自动触顶
      await db.tx({ learner: studioLearner }, async tx => {
        await tx.query(`UPDATE facts SET purpose=ARRAY['storage','teaching','background-research'] WHERE learner_id=$1 AND id=ANY($2)`, [tx.learner, [c1, c2]]);
        await tx.query(`UPDATE fact_revs SET purpose=ARRAY['storage','teaching','background-research'] WHERE learner_id=$1 AND fact_id=ANY($2)`, [tx.learner, [c1, c2]]);
      });
      activeProvider = { ...provider, baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test' };
      expect(await maintenance.run({ force: false, now: () => t2 })).toMatchObject({ ran: false, reason: 'paid_budget_required' });
      expect(agentCalls).toBe(1);
      await send('companion.configureResearch', 'research-budget', { id: settingsId, revision: 1, enabled: true,
        scoutBudget: { route: 'default', limitMicros: 50000, maxPerCallMicros: 50000, maxRetentionDays: 0, expiresAtMs: t3.getTime() + 3600_000 } }, 'learner', 'background-research');
      edgeSpec = { kind: 'prereq_of' };
      expect(await maintenance.run({ force: false, now: () => t2 })).toMatchObject({ ran: true, proposedEdges: 1 });
      expect(agentCalls).toBe(2);
      const edgePurpose = async (fromId: string) => (await db.snapshot({ learner: studioLearner }, tx => tx.query<{ purpose: string }>(
        `SELECT input->'input'->>'purpose' AS purpose FROM commands WHERE learner_id=$1 AND type='content.createKnowledgeEdge' AND input->'input'->'edge'->>'kind'='prereq_of' AND input->'input'->'edge'->'from'->'sourceUse'->>'id'=$2`, [tx.learner, fromId]))).rows[0]?.purpose;
      expect(await edgePurpose(lastFrom)).toBe('teaching');
      expect((await db.snapshot({ learner: studioLearner }, tx => tx.query<{ held: string }>(
        `SELECT COALESCE(sum(reserved_usd_micros),0)::text AS held FROM effects WHERE learner_id=$1 AND reserved_usd_micros IS NOT NULL AND actual_usd_micros IS NULL`, [tx.learner]))).rows[0]?.held).toBe('50000');
      expect(await maintenance.run({ force: false, now: () => t3 })).toMatchObject({ ran: false, reason: 'paid_budget_required' });
      expect(agentCalls).toBe(2);
      // P1b + P2: 端点去 teaching 后降级 storage；inFlight 期间并发 force:true 返回 in_progress 不串味
      await db.tx({ learner: studioLearner }, async tx => {
        await tx.query(`UPDATE facts SET purpose=ARRAY['storage','background-research'] WHERE learner_id=$1 AND id=$2`, [tx.learner, c2]);
        await tx.query(`UPDATE fact_revs SET purpose=ARRAY['storage','background-research'] WHERE learner_id=$1 AND fact_id=$2`, [tx.learner, c2]);
      });
      activeProvider = provider; edgeSpec = { kind: 'prereq_of', swap: true };
      let release!: () => void, entered!: () => void;
      const enteredP = new Promise<void>(r => { entered = r; });
      onAgentEnter = entered; agentGate = new Promise<void>(r => { release = r; });
      const bg = maintenance.run({ force: false, now: () => t3 });
      await enteredP;
      expect(await maintenance.run({ force: true })).toMatchObject({ ran: false, reason: 'in_progress' });
      onAgentEnter = null; agentGate = null; release();
      expect(await bg).toMatchObject({ ran: true, proposedEdges: 1 });
      expect(await edgePurpose(lastFrom)).toBe('storage');

      await carePause.pause('test-pause', Date.now());
      expect(await call('POST', '/api/research/maintenance/run')).toMatchObject({ status: 200, body: { ran: false, reason: 'care_paused', proposedEdges: 0 } });
      await carePause.resume();

      // S12: 缺模型/TeachingError 诚实映射到 503/502（非 500）
      activeProvider = { ...provider, baseUrl: '' };
      expect(await call('POST', '/api/research/maintenance/run')).toMatchObject({ status: 503, body: { code: 'model_unavailable', next: 'settings' } });
      activeProvider = provider;
      nextAgentErr = new TeachingError('provider_unavailable', '模型服务不可用');
      expect(await call('POST', '/api/research/maintenance/run')).toMatchObject({ status: 503, body: { code: 'model_unavailable', next: 'settings' } });
      nextAgentErr = new TeachingError('provider_timeout', '模型响应超时');
      expect(await call('POST', '/api/research/maintenance/run')).toMatchObject({ status: 502, body: { code: 'provider_timeout' } });
    } finally { server.close(); }
  }));
