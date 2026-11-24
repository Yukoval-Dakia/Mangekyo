import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { commandId, factId } from '../../../kernel/src/declarations/ids.ts';
import type { Json } from '../../../kernel/src/declarations/types.ts';
import type { ProviderSettings } from '../../../executors/teaching/provider-settings.ts';
import { stableId, studioLearner } from '../identity.ts';
import { serve } from '../http.ts';
import { openTransparency } from '../transparency.ts';
import { openKnowledgeMaintenance } from '../research-maintenance.ts';
import { openCarePause } from '../care-pause.ts';
import { loadStudioTestModule } from './modules.ts';

const port = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject).listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
  });
});

const provider: ProviderSettings = { baseUrl: 'http://127.0.0.1:3425/v1', model: 'mock-model', protocol: 'openai',
  reasoningEffort: 'low', apiKey: '', activeProviderId: 'mock', providers: [], mcpServers: [], exaApiKey: '', allowSearch: false };

it.skipIf(!testDatabaseUrl)('runs knowledge maintenance host end-to-end on PostgreSQL', () =>
  withLearnerDatabase(studioLearner, async db => {
    const [activity, capture, companion, content, plan] = await Promise.all(
      ['activity', 'capture', 'companion', 'content', 'plan'].map(loadStudioTestModule));
    const handle = createCommandHandler(db, { modules: [activity!, capture!, companion!, content!, plan!], hooks: { async onFactsChanged() {} } });
    const send = (type: string, key: string, input: Json, actor: 'learner' | 'companion' = 'learner', purpose = 'teaching') =>
      handle({ learner: studioLearner, actor, purpose, id: commandId(stableId('mt', key)), type, input });
    const carePause = openCarePause(db, companion!);
    const maintenance = openKnowledgeMaintenance(db, { content: content!, activity: activity!, carePause,
      loadProvider: async () => provider, agent: async (ctx) => {
        agentCalls += 1;
        const [a, b] = [ctx.concepts[0]?.id, ctx.concepts[1]?.id].filter(Boolean);
        return { proposal: { shouldAct: true, rationale: '发现孤立概念需要连接', suggestedEdges: a && b
              ? [{ fromId: a, toId: b, kind: 'related_to' as const, rationale: '同主题关联' }] : [],
            suggestedSummaryUpdates: [],
            ...(a ? { suggestedPrepNote: { title: '极限复习单', focusConceptIds: [a],
              summary: '先复盘孤立概念，再补练错题', actionSteps: ['打开概念', '练一道题'] } } : {}) },
          usage: { model: 'mock-model', reportedModel: 'served-model', inputTokens: 200, outputTokens: 80, durationMs: 42 } };
      },
      now: () => new Date('2026-11-24T08:00:00+08:00'),
    });
    const transparency = openTransparency(db);
    const free = await port();
    const server = serve(db, {} as never, {} as never, {} as never, { transparency, maintenance, carePause } as never, free);
    await new Promise<void>(resolve => server.listen(free, '127.0.0.1', resolve));
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${free}${path}`, body === undefined ? { method } : {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as Record<string, any> };
    };

    let agentCalls = 0;
    try {
      // 冷启动概念（授权 teaching）：两个孤立概念，零图边
      const c1 = factId(stableId('mt', 'c1')), c2 = factId(stableId('mt', 'c2'));
      await send('activity.saveWorkspaceEntry', 'c1', { id: c1,
        entry: { kind: 'concept', title: '极限', body: 'lim 定义与几何意义', tags: [], links: [] }, basis: [] });
      await send('activity.saveWorkspaceEntry', 'c2', { id: c2,
        entry: { kind: 'concept', title: '导数', body: 'f prime x 定义', tags: [], links: [] }, basis: [] });

      // 启用后台教研，允许 force:false 走完整门控
      const settingsId = factId(stableId('research-settings', studioLearner));
      await send('companion.configureResearch', 'research-enabled', { id: settingsId, revision: 0, enabled: true });

      const run = await call('POST', '/api/research/maintenance/run');
      expect(run.status).toBe(200);
      expect(run.body).toMatchObject({ ran: true, proposedEdges: 1 });
      expect(run.body.prepNoteId).toBeTruthy();
      expect(agentCalls).toBe(1);

      const ai = await call('GET', '/api/ai/activity');
      expect(ai.status).toBe(200);
      const edgeProposal = (ai.body.pendingProposals as any[]).find(p => p.commandType === 'content.createKnowledgeEdge');
      expect(edgeProposal).toBeTruthy();
      expect((ai.body.usage.recentCalls as any[]).some(c => c.label === 'knowledge-maintenance-v1')).toBe(true);

      // prepNoteId 对应 workspaceEntry 已落库且 basis 指向真实概念
      const prepRow = await db.snapshot({ learner: studioLearner }, async tx => {
        const result = await tx.query<{ type: string; title: string; basis: unknown }>(
          `SELECT f.type, r.data->>'title' AS title, r.data->'basis' AS basis FROM facts f
           JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
           WHERE f.learner_id=$1 AND f.id=$2 AND f.retracted_rev IS NULL`, [tx.learner, run.body.prepNoteId]);
        return result.rows[0];
      });
      expect(prepRow).toBeTruthy();
      expect(prepRow.type).toBe('activity.workspaceEntry');
      expect((prepRow.basis as any[]).length).toBeGreaterThan(0);

      const idle = await maintenance.run({ force: false });
      expect(idle.ran).toBe(false);
      expect(idle.reason).toBe('no_maintenance_needed');
      expect(agentCalls).toBe(1);

      await carePause.pause('test-pause', Date.now());
      const paused = await call('POST', '/api/research/maintenance/run');
      expect(paused.status).toBe(200);
      expect(paused.body).toMatchObject({ ran: false, reason: 'care_paused', proposedEdges: 0 });
      await carePause.resume();

      const noProvider = openKnowledgeMaintenance(db, { content: content!, activity: activity!, carePause,
        loadProvider: async () => ({ ...provider, baseUrl: '' }), agent: async () => { throw new Error('unreachable'); } });
      const free2 = await port();
      const server2 = serve(db, {} as never, {} as never, {} as never, { transparency, maintenance: noProvider, carePause } as never, free2);
      await new Promise<void>(resolve => server2.listen(free2, '127.0.0.1', resolve));
      try {
        const res2 = await fetch(`http://127.0.0.1:${free2}/api/research/maintenance/run`, { method: 'POST' });
        expect(res2.status).toBe(503);
        expect((await res2.json() as any)).toMatchObject({ code: 'model_unavailable', next: 'settings' });
      } finally { server2.close(); }
    } finally {
      server.close();
    }
  }));
