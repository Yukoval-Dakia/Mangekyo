import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { FactChange } from '../../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createCommandReadContext } from '../../../kernel/src/commands/reads.ts';
import { commandId, factId, type Revision } from '../../../kernel/src/declarations/ids.ts';
import type { Json } from '../../../kernel/src/declarations/types.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { notionSelectionWitness, readNotionSelection } from '../../../modules/capture/notion-selection.ts';
import { notionBlockDeriver, notionBlockSlot, notionBlockWorkKey, prepareNotionIngest } from '../../../modules/capture/notion-source.ts';
import { captureSourceCommand, captureSourceType } from '../../../modules/capture/source.ts';
import { createStudioCommandHooks } from '../command-hooks.ts';
import { notionModelRecipient, slotType as teachingSlotType, stableId, studioLearner } from '../identity.ts';
import { openStudioNotion, readStudioNotionSource } from '../notion.ts';
import { loadStudioTestModule } from './modules.ts';

it.skipIf(!testDatabaseUrl)('binds the Notion settings receipt to the command and current generation', () =>
  withLearnerDatabase(studioLearner, async db => {
    const host = openStudioNotion(db, await loadStudioTestModule('capture'));
    const target = {requestId:'settings-first', deletionWatermark:'0', selectionId:'course', expectedEpoch:'0'};
    const grant = {...target, root:{kind:'page', id:'00000000000000000000000000000001'}, preset:'storage', recipients:[]};
    const first = await host.mutate('grant', grant);
    expect(await host.mutate('grant', grant)).toEqual(first);
    await expect(host.mutate('grant', {...grant, preset:'learning'})).rejects.toMatchObject({status:409});
    await expect(host.mutate('grant', {...grant, requestId:'settings-temp', preset:'temporary'})).rejects.toMatchObject({status:422});
    const revoke = {...target, requestId:'settings-revoke', expectedEpoch:'1'};
    expect(await host.mutate('revoke', revoke)).toMatchObject({active:false, epoch:'2'});
    await expect(host.mutate('grant', grant)).rejects.toMatchObject({status:409});
    expect((await host.settings()).selections).toMatchObject([{active:false, sources:[]}]);
  }));

it.skipIf(!testDatabaseUrl)('propagates afterFactsChanged, recipient-scoped selection invalidation, and source retract block retirement', () =>
  withLearnerDatabase(studioLearner, async db => {
    const dir = mkdtempSync(join(tmpdir(), 'mangekyo-notion-pg-'));
    const prevSettings = process.env.MANGEKYO_SETTINGS_FILE, prevAccess = process.env.MANGEKYO_WORKSPACE_ACCESS_FILE;
    const baseUrl = 'https://model.example/v1', provider = (id: string, model: string) => ({
      id, label: id, baseUrl, protocol: 'openai' as const, model, reasoningEffort: 'high', apiKey: 'test', credentialRevision: 'cred-1',
    });
    const route = (revision: string) => ({ enabled: true, baseUrl, protocol: 'openai', revision, credentialRevision: 'cred-1' });
    writeFileSync(join(dir, 'provider.json'), JSON.stringify({
      version: 2, activeProviderId: 'alpha', allowSearch: false, mcpServers: [], providers: [provider('alpha', 'm-a'), provider('beta', 'm-b')],
    }));
    writeFileSync(join(dir, 'access.json'), JSON.stringify({ version: 1, routes: { alpha: route('rev-a'), beta: route('rev-b') } }));
    process.env.MANGEKYO_SETTINGS_FILE = join(dir, 'provider.json');
    process.env.MANGEKYO_WORKSPACE_ACCESS_FILE = join(dir, 'access.json');
    try {
      const capture = await loadStudioTestModule('capture');
      const received: FactChange[] = [];
      const host = openStudioNotion(db, capture, async (_tx, _tick, changes) => { received.push(...changes); });
      const reader = { id: 'studio:learning-reader', purpose: 'learning' };
      const modelA = { id: notionModelRecipient('alpha', baseUrl, 'openai', 'm-a', 'rev-a'), purpose: 'teaching' };
      const modelB = { id: notionModelRecipient('beta', baseUrl, 'openai', 'm-b', 'rev-b'), purpose: 'teaching' };
      const [page1, page2, block1, block2] = ['1', '2', '3', '4'].map(num => `00000000-0000-0000-0000-00000000000${num}`) as [string, string, string, string];
      await host.mutate('grant', {
        requestId: 'notion-grant-1', deletionWatermark: '0', selectionId: 'course', expectedEpoch: '0',
        root: { kind: 'page', id: page1 }, preset: 'learning', recipients: [reader, modelA, modelB],
      });
      expect(received.at(-1)).toMatchObject({ factType: 'capture.notionSelection', kind: 'create' });
      const ingest = async (pageId: string, key: string) => {
        const sel = (await db.snapshot({ learner: studioLearner }, tx => readNotionSelection(createCommandReadContext(tx, 'storage'), studioLearner, 'course')))!;
        const payload = await prepareNotionIngest(sel, {
          root: sel.root, dispatch: notionSelectionWitness(sel), pageId, title: '微积分', lastEditedTime: '2026-11-21T08:00:00.000Z',
          blocks: [block1, block2].map(id => ({ id, parentId: null, text: `要点 ${id}`, body: { type: 'paragraph', data: {} } })),
        }, '2026-11-21T08:00:00.000Z');
        await createCommandHandler(db, { modules: [capture], hooks: createStudioCommandHooks() })({
          learner: studioLearner, actor: 'companion', purpose: 'storage', id: commandId(stableId('ingest', key)),
          type: captureSourceCommand, input: { ...payload, purpose: ['storage', 'learning', 'teaching'] } as unknown as Json,
        });
        return payload.id;
      };
      const src1 = await ingest(page1, 'p1');
      const [turnA, turnB, derA, derB, derRead, derStore, workA, workB, workRead] =
        ['tA', 'tB', 'dA', 'dB', 'dR', 'dS', 'wA', 'wB', 'wR'].map(tag => stableId('npg', tag)) as [string, string, string, string, string, string, string, string, string];
      const b1Key = notionBlockWorkKey({ id: src1, rev: 1 as Revision, accessEpoch: '0', blockId: block1 });
      const b2Key = notionBlockWorkKey({ id: src1, rev: 1 as Revision, accessEpoch: '0', blockId: block2 });
      await db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(async tick => {
        const mkManifest = (purpose: string) => JSON.stringify({ version: 1, learner: studioLearner, purpose, gatherTick: tick,
          inputs: [{ kind: 'fact', id: src1, rev: 1, accessEpoch: '0', mode: 'pinned' }] });
        for (const [id, prov, model, rev] of [[turnA, 'alpha', 'm-a', 'rev-a'], [turnB, 'beta', 'm-b', 'rev-b']] as const) {
          await tx.insert('facts', { learner_id: studioLearner, id, type: 'activity.studyTurn', current_rev: 1, access_epoch: 0, purpose: ['teaching'], sticky: false, created_tick: tick, changed_tick: tick });
          await tx.insert('fact_revs', { learner_id: studioLearner, fact_id: id, rev: 1, data: JSON.stringify({ providerId: prov, baseUrl, protocol: 'openai', model, workspaceRevision: rev }), purpose: ['teaching'], sticky: false, kind: 'value', author: 'learner', command_id: stableId('cmd', id), tick });
        }
        const seedDer = async (id: string, slotType: string, slotKey: string, purpose: string, scope: Record<string, string>) => {
          await tx.insert('derivations', { learner_id: studioLearner, id, slot_type: slotType, slot_key: slotKey, deriver: 'test', scope_keys: JSON.stringify(scope), value: '{}', lifecycle: 'effective', freshness: 'current', gather_tick: tick, effective_tick: tick, manifest: mkManifest(purpose) });
          await tx.insert('slot_state', { learner_id: studioLearner, slot_type: slotType, slot_key: slotKey, current_id: id, last_id: id, pending: 'none', scope_keys: JSON.stringify(scope), changed_tick: tick });
        };
        await seedDer(derA, teachingSlotType, turnA, 'teaching', {});
        await seedDer(derB, teachingSlotType, turnB, 'teaching', {});
        await seedDer(derRead, notionBlockSlot, b1Key, 'learning', { purpose: 'learning', recipientId: reader.id });
        await seedDer(derStore, 'test.storage', src1, 'storage', { purpose: 'storage', recipientId: studioLearner });
        for (const [id, slotKey, scope, purpose] of [[workA, b2Key, { purpose: 'teaching', recipientId: modelA.id }, 'teaching'],
          [workB, stableId('wb'), { purpose: 'teaching', recipientId: modelB.id }, 'teaching'],
          [workRead, stableId('wr'), { purpose: 'learning', recipientId: reader.id }, 'learning']] as const) {
          const slotType = slotKey === b2Key ? notionBlockSlot : 'test.work';
          await tx.insert('slot_state', { learner_id: studioLearner, slot_type: slotType, slot_key: slotKey, pending: 'queued', scope_keys: JSON.stringify(scope), changed_tick: tick });
          await tx.insert('work', { learner_id: studioLearner, id, slot_type: slotType, slot_key: slotKey, deriver: notionBlockDeriver, state: 'ready', generation: 1, requested_tick: tick, execution_ref: stableId('ex', id), gather_manifest: slotKey === b2Key ? null : mkManifest(purpose) });
        }
      }));
      const states = () => db.snapshot({ learner: studioLearner }, async tx => ({
        der: Object.fromEntries((await tx.query<{ id: string; lifecycle: string }>('SELECT id, lifecycle FROM derivations WHERE learner_id=$1', [studioLearner])).rows.map(r => [r.id, r.lifecycle])),
        work: Object.fromEntries((await tx.query<{ id: string; state: string }>('SELECT id, state FROM work WHERE learner_id=$1', [studioLearner])).rows.map(r => [r.id, r.state])),
      }));
      const canRead = (id: string, use: { id: string; purpose: string }) => db.snapshot({ learner: studioLearner }, tx =>
        readStudioNotionSource(tx, factId(id), { mode: 'following' }, { purpose: use.purpose, recipientId: use.id, maySend: () => true }));
      await host.mutate('revoke', { requestId: 'notion-revoke-a', deletionWatermark: '0', selectionId: 'course', expectedEpoch: '1', recipient: modelA });
      expect(received.at(-1)).toMatchObject({ factType: 'capture.notionSelection', kind: 'correct' });
      expect(await states()).toEqual({ der: { [derA]: 'stale', [derB]: 'effective', [derRead]: 'effective', [derStore]: 'effective' }, work: { [workA]: 'cancelled', [workB]: 'ready', [workRead]: 'ready' } });
      await expect(canRead(src1, modelA)).rejects.toThrow();
      await expect(canRead(src1, modelB)).resolves.toMatchObject({ ref: { id: src1 } });
      await expect(canRead(src1, reader)).resolves.toMatchObject({ ref: { id: src1 } });
      await host.mutate('grant', {
        requestId: 'notion-grant-root', deletionWatermark: '0', selectionId: 'course', expectedEpoch: '2',
        root: { kind: 'page', id: page2 }, preset: 'learning', recipients: [reader, modelB],
      });
      expect(await states()).toEqual({ der: { [derA]: 'stale', [derB]: 'stale', [derRead]: 'stale', [derStore]: 'stale' }, work: { [workA]: 'cancelled', [workB]: 'cancelled', [workRead]: 'cancelled' } });
      await expect(canRead(src1, modelB)).rejects.toThrow();
      await expect(canRead(src1, { id: studioLearner, purpose: 'storage' })).rejects.toThrow();
      const src2 = await ingest(page2, 'p2');
      const [dBlock1, dDownstream, wReady, wBlocked] = ['db1', 'ddown', 'wr2', 'wb2'].map(tag => stableId('ret', tag)) as [string, string, string, string];
      const s2b1 = notionBlockWorkKey({ id: src2, rev: 1 as Revision, accessEpoch: '0', blockId: block1 });
      const s2b2 = notionBlockWorkKey({ id: src2, rev: 1 as Revision, accessEpoch: '0', blockId: block2 });
      await db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(async tick => {
        await tx.insert('derivations', { learner_id: studioLearner, id: dBlock1, slot_type: notionBlockSlot, slot_key: s2b1, deriver: notionBlockDeriver, scope_keys: '{}', value: '{}', lifecycle: 'effective', freshness: 'current', gather_tick: tick, effective_tick: tick, manifest: JSON.stringify({ version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: tick, inputs: [{ kind: 'fact', id: src2, rev: 1, accessEpoch: '0', mode: 'pinned' }] }) });
        await tx.insert('slot_state', { learner_id: studioLearner, slot_type: notionBlockSlot, slot_key: s2b1, current_id: dBlock1, last_id: dBlock1, pending: 'none', scope_keys: '{}', changed_tick: tick });
        await tx.insert('derivations', { learner_id: studioLearner, id: dDownstream, slot_type: 'test.down', slot_key: 'k', deriver: 'test', scope_keys: '{}', value: '{}', lifecycle: 'effective', freshness: 'current', gather_tick: tick, effective_tick: tick, manifest: JSON.stringify({ version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: tick, inputs: [{ kind: 'slot', slotType: notionBlockSlot, slotKey: s2b1, derivationId: dBlock1, mode: 'pinned' }] }) });
        await tx.insert('slot_state', { learner_id: studioLearner, slot_type: 'test.down', slot_key: 'k', current_id: dDownstream, last_id: dDownstream, pending: 'none', scope_keys: '{}', changed_tick: tick });
        await tx.insert('slot_state', { learner_id: studioLearner, slot_type: notionBlockSlot, slot_key: s2b2, pending: 'queued', scope_keys: '{}', changed_tick: tick });
        await tx.insert('work', { learner_id: studioLearner, id: wReady, slot_type: notionBlockSlot, slot_key: s2b2, deriver: notionBlockDeriver, state: 'ready', generation: 1, requested_tick: tick, execution_ref: stableId('ex', wReady) });
        await tx.insert('work', { learner_id: studioLearner, id: wBlocked, slot_type: notionBlockSlot, slot_key: s2b1, deriver: notionBlockDeriver, state: 'blocked', generation: 1, requested_tick: tick, execution_ref: stableId('ex', wBlocked) });
      }));
      const beforeCount = received.length;
      const retractReq = { requestId: 'notion-retract-src2', deletionWatermark: '0', selectionId: 'course', expectedEpoch: '3', expectedRev: 1, accessEpoch: '0' };
      const retracted = await host.mutate('retract', retractReq, src2);
      expect(retracted).toEqual({ id: src2, rev: 2, accessEpoch: '1', retracted: true });
      expect(await host.mutate('retract', retractReq, src2)).toEqual(retracted);
      expect(received.slice(beforeCount)).toMatchObject([{ factType: captureSourceType, kind: 'retract', ref: { id: src2, rev: 2 } }]);
      expect(await states()).toMatchObject({ der: { [dBlock1]: 'stale', [dDownstream]: 'stale' }, work: { [wReady]: 'cancelled', [wBlocked]: 'cancelled' } });
      await expect(canRead(src2, { id: studioLearner, purpose: 'storage' })).rejects.toThrow();
    } finally {
      if (prevSettings === undefined) delete process.env.MANGEKYO_SETTINGS_FILE; else process.env.MANGEKYO_SETTINGS_FILE = prevSettings;
      if (prevAccess === undefined) delete process.env.MANGEKYO_WORKSPACE_ACCESS_FILE; else process.env.MANGEKYO_WORKSPACE_ACCESS_FILE = prevAccess;
      rmSync(dir, { recursive: true, force: true });
    }
  }));
