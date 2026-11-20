import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { notionReadPage, notionReadRows, notionVersion, NotionSourceUnavailable, type NotionReadRequest, type NotionReadResponse } from './notion-api.ts';
import { advanceNotionCursor, notionSourceProjection } from './notion-values.ts';

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

async function run<T>(stream: AsyncGenerator<NotionReadRequest, T, NotionReadResponse> | Generator<NotionReadRequest, T, NotionReadResponse>,
  request: (value: NotionReadRequest) => Promise<NotionReadResponse>): Promise<T> {
  let step = await stream.next();
  while (!step.done) step = await stream.next(await request(step.value));
  return step.value;
}

it('reads all tied rows and paginated nested blocks over HTTP under the same selection', async () => {
  let selected = true;
  let signature = 'first-test-signature';
  const calls: string[] = [];
  const queryBodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer isolated-token' || request.headers['notion-version'] !== notionVersion) {
      response.writeHead(401).end();
      return;
    }
    const url = new URL(request.url!, 'http://127.0.0.1');
    calls.push(`${request.method} ${url.pathname}`);
    let outgoing: unknown;
    if (request.method === 'POST' && url.pathname === `/v1/data_sources/${root.id}/query`) {
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw);
      queryBodies.push(body);
      outgoing = body.start_cursor ? listed([row(2)]) : listed([row(3)], 'rows-next');
    } else if (url.pathname === `/v1/pages/${id(2)}`) {
      outgoing = selected ? row(2) : { ...row(2), parent: { type: 'data_source_id', data_source_id: id(9) } };
    } else if (url.pathname === `/v1/blocks/${id(2)}/children`) {
      outgoing = url.searchParams.has('start_cursor') ? listed([block(7), { ...block(8), type: 'file',
        file: { type: 'file', name: 'worksheet.pdf', file: { url: `https://example.org/doc?signature=${signature}`, expiry_time: timestamp } } }])
        : listed([block(4, true)], 'block+/next');
    } else if (url.pathname === `/v1/blocks/${id(4)}/children`) {
      outgoing = listed([block(5)]);
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(outgoing));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test listener');
    const request = async (input: NotionReadRequest) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${input.path}`, {
        method: input.method, headers: { authorization: 'Bearer isolated-token', 'notion-version': notionVersion },
        ...(input.method === 'POST' ? { body: JSON.stringify(input.body) } : {}),
      });
      return { status: response.status, body: response.ok ? await response.json() : null };
    };
    const previous = { pageId: id(3), lastEditedTime: timestamp };
    const rows = await run(notionReadRows(root, previous), request);
    expect(rows).toEqual([previous, { pageId: id(2), lastEditedTime: timestamp }]);
    expect(advanceNotionCursor(previous, rows)).toEqual(previous);
    expect(queryBodies[1]).toMatchObject({ start_cursor: 'rows-next', filter: { last_edited_time: { on_or_after: timestamp } } });
    const page = await run(notionReadPage(root, id(2)), request);
    const envelope = await notionSourceProjection(page);
    expect(envelope.unit.blocks.slice(-4).map(item => [item.parentId, item.body.text])).toEqual([
      [null, '块 4'], [id(4), '块 5'], [null, '块 7'], [null, '[Notion file]'],
    ]);
    expect(envelope.unit.blocks.map(item => item.body.text)).toContain('Due: 2026-11-25');
    expect(envelope.unit.blocks.map(item => item.body.notionBody)).toContainEqual({ type: 'property',
      propertyType: 'relation', id: 'relation', name: 'Related', value: [{ id: id(21) }], availability: 'partial' });
    const attachment = envelope.unit.blocks.at(-1)?.body;
    expect(attachment?.notionBody).toMatchObject({ data: { file: { origin: 'https://example.org', path: '/doc' } } });
    expect(JSON.stringify(attachment)).not.toMatch(/signature|expiry_time/);
    signature = 'second-test-signature';
    const reordered = await notionSourceProjection(await run(notionReadPage(root, id(2)), request));
    expect(reordered.unit.blocks.at(-1)?.body.contentHash).toBe(attachment?.contentHash);
    const count = calls.length;
    selected = false;
    await expect(run(notionReadPage(root, id(2)), request)).rejects.toBeInstanceOf(NotionSourceUnavailable);
    expect(calls.slice(count)).toEqual([`GET /v1/pages/${id(2)}`]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
