import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { commandId, factId, type FactId } from '../../../kernel/src/declarations/ids.ts';
import type { Json } from '../../../kernel/src/declarations/types.ts';
import { intakeQuestionId } from '../../../modules/content/intake-question-bank.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { stableId, studioLearner } from '../identity.ts';
import { intakeWriteTargets } from '../intake.ts';
import { serve } from '../http.ts';
import { openWorkbook } from '../workbook.ts';
import { loadStudioTestModule } from './modules.ts';

it.skipIf(!testDatabaseUrl)('issues authorized node quick papers and filters revoked questions', () =>
  withLearnerDatabase(studioLearner, async db => {
    const [activity, capture, content] = await Promise.all(['activity', 'capture', 'content'].map(loadStudioTestModule));
    const handle = createCommandHandler(db, { modules: [activity!, capture!, content!], hooks: { async onFactsChanged() {} }, crossModuleWrites: intakeWriteTargets });
    const send = (type: string, key: string, input: Json, purpose = 'teaching') => handle({
      learner: studioLearner, actor: 'learner', purpose, id: commandId(stableId('qp-cmd', key)), type, input,
    });
    const id = (key: string) => factId(stableId('qp', key));
    const use = (factId: FactId, rev = 1) => ({ id: factId, rev, accessEpoch: '0' });
    const noteId = id('note');
    await send('activity.saveWorkspaceEntry', 'note', { id: noteId, entry: { kind: 'page', title: '证据', body: '先修与变式', tags: [], links: [] }, basis: [] });
    const noteUse = use(noteId);
    const concept = async (key: string, name: string) => send('content.createKnowledgeEntity', key, {
      id: id(key), purpose: 'teaching', entity: { kind: 'concept', canonicalName: name, aliases: [], merged_into: null },
      resolution: { decision: 'no-match', reason: '新概念', candidates: [], sourceUses: [noteUse] },
    });
    await concept('empty', '空节点'); await concept('pre', '先修'); await concept('target', '目标'); await concept('variant-target', '变式目标');
    const question = async (key: string, prompt: string) => send('activity.saveWorkspaceEntry', key, {
      id: id(key), entry: { kind: 'question', title: key, body: prompt, answer: key, tags: [], links: [] }, basis: [{ id: noteId, rev: 1, epoch: '0' }],
    });
    const edge = (key: string, value: Json, purpose = 'teaching') => send('content.createKnowledgeEdge', key, { id: id(key), purpose, edge: value }, purpose);
    await edge('pre-target', { kind: 'prereq_of', scope: 'qp', from: { kind: 'concept', sourceUse: use(id('pre')) }, to: { kind: 'concept', sourceUse: use(id('target')) }, sourceUses: [use(id('pre')), use(id('target'))] });
    await question('pre-q', '先修题');
    await edge('pre-q-link', { kind: 'targets_concept', scope: 'qp', from: { kind: 'question', sourceUse: use(id('pre-q')) }, to: { kind: 'concept', sourceUse: use(id('pre')) }, sourceUses: [use(id('pre-q')), use(id('pre'))] });
    await question('base-q', '母题');
    await edge('base-link', { kind: 'targets_concept', scope: 'qp', from: { kind: 'question', sourceUse: use(id('base-q')) }, to: { kind: 'concept', sourceUse: use(id('variant-target')) }, sourceUses: [use(id('base-q')), use(id('variant-target'))] });
    await question('variant-q', '变式题');
    await edge('variant', { kind: 'variant_of', scope: 'qp', from: { kind: 'question', sourceUse: use(id('variant-q')) }, to: { kind: 'question', sourceUse: use(id('base-q')) }, sourceUses: [use(id('variant-q')), use(id('base-q'))], variant: { familyId: 'qp', preserved: ['题型'], changed: ['数字'], spoilsNext: 'former' } });
    await concept('asset-node', '资产节点');
    const materialId = id('asset-material'); const intakeId = id('asset-intake');
    await send('activity.captureIntake', 'asset-material', { materialId, intakeId, title: '资产材料', original: { name: 'asset.txt', mediaType: 'text/plain', size: 4, sha256: 'a'.repeat(64) }, extraction: { status: 'ok', method: 'utf8', text: '资产题干', error: null, warnings: [], pages: null, truncated: false, characterCount: 4 } }, 'storage');
    await send('content.confirmIntakeQuestions', 'asset-q', { confirmedByLearner: true, materialId, expectedMaterialRev: 1, purpose: 'storage', items: [{ draftId: 'draft-1', title: '资产题', stem: '资产题干' }] }, 'storage');
    const assetQ = await intakeQuestionId(materialId, 'draft-1');
    await edge('asset-link', { kind: 'targets_concept', scope: 'qp', from: { kind: 'question', sourceUse: use(assetQ) }, to: { kind: 'concept', sourceUse: use(id('asset-node')) }, sourceUses: [use(assetQ), use(id('asset-node'))] }, 'storage');

    const student = { workbook: openWorkbook(db, activity!) } as never;
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as {port: number}).port; await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    const server = serve(db, {} as never, {} as never, {} as never, student, port);
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    const call = async (node: string, requestId: string, count?: number) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as {port: number}).port}/api/knowledge/graph/${node}/quick-paper`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, ...(count === undefined ? {} : { count }) }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    try {
      expect(await call('01KFS4AAA00000000000000099', 'unknown-node')).toMatchObject({ status: 404, body: { error: '找不到这个知识点。' } });
      expect(await call(id('empty'), 'empty-node')).toMatchObject({ status: 200, body: { kind: 'empty', suggestedAction: 'start_classroom', reason: '该知识点尚未收录可自测题，建议先开 10 分钟微课或拍入相关练习。' } });
      const first = await call(id('target'), 'prereq-request');
      expect(first).toMatchObject({ status: 201, body: { kind: 'paper', title: '目标 · 节点自测', questionCount: 1, href: `/papers/${first.body.paperId}` } });
      expect(first.body.basis).toMatchObject([{ scope: 'prerequisite', questionRef: id('pre-q') }]);
      expect((await fetch(`http://127.0.0.1:${(server.address() as {port: number}).port}/api/papers/${first.body.paperId}`)).status).toBe(200);
      expect(await call(id('target'), 'prereq-request')).toMatchObject({ status: 201, body: { paperId: first.body.paperId } });
      const inherited = await call(id('variant-target'), 'variant-request', 2);
      expect(inherited.body).toMatchObject({ kind: 'paper', questionCount: 2 });
      await db.tx({ learner: studioLearner }, async tx => tx.withLearnerWrite(tick =>
        tx.query('UPDATE facts SET retracted_rev=current_rev, changed_tick=$2 WHERE learner_id=$1 AND id=$3', [studioLearner, tick, id('variant-q')])));
      expect(await call(id('variant-target'), 'after-revoke')).toMatchObject({ status: 201, body: { kind: 'paper', questionCount: 1 } });
      const asset = await call(id('asset-node'), 'asset-request');
      expect(asset).toMatchObject({ status: 201, body: { kind: 'paper', questionCount: 1, href: `/papers/${asset.body.paperId}` } });
      expect((await fetch(`http://127.0.0.1:${(server.address() as {port: number}).port}/api/papers/${asset.body.paperId}`)).status).toBe(200);
      expect(await call(id('variant-target'), 'empty-request', 0)).toMatchObject({ status: 400, body: { error: '抽题数量须为 1 到 5。' } });
      expect(await call(id('variant-target'), 'bad', 1).then(result => ({...result, body: {error: result.body.error}}))).toMatchObject({ status: 400, body: { error: '抽题请求标识无效。' } });
    } finally { server.close(); }
  }));
