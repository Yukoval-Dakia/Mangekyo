import { createServer } from 'node:http';
import { once } from 'node:events';
import { openNotionReadTransport } from '../../executors/document-extraction/notion.ts';
import { expect, it, vi } from 'vitest';
import { learnerId } from '@mangekyo/kernel';
import { NotionChildUnavailable, NotionSourceUnconfirmed, notionReadPage, notionReadRows, notionVersion } from './notion-api.ts';
import { applyNotionSourceInvalidation, notionBoundedSnapshotForSend, openNotionBoundedSnapshot, prepareNotionBoundedSnapshot, type NotionBoundedSnapshot, type NotionBoundedUse } from './notion-source.ts';
import { notionSourceProjection } from './notion-values.ts';

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const timestamp = '2026-11-20T12:00:00.000Z';
const root = { kind: 'data-source', id: id(1) } as const;
const listed = (results: unknown[], next_cursor: string | null = null) => ({ object: 'list', results, next_cursor, has_more: next_cursor !== null });
const block = (n: number, has_children = false) => ({ object: 'block', id: id(n), type: 'paragraph', has_children,
  paragraph: { rich_text: [{ plain_text: `块 ${n}` }] } });
const row = (n: number) => ({ object: 'page', id: id(n), last_edited_time: timestamp,
  parent: { type: 'data_source_id', data_source_id: root.id }, properties: {
    Name: { id: 'title', type: 'title', title: [{ plain_text: '滴定' }] }, Due: { id: 'due', type: 'date', date: { start: '2026-11-25' } },
    Related: { id: 'relation', type: 'relation', relation: [{ id: id(21) }], has_more: true },
  } });

it('reads paginated sources and closes bounded handles at the scope of remote access loss', async ({ onTestFinished }) => {
  type Failure = { scope: 'root' | 'child' | 'page' | 'moved'; status: number; after?: Failure };
  let denied: Failure | undefined;
  let signature = 'first-test-signature';
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer isolated-token' || request.headers['notion-version'] !== notionVersion) {
      response.writeHead(401).end();
      return;
    }
    const url = new URL(request.url!, 'http://127.0.0.1');
    let outgoing: unknown;
    if (request.method === 'POST' && url.pathname === `/v1/data_sources/${root.id}/query`) {
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw);
      if (body.filter?.last_edited_time?.on_or_after !== timestamp) return void response.writeHead(422).end();
      if (body.start_cursor && body.start_cursor !== 'rows-next') return void response.writeHead(422).end();
      outgoing = body.start_cursor ? listed([row(2)]) : listed([row(3)], 'rows-next');
    } else if (url.pathname === `/v1/pages/${id(2)}`) {
      if (denied?.scope === 'page') return void response.writeHead(denied.status).end();
      outgoing = denied?.scope === 'moved' ? { ...row(2), parent: { type: 'data_source_id', data_source_id: id(9) } } : row(2);
    } else if (url.pathname === `/v1/blocks/${id(2)}/children`) {
      if (denied?.scope === 'root' && url.searchParams.has('start_cursor')) return void response.writeHead(denied.status).end();
      outgoing = url.searchParams.has('start_cursor') ? listed([block(7), { ...block(8), type: 'file',
        file: { type: 'file', name: 'worksheet.pdf', file: { url: `https://example.org/doc?signature=${signature}`, expiry_time: timestamp } } }])
        : listed([block(4, true)], 'block+/next');
    } else if (url.pathname === `/v1/blocks/${id(4)}/children`) {
      if (denied?.scope === 'child') {
        const { status, after } = denied;
        denied = after;
        return void response.writeHead(status).end();
      }
      outgoing = listed([block(5)]);
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(outgoing));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(() => server[Symbol.asyncDispose]());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test listener');
  const transport = openNotionReadTransport(`http://127.0.0.1:${address.port}`, 'isolated-token', notionVersion,
    (_status, message) => new Error(message));
  const run = <T>(requests: Parameters<typeof transport.read<T>>[0]) => transport.read(requests, async () => {});
  const previous = { pageId: id(3), lastEditedTime: timestamp };
  const rows = await run(notionReadRows(root, previous));
  expect(rows).toEqual([previous, { pageId: id(2), lastEditedTime: timestamp }]);
  const page = await run(notionReadPage(root, id(2)));
  const envelope = await notionSourceProjection(page);
  expect(envelope.unit.blocks.slice(-4).map(item => [item.parentId, item.body.text])).toEqual([
    [null, '块 4'], [id(4), '块 5'], [null, '块 7'], [null, '[Notion file]'],
  ]);
  const attachment = envelope.unit.blocks.at(-1)?.body;
  expect(envelope.unit.blocks.map(block => block.body.text)).toContain('Due: 2026-11-25');
  expect(envelope.unit.blocks.map(block => block.body.notionBody)).toContainEqual({
    type: 'property', propertyType: 'relation', id: 'relation', name: 'Related', value: [{ id: id(21) }], availability: 'partial',
  });
  expect(attachment?.notionBody).toMatchObject({ data: { file: { origin: 'https://example.org', path: '/doc' } } });
  expect(JSON.stringify(attachment)).not.toMatch(/signature|expiry_time/);
  signature = 'second-test-signature';
  const reordered = await notionSourceProjection(await run(notionReadPage(root, id(2))));
  expect(reordered.unit.blocks.at(-1)?.body.contentHash).toBe(attachment?.contentHash);
  const readError = (selected: NotionBoundedUse['selection']['root']) => run(notionReadPage(selected, id(2))).catch(error => error);
  for (const [selected, status, preset, target, recheck] of [
    [root, 403, 'temporary', { kind: 'page', pageId: id(2) }, { scope: 'page', status: 404 }],
    [{ kind: 'page', id: id(2) }, 404, 'turn-only', { kind: 'selection' }, { scope: 'page', status: 403 }],
    [root, 404, 'temporary', { kind: 'page', pageId: id(2) }, { scope: 'moved', status: 200 }],
  ] as const) {
    const selection = { root: selected, learner: learnerId('01KFS4AAA00000000000000000'), selectionId: 'notes', selectionEpoch: '1' };
    const use = { preset, selection, pageId: id(2), conversationId: 'chat', turnId: 'turn', authorizationEpoch: '0',
      recipient: { purpose: 'turn-tool', id: 'tool' }, authorizedAt: timestamp, expiresAt: '2026-11-21T12:00:00.000Z' } satisfies NotionBoundedUse;
    const fresh = { ...use, selection: { ...selection, selectionEpoch: '2' } };
    const pull = (scope: typeof selection) => run(notionReadPage(selected, id(2), scope));
    const first = await pull(selection);
    await expect(prepareNotionBoundedSnapshot(fresh, fresh, first, timestamp)).rejects.toThrow('拉取见证已变更');
    let saved: NotionBoundedSnapshot | undefined = await prepareNotionBoundedSnapshot(use, use, first, timestamp);
    const replacement = await prepareNotionBoundedSnapshot(fresh, fresh, await pull(fresh.selection), timestamp);
    const open = (current = use, now = timestamp) => saved && openNotionBoundedSnapshot(saved, current, now);
    expect(open()?.title).toBe('滴定');
    expect(() => open({ ...use, turnId: 'next' })).toThrow('本轮授权无效');
    expect(() => open({ ...use, recipient: { ...use.recipient, id: 'other' } })).toThrow('本轮授权无效');
    expect(() => open(use, use.expiresAt)).toThrow('本轮授权无效');
    const handles = [{ handle: { id: 'saved' }, use }, { handle: { id: 'fresh' }, use: fresh },
      { handle: { id: 'other-handle' }, use: { ...use, pageId: target.kind === 'page' ? id(3) : use.pageId } }];
    const close = vi.fn(async ({ id }: { id: string }, _reason: string) => {
      if (id === 'saved') saved = undefined;
    });
    denied = { scope: 'child', status };
    expect(await readError(selected)).toBeInstanceOf(NotionChildUnavailable);
    const outbound = (snapshot = saved!, current = use) =>
      run(notionBoundedSnapshotForSend(snapshot, async () => ({ use: current, now: timestamp })));
    denied = { scope: 'child', status, after: { scope: 'page', status: 503 } };
    const unconfirmed = await readError(selected);
    expect(unconfirmed).toBeInstanceOf(NotionSourceUnconfirmed);
    expect(await applyNotionSourceInvalidation(unconfirmed, selection, selection, handles, { close })).toBeNull();
    await expect(outbound()).rejects.toBeInstanceOf(NotionSourceUnconfirmed);
    denied = { scope: 'root', status };
    expect(await readError(selected)).toMatchObject({ invalidated: target });
    denied = { scope: 'child', status, after: recheck };
    const error = await readError(selected);
    expect(await applyNotionSourceInvalidation(error, selection, fresh.selection, handles, { close })).toBeNull();
    expect(await applyNotionSourceInvalidation(error, selection, selection, handles, { close })).toMatchObject({ target });
    expect(close.mock.calls).toEqual((target.kind === 'selection' ? ['saved', 'other-handle'] : ['saved']).map(id => [{ id }, 'source-revoked']));
    expect(open()).toBeUndefined();
    denied = undefined;
    await expect(outbound(replacement, fresh)).resolves.toMatchObject({ title: '滴定' });
  }
});
