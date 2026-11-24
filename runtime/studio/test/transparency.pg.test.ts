import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { commandId, factId, type Revision } from '../../../kernel/src/declarations/ids.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import type { Json } from '../../../kernel/src/declarations/types.ts';
import { notionSelectionWitness } from '../../../modules/capture/notion-selection.ts';
import { prepareNotionIngest } from '../../../modules/capture/notion-source.ts';
import { captureSourceCommand } from '../../../modules/capture/source.ts';
import { slotType, stableId, studioLearner } from '../identity.ts';
import { serve } from '../http.ts';
import { openStudioNotion } from '../notion.ts';
import { openTransparency } from '../transparency.ts';
import { loadStudioTestModule } from './modules.ts';

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

it.skipIf(!testDatabaseUrl)('serves /api/ai/activity, /api/knowledge/graph, and /api/memory/overview with real-time revocation and honest unknown', () =>
  withLearnerDatabase(studioLearner, async db => {
    const [activity, capture, companion, content, learnerMod] = await Promise.all(
      ['activity', 'capture', 'companion', 'content', 'learner'].map(name => loadStudioTestModule(name)),
    );
    const handle = createCommandHandler(db, { modules: [activity!, capture!, companion!, content!, learnerMod!], hooks: { async onFactsChanged() {} } });
    const notion = openStudioNotion(db, capture!);
    const send = (type: string, key: string, input: Json, actor: 'learner' | 'companion' = 'learner', purpose = 'teaching') =>
      handle({ learner: studioLearner, actor, purpose, id: commandId(stableId('tr-cmd', key)), type, input });

    const port = await freePort();
    const transparency = openTransparency(db);
    const server = serve(db, {} as never, {} as never, {} as never, { transparency } as never, port);
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    const get = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };

    try {
      expect((await get('/api/ai/activity')).body).toMatchObject({ running: [], handoffs: [], recentTools: [], usage: { currency: 'USD_MICROS', spentMicros: 0, limitMicros: null, recentCalls: [] }, pendingProposals: [] });
      expect((await get('/api/knowledge/graph')).body).toMatchObject({ nodes: [], edges: [], pendingProposals: [] });
      const memHead = await fetch(`http://127.0.0.1:${port}/api/memory/overview`);
      expect(memHead.headers.get('content-security-policy')).toContain("font-src 'self' data:");
      expect((await get('/api/memory/overview')).body).toMatchObject({ categories: { preference: [], claim: [], state: [], refusal: [] }, stickyDirectives: [], hypotheses: [], calibration: { status: 'unknown', totalReconciliations: 0, confirmed: 0, missed: 0, recent: [] } });
      expect((await get('/api/memory/overview')).body).toMatchObject({ weaknessSummary: { status: 'insufficient_evidence', sampleCount: 0, neededCount: 2 } });
      expect((await get('/api/knowledge/graph?purpose=invalid')).status).toBe(400);

      const srcNoteId = factId(stableId('tr', 'note'));
      await send('activity.organizerCreateNote', 'note', { id: srcNoteId, title: '导数笔记', markdown: '定义与几何意义', materialId: null }, 'learner', 'storage');
      await send('activity.setWorkspaceTeaching', 'note-teach', { id: srcNoteId, expectedRev: 1, enabled: true }, 'learner', 'storage');
      const noteUse = { id: srcNoteId, rev: 2, accessEpoch: '1' };

      const c1 = factId(stableId('tr', 'c1'));
      const c2 = factId(stableId('tr', 'c2'));
      await send('content.createKnowledgeEntity', 'c1', { id: c1, purpose: 'teaching', entity: { kind: 'concept', canonicalName: '极限', aliases: ['Limit'], merged_into: null }, resolution: { decision: 'no-match', reason: '新概念', candidates: [], sourceUses: [noteUse] } });
      await send('content.createKnowledgeEntity', 'c2', { id: c2, purpose: 'teaching', entity: { kind: 'concept', canonicalName: '导数', aliases: [], merged_into: null }, resolution: { decision: 'no-match', reason: '新概念', candidates: [], sourceUses: [noteUse] } });
      const c1Use = { id: c1, rev: 1, accessEpoch: '0' };
      const c2Use = { id: c2, rev: 1, accessEpoch: '0' };

      const proofId = factId(stableId('tr', 'edge-proof'));
      const prereqClaim = { kind: 'prereq_of', scope: 'calculus', from: { kind: 'concept', sourceUse: c1Use }, to: { kind: 'concept', sourceUse: c2Use }, sourceUses: [c1Use, c2Use] };
      await send('content.recordKnowledgeEdgeEvidence', 'proof', { id: proofId, purpose: 'teaching', method: 'trusted_source', edge: prereqClaim });
      await send('content.createVerifiedKnowledgeEdge', 'e-prereq', { id: factId(stableId('tr', 'e-prereq')), purpose: 'teaching', edge: prereqClaim, verification: { id: proofId, rev: 1, accessEpoch: '0' } });

      const q1 = factId(stableId('tr', 'q1'));
      await send('content.saveQuestion', 'q1', { id: q1, purpose: 'teaching', asset: { kind: 'question', title: '极限基础题', promptBlockId: 'p1', blocks: [{ id: 'p1', parentId: null, body: { kind: 'text', text: '求 lim(x->0) sin(x)/x' } }] } });
      const q1Use = { id: q1, rev: 1, accessEpoch: '0' };
      await send('content.createKnowledgeEdge', 'e-q1', { id: factId(stableId('tr', 'e-q1')), purpose: 'teaching', edge: { kind: 'targets_concept', scope: 'calculus', from: { kind: 'question', sourceUse: q1Use }, to: { kind: 'concept', sourceUse: c1Use }, sourceUses: [q1Use, c1Use] } });
      const wq1 = factId(stableId('tr', 'wq1'));
      await send('activity.saveWorkspaceEntry', 'wq1', { id: wq1, entry: { kind: 'question', title: '极限练手题', body: '求 lim(x->0) sin(x)/x', answer: '1', tags: [], links: [] }, basis: [{ id: srcNoteId, rev: 2, epoch: '1' }] });
      const wq1Use = { id: wq1, rev: 1, accessEpoch: '0' };
      await send('content.createKnowledgeEdge', 'e-wq1', { id: factId(stableId('tr', 'e-wq1')), purpose: 'teaching', edge: { kind: 'targets_concept', scope: 'calculus', from: { kind: 'question', sourceUse: wq1Use }, to: { kind: 'concept', sourceUse: c1Use }, sourceUses: [wq1Use, c1Use] } });

      const tb1 = factId(stableId('tr', 'tb1'));
      await send('content.createTextbookPage', 'tb1', { id: tb1, clientEditSeq: 0, purpose: ['storage', 'teaching'], page: { title: '微积分讲义', blocks: [{ id: 'b1', parentId: null, body: { kind: 'text', text: '极限定义' } }] } });
      const tbUse = { id: tb1, rev: 1, accessEpoch: '0' };
      await send('content.createKnowledgeEdge', 'e-tb1', { id: factId(stableId('tr', 'e-tb1')), purpose: 'teaching', edge: { kind: 'explains', scope: 'calculus', from: { kind: 'chapter', sourceUse: tbUse, blockId: 'b1' }, to: { kind: 'concept', sourceUse: c1Use }, sourceUses: [tbUse, c1Use] } });
      await send('content.createKnowledgeEdge', 'e-note', { id: factId(stableId('tr', 'e-note')), purpose: 'teaching', edge: { kind: 'related_to', scope: 'calculus', from: { kind: 'note', sourceUse: noteUse }, to: { kind: 'concept', sourceUse: c1Use }, sourceUses: [noteUse, c1Use] } });

      const notionPageId = '00000000-0000-0000-0000-000000000001';
      const notionBlockId = '00000000-0000-0000-0000-000000000002';
      await notion.mutate('grant', { requestId: 'notion-grant-1', deletionWatermark: '0', selectionId: 'calc-notion', expectedEpoch: '0', root: { kind: 'page', id: notionPageId }, preset: 'storage', recipients: [] });
      const notionSel = { learner: studioLearner, id: 'calc-notion', selectionEpoch: '1', active: true, root: { kind: 'page' as const, id: notionPageId }, preset: 'storage' as const, recipients: [], continuity: [] };
      const notionIngest = await prepareNotionIngest(notionSel, {
        root: notionSel.root, dispatch: notionSelectionWitness(notionSel), pageId: notionPageId,
        title: 'Notion微积分', lastEditedTime: '2026-11-21T08:00:00.000Z',
        blocks: [{ id: notionBlockId, parentId: null, text: '极限要点', body: { type: 'paragraph', data: {} } }],
      }, '2026-11-21T08:00:00.000Z');
      await send(captureSourceCommand, 'notion-ingest', notionIngest as unknown as Json, 'learner', 'storage');
      const nSrcId = notionIngest.id;
      const nUse = { id: nSrcId, rev: 1, accessEpoch: '0' };
      await send('content.createKnowledgeEdge', 'e-notion', { id: factId(stableId('tr', 'e-notion')), purpose: 'storage', edge: { kind: 'related_to', scope: 'calculus', from: { kind: 'note', sourceUse: nUse }, to: { kind: 'concept', sourceUse: c1Use }, sourceUses: [nUse, c1Use] } }, 'learner', 'storage');

      const edgeProp = await send('content.createKnowledgeEdge', 'p-edge', { id: factId(stableId('tr', 'e-prop')), purpose: 'teaching', edge: { kind: 'contrasts_with', scope: 'calculus', from: { kind: 'concept', sourceUse: c1Use }, to: { kind: 'concept', sourceUse: c2Use }, sourceUses: [c1Use, c2Use] } }, 'companion');
      expect(edgeProp.state).toBe('proposed');
      const tbProp = await send('content.reviseTextbookPage', 'p-tb', { id: tb1, expectedRev: 1, clientEditSeq: 1, edits: [{ kind: 'rewrite', blockId: 'b1', body: { kind: 'text', text: '修订后的极限定义' } }] }, 'companion', 'storage');
      expect(tbProp.state).toBe('proposed');

      const paperId = factId(stableId('tr', 'paper'));
      await send('activity.saveWorkbookPaper', 'paper', { id: paperId, data: { title: '极限小测', materialId: null, savedAt: '2026-11-21T09:00:00.000Z', questions: [{ id: 'item1', kind: 'numeric', prompt: '求 lim(x->0) sin(x)/x', answer: 1, tolerance: 0, unit: null, explanation: null, sourceQuestionRef: { id: wq1, rev: 1 } }, { id: 'item2', kind: 'numeric', prompt: '求 lim(x->0) (1-cos(x))/x^2 的两倍', answer: 1, tolerance: 0, unit: null, explanation: null }] } }, 'learner', 'storage');
      const ordinaryAttemptId = factId(stableId('tr', 'att-ord'));
      await send('activity.submitWorkbookAttempt', 'att-ord', { id: ordinaryAttemptId, data: { paperId, requestId: 'ord-req-1', submittedAt: '2026-11-21T09:05:00.000Z', answers: { item2: '1' } } }, 'learner', 'storage');
      await send('activity.setWorkspaceTeaching', 'att-ord-teach', { id: ordinaryAttemptId, expectedRev: 1, enabled: true }, 'learner', 'storage');
      const graphBeforeControlledRes = await get('/api/knowledge/graph');
      expect(graphBeforeControlledRes.status).toBe(200);
      const graphBeforeControlled = graphBeforeControlledRes.body as { nodes: { id: string; counts: Record<string, number>; mastery: Record<string, unknown> }[]; edges: unknown[]; pendingProposals: unknown[] };
      expect(graphBeforeControlled.nodes.find(n => n.id === c1)?.mastery).toMatchObject({ status: 'unknown', retrievability: null, independentCount: 0 });

      const forecastKey = stableId('tr', 'fc-key');
      const forecastId = stableId('tr', 'fc-id');
      const sealedPaperId = factId(stableId('tr', 'sealed-paper'));
      await send('activity.saveWorkbookPaper', 'sealed-paper', { id: sealedPaperId, condition: 'studio-closed-workbook-v1', data: { title: '极限后测卷', materialId: null, savedAt: '2026-11-21T09:08:00.000Z', questions: [{ id: 'item1', kind: 'numeric', prompt: '求 lim(x->0) sin(x)/x', answer: 1, tolerance: 0, unit: null, explanation: null, sourceQuestionRef: { id: wq1, rev: 1 } }] } }, 'learner', 'teaching');
      const issueId = factId(stableId('tr', 'post-issue'));
      const postSubId = factId(stableId('tr', 'post-sub'));
      await send('activity.issueRetentionPosttest', 'issue', { id: issueId, data: { condition: 'studio-closed-workbook-v1', gradingVersion: 'workbook-v1', forecastKey, forecastId, effectiveTick: '1', paper: { id: sealedPaperId, rev: 1 }, paperEpoch: '0', itemId: 'item1', startedAt: '2026-11-21T09:10:00.000Z', through: '2026-11-22T09:10:00.000Z' } });
      await send('activity.submitWorkbookAttempt', 'post-sub', { id: postSubId, condition: 'studio-closed-workbook-v1', data: { paperId: issueId, requestId: 'post-req-1', submittedAt: '2026-11-21T10:00:00.000Z', answers: { item1: '1' } } });
      const wq2 = factId(stableId('tr', 'wq2'));
      await send('activity.saveWorkspaceEntry', 'wq2', { id: wq2, entry: { kind: 'question', title: '导数练手题', body: '求 (x^2) 的导数', answer: '2', tags: [], links: [] }, basis: [{ id: srcNoteId, rev: 2, epoch: '1' }] });
      const wq2Use = { id: wq2, rev: 1, accessEpoch: '0' };
      await send('content.createKnowledgeEdge', 'e-wq2', { id: factId(stableId('tr', 'e-wq2')), purpose: 'teaching', edge: { kind: 'targets_concept', scope: 'calculus', from: { kind: 'question', sourceUse: wq2Use }, to: { kind: 'concept', sourceUse: c2Use }, sourceUses: [wq2Use, c2Use] } });
      const sealedPaper2Id = factId(stableId('tr', 'sealed-paper2'));
      const forecastKey2 = stableId('tr', 'fc-key2'), forecastId2 = stableId('tr', 'fc-id2');
      const issue2Id = factId(stableId('tr', 'post-issue2')), postSub2Id = factId(stableId('tr', 'post-sub2'));
      await send('activity.saveWorkbookPaper', 'sealed-paper2', { id: sealedPaper2Id, condition: 'studio-closed-workbook-v1', data: { title: '导数后测卷', materialId: null, savedAt: '2026-11-21T09:09:00.000Z', questions: [{ id: 'item1', kind: 'numeric', prompt: '求 (x^2) 的导数', answer: 2, tolerance: 0, unit: null, explanation: null, sourceQuestionRef: { id: wq2, rev: 1 } }] } }, 'learner', 'teaching');
      await send('activity.issueRetentionPosttest', 'issue2', { id: issue2Id, data: { condition: 'studio-closed-workbook-v1', gradingVersion: 'workbook-v1', forecastKey: forecastKey2, forecastId: forecastId2, effectiveTick: '1', paper: { id: sealedPaper2Id, rev: 1 }, paperEpoch: '0', itemId: 'item1', startedAt: '2026-11-21T09:11:00.000Z', through: '2026-11-22T09:11:00.000Z' } });
      await send('activity.submitWorkbookAttempt', 'post-sub2', { id: postSub2Id, condition: 'studio-closed-workbook-v1', data: { paperId: issue2Id, requestId: 'post-req-2', submittedAt: '2026-11-21T10:05:00.000Z', answers: { item1: '0' } } });
      const qw = factId(stableId('tr', 'qw'));
      await send('content.saveQuestion', 'qw', { id: qw, purpose: 'storage', asset: { kind: 'question', title: '导数口算', promptBlockId: 'p', blocks: [{ id: 'p', parentId: null, body: { kind: 'text', text: '求 (x^3) 的导数' } }] } }, 'learner', 'storage');
      const qwUse = { id: qw, rev: 1, accessEpoch: '0' };
      await send('content.createKnowledgeEdge', 'e-qw', { id: factId(stableId('tr', 'e-qw')), purpose: 'storage', edge: { kind: 'targets_concept', scope: 'calculus', from: { kind: 'question', sourceUse: qwUse }, to: { kind: 'concept', sourceUse: c2Use }, sourceUses: [qwUse, c2Use] } }, 'learner', 'storage');
      const paperW = factId(stableId('tr', 'paper-w'));
      await send('activity.saveWorkbookPaper', 'paper-w', { id: paperW, data: { title: 'w', materialId: null, savedAt: '2026-11-21T09:12:00.000Z', questions: [{ id: 'i1', kind: 'numeric', prompt: '求 (x^3) 的导数', answer: 3, tolerance: 0, unit: null, explanation: null, sourceQuestionRef: { id: qw, rev: 1 } }] } }, 'learner', 'storage');
      await send('activity.submitWorkbookAttempt', 'att-w', { id: factId(stableId('tr', 'att-w')), data: { paperId: paperW, requestId: 'req-att-w', submittedAt: '2026-11-21T10:12:00.000Z', answers: { i1: '0' } } }, 'learner', 'storage');
      await send('content.setQuestionTeaching', 'widen-qw', { id: qw, expectedRev: 1, allowed: true }, 'learner', 'storage');

      const turnId = factId(stableId('tr', 'turn1'));
      const turnText = '先画图再推导；最近有点累；我习惯例题先行；不要推送刷题提醒';
      await send('activity.submitTurn', 'turn1', { id: turnId, data: { sessionId: turnId, caseId: 'companion', parentId: null, answer: turnText, memoryVersion: 1, workspaceRevision: 'w1', allowBackgroundUnderstanding: true, model: 'deepseek-v4.1-flash', baseUrl: 'http://127.0.0.1:4000/v1' } });
      const turnUse = (excerpt: string) => ({ id: turnId, rev: 1, accessEpoch: '0', start: turnText.indexOf(excerpt), excerpt });
      await send('companion.saveBelief', 'beliefs', {
        turn: turnId,
        directives: [
          { id: factId(stableId('tr', 'm-pref')), data: { version: 1, action: 'remember', category: 'preference', origin: 'turn', authority: 'directive', text: '先画图再推导', scope: { kind: 'general' }, valid_until: null, supersedes: null, evidence_refs: [turnUse('先画图再推导')] } },
          { id: factId(stableId('tr', 'm-claim')), data: { version: 1, action: 'remember', category: 'claim', origin: 'turn', authority: 'directive', text: '我习惯例题先行', scope: { kind: 'general' }, valid_until: null, supersedes: null, evidence_refs: [turnUse('我习惯例题先行')] } },
          { id: factId(stableId('tr', 'm-state')), data: { version: 1, action: 'remember', category: 'state', origin: 'turn', authority: 'directive', text: '最近有点累', scope: { kind: 'general' }, valid_until: '2026-12-01T00:00:00.000Z', supersedes: null, evidence_refs: [turnUse('最近有点累')] } },
          { id: factId(stableId('tr', 'm-refusal')), data: { version: 1, action: 'remember', category: 'refusal', origin: 'turn', authority: 'directive', refusal: { goal: 'practice', intent_key: 'drill', reopen_condition: { kind: 'learner_request' } }, text: '不要推送刷题提醒', scope: { kind: 'general' }, valid_until: null, supersedes: null, evidence_refs: [turnUse('不要推送刷题提醒')] } },
        ],
        hypotheses: [],
      }, 'companion');
      await send('companion.saveBelief', 'hyp1', {
        turn: turnId,
        directives: [],
        hypotheses: [{
          id: factId(stableId('tr', 'h1')), quote: null,
          data: { version: 2, kind: 'observation', text: '能独立完成标准极限求值', scope: { kind: 'general' }, ttl: null, sticky: false, undo_token: factId(stableId('tr', 'h1-undo')), evidence_refs: [{ id: ordinaryAttemptId, rev: 2, accessEpoch: '1', anchor: 'item2', excerpt: '1', direction: 'support' }], belief: { turn: turnId, supersedes: null, forgotten: false } },
        }],
      }, 'companion');
      const prefFactId = factId(stableId('tr', 'lp1'));
      await send('learner.declarePreference', 'lp1', { id: prefFactId, data: { text: '数学公式保留推导步骤', tags: ['math'], scope: {} } }, 'learner', 'storage');
      await send('companion.manageMemory', 'forget-claim', { id: factId(stableId('tr', 'm-forgotten')), data: { version: 1, action: 'forget', category: 'claim', origin: 'learner', text: null, scope: { kind: 'unknown' }, valid_until: null, supersedes: { id: factId(stableId('tr', 'm-claim')), rev: 1, accessEpoch: '0' }, evidence_refs: [] } }, 'learner', 'storage');

      const recKey = stableId('tr', 'rec-key');
      const recId = stableId('tr', 'rec-id');
      const settingsId = factId(stableId('research-settings', studioLearner));
      await send('companion.configureResearch', 'res-cfg', { id: settingsId, revision: 0, enabled: true, scoutBudget: { route: 'default', limitMicros: 500000, maxPerCallMicros: 50000, maxRetentionDays: 0, expiresAtMs: Date.now() + 3600_000 } }, 'learner', 'background-research');
      await db.tx({ learner: studioLearner }, async tx => tx.withLearnerWrite(async tick => {
        const fcManifest = { version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: tick, inputs: [{ kind: 'fact', id: sealedPaperId, rev: 1, accessEpoch: '0', mode: 'following' }] };
        const fcVal = { kind: 'value', value: { method: { id: 'cognition', version: '3' }, estimate: { kind: 'probabilistic', probability: 0.42, interval: [0.3, 0.55], uncertainty: 0.1, effectiveEvidence: 2, bucket: { kcId: c1, representation: 'symbolic', context: 'practice', method: 'direct' }, basis: null }, input: { target: { activity: 'frozen-workbook-item', paper: { id: sealedPaperId, rev: 1 }, itemId: 'item1', condition: 'same-item', gradingVersion: 'v1' }, window: { requestedAt: '2026-11-21T09:10:00.000Z', through: '2026-11-22T09:10:00.000Z' }, observedThrough: tick, observations: [] } } };
        await tx.insert('derivations', { learner_id: studioLearner, id: forecastId, slot_type: 'predict.forecast', slot_key: forecastKey, deriver: 'learner/retention-forecast@1', scope_keys: '{}', value: JSON.stringify(fcVal), lifecycle: 'effective', freshness: 'current', gather_tick: tick, effective_tick: tick, manifest: JSON.stringify(fcManifest) });
        await tx.insert('slot_state', { learner_id: studioLearner, slot_type: 'predict.forecast', slot_key: forecastKey, current_id: forecastId, last_id: forecastId, pending: 'none', changed_tick: tick, scope_keys: '{}' });
        const fc2Manifest = { version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: tick, inputs: [{ kind: 'fact', id: sealedPaper2Id, rev: 1, accessEpoch: '0', mode: 'following' }] };
        const fc2Val = { kind: 'value', value: { method: { id: 'cognition', version: '3' }, estimate: { kind: 'probabilistic', probability: 0.9, interval: [0.8, 0.95], uncertainty: 0.1, effectiveEvidence: 2, bucket: { kcId: c2, representation: 'symbolic', context: 'practice', method: 'direct' }, basis: null }, input: { target: { activity: 'frozen-workbook-item', paper: { id: sealedPaper2Id, rev: 1 }, itemId: 'item1', condition: 'same-item', gradingVersion: 'v1' }, window: { requestedAt: '2026-11-21T09:11:00.000Z', through: '2026-11-22T09:11:00.000Z' }, observedThrough: tick, observations: [] } } };
        await tx.insert('derivations', { learner_id: studioLearner, id: forecastId2, slot_type: 'predict.forecast', slot_key: forecastKey2, deriver: 'learner/retention-forecast@1', scope_keys: '{}', value: JSON.stringify(fc2Val), lifecycle: 'effective', freshness: 'current', gather_tick: tick, effective_tick: tick, manifest: JSON.stringify(fc2Manifest) });
        await tx.insert('slot_state', { learner_id: studioLearner, slot_type: 'predict.forecast', slot_key: forecastKey2, current_id: forecastId2, last_id: forecastId2, pending: 'none', changed_tick: tick, scope_keys: '{}' });
        const recManifest = { version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: tick, inputs: [{ kind: 'slot', slotType: 'predict.forecast', slotKey: forecastKey, derivationId: forecastId, mode: 'following' }, { kind: 'fact', id: postSubId, rev: 1, accessEpoch: '0', mode: 'following' }] };
        const recVal = { kind: 'value', value: { forecastId, observedThrough: tick, status: 'matched', observation: { submission: { id: postSubId, rev: 1 }, submittedAt: '2026-11-21T10:00:00.000Z', admittedAt: tick, result: 'correct', exposure: { kind: 'independent' } } } };
        await tx.insert('derivations', { learner_id: studioLearner, id: recId, slot_type: 'predict.reconciliation', slot_key: recKey, deriver: 'learner/retention-reconciliation@1', scope_keys: '{}', value: JSON.stringify(recVal), lifecycle: 'effective', freshness: 'current', gather_tick: tick, effective_tick: tick, manifest: JSON.stringify(recManifest) });
        await tx.insert('slot_state', { learner_id: studioLearner, slot_type: 'predict.reconciliation', slot_key: recKey, current_id: recId, last_id: recId, pending: 'none', changed_tick: tick, scope_keys: '{}' });
        const fbId = stableId('tr', 'fb1');
        const fbManifest = { version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: tick, inputs: [{ kind: 'fact', id: turnId, rev: 1, accessEpoch: '0', mode: 'following' }] };
        const fbVal = { action: 'companion_reply', model: 'deepseek-v4.1-flash', rationale: 'ok', message: '已记录', evidenceIds: [turnId], reads: [{ id: turnId, title: '回合', text: turnText }], trace: ['search_workspace', 'save_belief'], foregroundDigest: { id: turnId, kind: 'companion_completed', summary: '本轮已完成记录', sourceRefs: [{ kind: 'fact', id: turnId, rev: 1, accessEpoch: '0', mode: 'following' }] } };
        await tx.insert('derivations', { learner_id: studioLearner, id: fbId, slot_type: slotType, slot_key: turnId, deriver: 'activity/evidence-tutor-v1', scope_keys: '{}', value: JSON.stringify(fbVal), lifecycle: 'effective', freshness: 'current', gather_tick: tick, effective_tick: tick, manifest: JSON.stringify(fbManifest) });
        await tx.insert('slot_state', { learner_id: studioLearner, slot_type: slotType, slot_key: turnId, current_id: fbId, last_id: fbId, pending: 'running', changed_tick: tick, scope_keys: '{}' });
        await tx.insert('work', { learner_id: studioLearner, id: stableId('tr', 'work1'), slot_type: slotType, slot_key: turnId, deriver: 'activity/evidence-tutor-v1', state: 'ready', generation: 1, requested_tick: tick, execution_ref: stableId('tr', 'exec1') });
        await tx.insert('effects', { learner_id: studioLearner, owner_kind: 'session', owner_id: turnId, step_key: 'step1', label: 'teaching-model', input_digest: 'd1', input: JSON.stringify({model: 'group/powerful'}), result: JSON.stringify({message: '无上报模型'}), provider_effect_id: 'pe1', state: 'done', reserved_usd_micros: 1200, actual_usd_micros: 800, budget_route: 'default', started_tick: tick, ended_tick: tick });
      }));

      // A classroom turn: same companion caseId but the classroom flag routes the handoff to /classroom.
      const classroomId = factId(stableId('tr', 'classroom'));
      const turnId2 = factId(stableId('tr', 'turn2'));
      await send('activity.submitTurn', 'turn2', { id: turnId2, data: { sessionId: classroomId, caseId: 'companion', parentId: null, answer: '课堂回合', memoryVersion: 1, allowBackgroundUnderstanding: true, classroom: { mode: 'start', evidence: [] }, model: 'kimi-k3.1-pro', baseUrl: 'http://127.0.0.1:4000/v1' } });
      await db.tx({ learner: studioLearner }, async tx => tx.withLearnerWrite(async tick => {
        const fb2 = stableId('tr', 'fb2');
        const fb2Manifest = { version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: tick, inputs: [{ kind: 'fact', id: turnId2, rev: 1, accessEpoch: '0', mode: 'following' }] };
        const fb2Val = { action: 'companion_reply', model: 'kimi-k3.1-pro', message: '课堂回复', foregroundDigest: { id: turnId2, kind: 'companion_completed', summary: '课堂回合完成', sourceRefs: [{ kind: 'fact', id: turnId2, rev: 1, accessEpoch: '0', mode: 'following' }] } };
        await tx.insert('derivations', { learner_id: studioLearner, id: fb2, slot_type: slotType, slot_key: turnId2, deriver: 'activity/evidence-tutor-v1', scope_keys: '{}', value: JSON.stringify(fb2Val), lifecycle: 'effective', freshness: 'current', gather_tick: tick, effective_tick: tick, manifest: JSON.stringify(fb2Manifest) });
        await tx.insert('slot_state', { learner_id: studioLearner, slot_type: slotType, slot_key: turnId2, current_id: fb2, last_id: fb2, pending: 'none', changed_tick: tick, scope_keys: '{}' });
        await tx.insert('work', { learner_id: studioLearner, id: stableId('tr', 'work-blocked-turn'), slot_type: slotType, slot_key: turnId2, deriver: 'activity/evidence-tutor-v1', state: 'blocked', generation: 2, requested_tick: tick, execution_ref: stableId('tr', 'exec-blocked-turn') });
        const result = JSON.stringify({ reportedModel: 'kimi-k3.1-pro', message: '课堂回复', usage: { prompt_tokens: 120, completion_tokens: 45 } });
        await tx.insert('effects', { learner_id: studioLearner, owner_kind: 'session', owner_id: turnId2, step_key: 'step1', label: 'teaching-model', input_digest: 'd2', provider_effect_id: 'pe2', state: 'done', result, reserved_usd_micros: 900, actual_usd_micros: 600, budget_route: 'magpie', started_tick: tick, ended_tick: tick });
      }));

      const graph = (await get('/api/knowledge/graph')).body as { nodes: { id: string; counts: Record<string, number>; mastery: Record<string, unknown> }[]; edges: { verified: boolean; kind: string }[]; pendingProposals: { commandType: string }[] };
      expect(graph.nodes.find(n => n.id === c1)).toMatchObject({ counts: { questions: 2, textbooks: 1, notes: 1, notionBlocks: 1 }, mastery: { status: 'fading', retrievability: 0.42, independentCount: 1 } });
      expect(graph.nodes.find(n => n.id === c2)?.mastery).toMatchObject({ status: 'fragile', retrievability: 0.9, independentCount: 1 });
      expect(graph.edges).toMatchObject([{ kind: 'prereq_of', verified: true }]);
      expect(graph.pendingProposals).toMatchObject([{ commandType: 'content.createKnowledgeEdge' }]);

      const mem = (await get('/api/memory/overview')).body as { categories: Record<string, unknown[]>; stickyDirectives: unknown[]; hypotheses: { text: string; basis: unknown[] }[]; calibration: Record<string, unknown> };
      expect(mem.categories.preference).toHaveLength(2);
      expect(mem.categories.claim).toHaveLength(0);
      expect(mem.categories.state).toHaveLength(1);
      expect(mem.categories.refusal).toHaveLength(1);
      expect(mem.stickyDirectives.length).toBeGreaterThanOrEqual(4);
      expect(mem.hypotheses).toMatchObject([{ text: '能独立完成标准极限求值' }]);
      expect(mem.hypotheses[0]!.basis.length).toBeGreaterThan(0);
      expect(mem.calibration).toMatchObject({ status: 'available', totalReconciliations: 1, confirmed: 1, missed: 0 });
      const weak = (mem as { weaknessSummary?: { status: string; sampleCount: number; neededCount: number; priorityConcepts: { conceptId: string; status: string; uncorrectedErrorCount: number; nextAction: string; evidenceRefs: { href?: string }[] }[]; topErrorStages: unknown[] } }).weaknessSummary;
      expect(weak).toMatchObject({ status: 'ready', sampleCount: 2, neededCount: 2 });
      expect(weak!.priorityConcepts.map(row => [row.conceptId, row.status, row.nextAction, row.uncorrectedErrorCount])).toEqual([[c2, 'weak', 'review_mistake', 1], [c1, 'fading', 'quick_paper', 0]]);
      expect(weak!.priorityConcepts.find(row => row.conceptId === c2)?.evidenceRefs[0]?.href).toBe(`/papers/${paperW}`);
      const pulseHost = { python: { async derive(_d: string, input: unknown) {
        const rows = ((input as { events?: { concept_ids: string[] }[] }).events ?? []).flatMap(ev => ev.concept_ids);
        return { kind: 'ok' as const, outcome: { kind: 'value' as const, value: { method_version: 'cognition@3',
          state_vector: rows.map(concept_id => ({ state: 'known' as const, concept_id, item_novelty: 'transfer',
            representation: null, context: null, method: null,
            uncertainty: { kind: 'interval' as const, low: .1, high: .9 }, evidence_refs: [], r_now: concept_id === c1 ? .42 : .9 })) } } };
      } }, backtrace: () => async () => null };
      const pulsed = await openTransparency(db, pulseHost as never).memoryOverview();
      const pulseWeak = (pulsed as { weaknessSummary?: { priorityConcepts: readonly { conceptId: string; retrievability: number | null }[] } }).weaknessSummary;
      expect(pulseWeak!.priorityConcepts.map(row => [row.conceptId, row.retrievability])).toEqual(graph.nodes.filter(node => pulseWeak!.priorityConcepts.some(row => row.conceptId === node.id)).map(node => [node.id, (node.mastery as { retrievability: number | null }).retrievability]));

      await send('content.correctQuestion', 'revise-qw', { id: qw, expectedRev: 2, patch: { prompt: { block_id: 'p', anchor: 'x^3', replacement: 'x^4' } } }, 'learner', 'storage');
      const weakAfterRevise = ((await get('/api/memory/overview')).body as { weaknessSummary?: { priorityConcepts?: { conceptId: string; uncorrectedErrorCount: number }[] } }).weaknessSummary;
      expect(weakAfterRevise?.priorityConcepts?.find(row => row.conceptId === c2)?.uncorrectedErrorCount ?? -1).toBe(0);

      const ai = (await get('/api/ai/activity')).body as {
        running: unknown[];
        handoffs: { id: string; channel: string; href: string | null }[];
        recentTools: { toolCount: number; basisCount: number }[];
        usage: Record<string, unknown> & { recentCalls: { ownerId: string; model: string | null; route: string | null; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null }[] };
        pendingProposals: { kind: string }[];
      };
      expect(ai.running).toHaveLength(1);
      expect(ai.running).toMatchObject([{ kind: 'teaching', title: '同伴对话' }]);
      expect(new Set(ai.handoffs.map(h => h.channel))).toEqual(new Set(['night_chain', 'retention', 'notion']));
      expect(ai.handoffs.find(h => h.id === turnId2)?.href).toBe(`/classroom/${classroomId}`);
      expect(ai.handoffs.find(h => h.id === turnId)?.href).toBe('/companion');
      expect(ai.recentTools).toMatchObject([{ toolCount: 0, basisCount: 1 }, { toolCount: 2, basisCount: 1 }]);
      expect(ai.usage).toMatchObject({ currency: 'USD_MICROS', spentMicros: 1400, limitMicros: 500000 });
      const call = ai.usage.recentCalls.find(c => c.ownerId === turnId2);
      expect(call).toMatchObject({ model: 'kimi-k3.1-pro', route: 'magpie', promptTokens: 120, completionTokens: 45, totalTokens: 165 });
      expect(ai.usage.recentCalls.find(c => c.ownerId === turnId)?.model).toBe('group/powerful');
      expect(new Set(ai.pendingProposals.map(p => p.kind))).toEqual(new Set(['knowledge_edge', 'textbook_patch', 'question_draft', 'question_meta']));

      // Revoke Notion selection, revoke companion turn teaching access, and bump c1 access_epoch
      await notion.mutate('revoke', { requestId: 'notion-revoke-1', deletionWatermark: '0', selectionId: 'calc-notion', expectedEpoch: '1' });
      await send('activity.setWorkspaceTeaching', 'revoke-turn', { id: turnId, expectedRev: 1, enabled: false }, 'learner', 'storage');
      await send('activity.setWorkspaceTeaching', 'revoke-turn2', { id: turnId2, expectedRev: 1, enabled: false }, 'learner', 'storage');
      await send('activity.setWorkspaceTeaching', 'revoke-ord', { id: ordinaryAttemptId, expectedRev: 2, enabled: false }, 'learner', 'storage');
      await db.tx({ learner: studioLearner }, async tx => tx.withLearnerWrite(async tick => {
        await tx.query('UPDATE facts SET access_epoch=access_epoch+1, changed_tick=$2 WHERE learner_id=$1 AND id=$3', [studioLearner, tick, c1]);
        await tx.query('UPDATE facts SET retracted_rev=current_rev, changed_tick=$2 WHERE learner_id=$1 AND id=$3', [studioLearner, tick, postSubId]);
        await tx.query('UPDATE facts SET retracted_rev=current_rev, changed_tick=$2 WHERE learner_id=$1 AND id=$3', [studioLearner, tick, postSub2Id]);
      }));

      const graphAfter = (await get('/api/knowledge/graph')).body as { nodes: { id: string; counts: Record<string, number>; mastery: Record<string, unknown> }[]; edges: unknown[]; pendingProposals: unknown[] };
      expect(graphAfter.nodes.find(n => n.id === c1)).toMatchObject({ counts: { questions: 0, textbooks: 0, notes: 0, notionBlocks: 0 }, mastery: { status: 'unknown', retrievability: null, independentCount: 0, basisRefs: [] } });
      expect(graphAfter.edges).toEqual([]);
      expect(graphAfter.pendingProposals).toEqual([]);

      const memAfter = (await get('/api/memory/overview')).body as { categories: Record<string, { factType: string }[]>; hypotheses: unknown[]; calibration: Record<string, unknown> };
      expect(memAfter.categories.preference).toMatchObject([{ factType: 'learner.preference' }]);
      expect(memAfter.categories.state).toEqual([]);
      expect(memAfter.categories.refusal).toEqual([]);
      expect(memAfter.hypotheses).toEqual([]);
      expect(memAfter.calibration).toMatchObject({ status: 'unknown', totalReconciliations: 0, confirmed: 0, missed: 0, recent: [] });
      const weakAfter = (memAfter as { weaknessSummary?: { status: string; sampleCount: number; neededCount: number; topErrorStages: unknown[]; priorityConcepts: unknown[] } }).weaknessSummary;
      expect(weakAfter).toMatchObject({ status: 'insufficient_evidence', sampleCount: 0, neededCount: 2, topErrorStages: [], priorityConcepts: [] });
      expect(weakAfter!.priorityConcepts).toHaveLength(0);

      const aiAfter = (await get('/api/ai/activity')).body as { handoffs: { channel: string }[]; recentTools: unknown[] };
      expect(aiAfter.recentTools).toEqual([]);
      expect(aiAfter.handoffs.some(h => h.channel === 'notion' || h.channel === 'night_chain')).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }));
