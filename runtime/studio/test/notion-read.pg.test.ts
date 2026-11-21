import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createCommandReadContext } from '../../../kernel/src/commands/reads.ts';
import { commandId } from '../../../kernel/src/declarations/ids.ts';
import type { Json } from '../../../kernel/src/declarations/types.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { notionSelectionWitness, readNotionSelection } from '../../../modules/capture/notion-selection.ts';
import { prepareNotionIngest } from '../../../modules/capture/notion-source.ts';
import { captureSourceCommand } from '../../../modules/capture/source.ts';
import { createLearningTurn } from '../../../executors/teaching/learning-turn.ts';
import type { LearningTools } from '../../../executors/teaching/learning-tools.ts';
import { studyToolResults } from '../../../executors/teaching/study-tool-results.ts';
import { createStudioCommandHooks } from '../command-hooks.ts';
import { notionModelRecipient, stableId, studioLearner } from '../identity.ts';
import { openLearningTools } from '../learning-tools.ts';
import { confirmNotionRead, notionSendBasis, openStudioNotion } from '../notion.ts';
import { loadStudioTestModule } from './modules.ts';

const page = '00000000-0000-0000-0000-000000000001';
const block = '00000000-0000-0000-0000-00000000000b';
const list = (results: unknown[]) => ({object: 'list', results, has_more: false, next_cursor: null});
const paragraph = (id: string, text: string) => ({object: 'block', id, type: 'paragraph', has_children: false,
  paragraph: {rich_text: [{plain_text: text}]}});
const meta = (edited: string) => ({object: 'page', id: page, last_edited_time: edited, properties: {}});

async function notionFixture(state: {edited: string; text: string; status?: number | undefined}) {
  const server = createServer((req, res) => {
    const status = state.status ?? 200;
    const reply = req.url === `/v1/pages/${page}` ? meta(state.edited)
      : req.url?.startsWith(`/v1/blocks/${page}/children`) ? list([paragraph(block, state.text)]) : {};
    res.writeHead(status, {'Content-Type': 'application/json'}).end(JSON.stringify(reply));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {server, origin: `http://127.0.0.1:${(server.address() as {port: number}).port}`};
}

it.skipIf(!testDatabaseUrl)('wires notion_read through the authorized host port end to end', () =>
  withLearnerDatabase(studioLearner, async db => {
    const state = {edited: '2026-11-21T08:00:00.000Z', text: 'old text', status: undefined as number | undefined};
    const {server, origin} = await notionFixture(state);
    const dir = mkdtempSync(join(tmpdir(), 'mangekyo-notion-read-'));
    const prev = process.env.MANGEKYO_NOTION_TEST_ORIGIN, prevSettings = process.env.MANGEKYO_SETTINGS_FILE,
      prevAccess = process.env.MANGEKYO_WORKSPACE_ACCESS_FILE;
    const baseUrl = 'https://model.example/v1';
    writeFileSync(join(dir, 'provider.json'), JSON.stringify({version: 2, activeProviderId: 'alpha', allowSearch: false,
      mcpServers: [], providers: [{id: 'alpha', label: 'alpha', baseUrl, protocol: 'openai', model: 'm-a',
        reasoningEffort: 'high', apiKey: 'test', credentialRevision: 'cred-1'}]}));
    writeFileSync(join(dir, 'access.json'), JSON.stringify({version: 1,
      routes: {alpha: {enabled: true, baseUrl, protocol: 'openai', revision: 'rev-a', credentialRevision: 'cred-1'}}}));
    process.env.MANGEKYO_NOTION_TEST_ORIGIN = origin;
    process.env.MANGEKYO_SETTINGS_FILE = join(dir, 'provider.json');
    process.env.MANGEKYO_WORKSPACE_ACCESS_FILE = join(dir, 'access.json');
    try {
      const capture = await loadStudioTestModule('capture');
      const notion = openStudioNotion(db, capture);
      const modelId = notionModelRecipient('alpha', baseUrl, 'openai', 'm-a', 'rev-a');
      const maySend = Object.assign(() => true, {notionRecipientId: modelId});
      await notion.mutate('grant', {requestId: 'nr-grant', deletionWatermark: '0', selectionId: 'course',
        expectedEpoch: '0', root: {kind: 'page', id: page}, preset: 'learning',
        recipients: [{id: 'studio:learning-reader', purpose: 'learning'}, {id: modelId, purpose: 'teaching'}]});
      const sel = (await db.snapshot({learner: studioLearner}, tx =>
        readNotionSelection(createCommandReadContext(tx, 'storage'), studioLearner, 'course')))!;
      const ingest = await prepareNotionIngest(sel, {
        root: sel.root, dispatch: notionSelectionWitness(sel), pageId: page, title: '微积分', lastEditedTime: state.edited,
        blocks: [{id: block, parentId: null, text: 'old text', body: {type: 'paragraph', data: {}}}],
      }, state.edited);
      await createCommandHandler(db, {modules: [capture], hooks: createStudioCommandHooks()})({
        learner: studioLearner, actor: 'companion', purpose: 'storage', id: commandId(stableId('ingest', 'nr')),
        type: captureSourceCommand, input: {...ingest, purpose: ['storage', 'learning', 'teaching']} as unknown as Json,
      });
      const tracked = new Map<string, {id: string; rev: number; epoch: string; type: string; mode?: string}>();
      const tools: LearningTools = openLearningTools({
        db, turn: 'turn-nr', manageBeliefs: false, maySend, notion,
        workspace: {presentationTool: undefined, knows: () => false, writes: () => [],
          executeRead: async () => '{}', execute: async () => '{}'} as never,
        authorize: async () => {}, trackRetention: () => {},
        track: witness => tracked.set(`${witness.id}:${witness.rev}`, witness),
        async authorizeRemote() {
          try {
            return await confirmNotionRead(db, studioLearner, async (tx, check) => {
              await notionSendBasis(tx, [...tracked.values()].map(w =>
                ({...w, type: 'capture.source'})), maySend, check);
              return true;
            });
          } catch { return false; }
        },
        onDelivered: () => {}, readContext: async () => undefined, saveBelief: async () => '',
      });
      const learning = createLearningTurn(tools, studyToolResults(), async (_, invoke) => invoke('r'), 'm');
      expect(learning.resident.map(t => t.function.name)).not.toContain('notion_read');
      expect(learning.discoverable.map(t => t.function.name)).toContain('notion_read');
      const read = await learning.execute('notion_read', {source_id: ingest.id}, 1, Promise.resolve());
      const body = JSON.parse(read!.content);
      expect(body).toMatchObject({ok: true, data: {sourceId: ingest.id, status: 'refreshed',
        title: '微积分', blocks: [{id: block, text: 'old text'}]}});
      state.text = 'new text ' + 'x'.repeat(3000); state.edited = '2026-11-21T09:00:00.000Z';
      const fresh = await learning.execute('notion_read', {source_id: ingest.id, refresh: true}, 2, Promise.resolve());
      const freshBody = JSON.parse(fresh!.content);
      const handle = (freshBody.handle ?? freshBody.data?.handle) as string | undefined;
      expect(handle ?? freshBody).toMatch(/^@res_/);
      const again = await learning.execute('notion_read', {source_id: ingest.id, refresh: true}, 3, Promise.resolve());
      const againBody = JSON.parse(again!.content);
      expect(againBody).toMatchObject({ok: true, archived: true});
      const expanded = await learning.execute('open_tool_result', {handle: againBody.handle}, 4, Promise.resolve());
      expect(JSON.parse(expanded!.content).text).toContain('"rev":2');
      expect(JSON.parse(expanded!.content).text).toContain('"status":"unchanged"');
      await notion.mutate('revoke', {requestId: 'nr-revoke', deletionWatermark: '0', selectionId: 'course',
        expectedEpoch: '1', recipient: {id: modelId, purpose: 'teaching'}});
      const denied = await learning.execute('notion_read', {source_id: ingest.id}, 5, Promise.resolve());
      expect(JSON.parse(denied!.content)).toMatchObject({ok: false, code: 'access_revoked', field: 'source_id'});
      const opened = await learning.execute('open_tool_result', {handle: handle!}, 6, Promise.resolve());
      expect(JSON.parse(opened!.content)).toMatchObject({ok: false, code: 'access_revoked'});
    } finally {
      if (prev === undefined) delete process.env.MANGEKYO_NOTION_TEST_ORIGIN; else process.env.MANGEKYO_NOTION_TEST_ORIGIN = prev;
      if (prevSettings === undefined) delete process.env.MANGEKYO_SETTINGS_FILE; else process.env.MANGEKYO_SETTINGS_FILE = prevSettings;
      if (prevAccess === undefined) delete process.env.MANGEKYO_WORKSPACE_ACCESS_FILE; else process.env.MANGEKYO_WORKSPACE_ACCESS_FILE = prevAccess;
      server.close();
      rmSync(dir, {recursive: true, force: true});
    }
  }));
