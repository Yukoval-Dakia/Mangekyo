import {createHash} from 'node:crypto';
import {runStudyAgent} from './study-agent.ts';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { McpTurnConnections, callMcpTool, discoverMcpTools, type McpServer } from './mcp-client.ts';

type RecordedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
};

type TestServer = {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
};

const servers: TestServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function json(response: ServerResponse, body: unknown, sessionId?: string): void {
  response.writeHead(200, {
    'content-type': 'application/json',
    ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
  });
  response.end(JSON.stringify(body));
}

function eventStream(response: ServerResponse, messages: unknown[], sessionId?: string): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
  });
  for (const message of messages) response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  response.end();
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void | Promise<void>,
): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const body = request.method === 'DELETE' ? undefined : await requestBody(request);
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      await handler(request, response, body);
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const testServer: TestServer = {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
  servers.push(testServer);
  return testServer;
}

function initialize(id: number, sessionId: string) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'test-server', version: '1' },
    },
    sessionId,
  };
}

async function protocolServer(): Promise<TestServer> {
  let page = 0;
  return startServer((request, response, body) => {
    const message = body as Record<string, unknown>;
    if (request.method === 'DELETE') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (message.method === 'initialize') {
      const init = initialize(Number(message.id), 'session-test');
      json(response, { jsonrpc: '2.0', id: init.id, result: init.result }, init.sessionId);
      return;
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === 'tools/list') {
      page++;
      if (page === 1) {
        eventStream(response, [
          { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'working' } },
          {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [
                {
                  name: 'search',
                  description: 'Search the notes',
                  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                },
                { name: 'delete', description: 'Never exposed', inputSchema: { type: 'object' } },
              ],
              nextCursor: 'next-page',
            },
          },
        ]);
        return;
      }
      json(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'search', description: 'Duplicate', inputSchema: { type: 'object' } },
            { name: 'calculate', inputSchema: { type: 'object', properties: { expression: { type: 'string' } } } },
          ],
        },
      });
      return;
    }
    if (message.method === 'tools/call') {
      json(response, {jsonrpc: '2.0', id: message.id, result: {content: [{type: 'text', text: 'ok'}]}});
      return;
    }
    response.writeHead(400);
    response.end();
  });
}

it('stops a recovered stateful turn before a new external tool request', async () => {
  const server = {id: 'library', url: 'https://unused.invalid/mcp', allowedTools: ['next']};
  const name = 'mcp_next_' + createHash('sha256').update(JSON.stringify(['library', 'next'])).digest('hex').slice(0, 12);
  const result = runStudyAgent([{role: 'user', content: '继续'}], {provider: {baseUrl: 'https://unused.invalid'}, tools: {mcpServers: [server]},
    runEffect: async (step, invoke) => {
      if (step.index === 20_000) return JSON.stringify({stateful: true, tools: [{name: 'next', description: '', inputSchema: {type: 'object'}}]});
      if (step.index === 0) return JSON.stringify({reportedModel: 'group/auto-deepseek-v4-1-flash', calls: [{id: 'c1', type: 'function', function: {name, arguments: '{}'}}]});
      return invoke('new-tool-request');
    }});
  await expect(result).rejects.toThrow('有状态 MCP 会话已中断');
});

it('keeps one remote session across discovery and consecutive tools in the same turn', async () => {
  const remote = await protocolServer();
  const server = {id: 'library', url: remote.url, allowedTools: ['search']};
  const connections = new McpTurnConnections();
  try {
    await discoverMcpTools(server, connections);
    for (const topic of ['start', 'continue'])
      expect(await callMcpTool(server, 'search', {topic}, connections)).toBe('ok');
    expect(remote.requests.filter(req => req.method === 'DELETE')).toHaveLength(0);
    expect(remote.requests.filter(req => (req.body as {method?: string})?.method === 'initialize')).toHaveLength(1);
  } finally {
    await connections.close();
  }
  expect(remote.requests.at(-1)?.method).toBe('DELETE');
});

it('discovers only allowlisted tools across JSON and SSE pages, then deletes the session', async () => {
  const server = await protocolServer();
  const tools = await discoverMcpTools({
    id: 'notes',
    url: server.url,
    token: 'local-test-token',
    allowedTools: ['search', 'calculate'],
  });

  expect(tools).toEqual([
    {
      name: 'search',
      description: 'Search the notes',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
    {
      name: 'calculate',
      description: '',
      inputSchema: { type: 'object', properties: { expression: { type: 'string' } } },
    },
  ]);

  expect(server.requests.map(request => request.method === 'DELETE' ? 'DELETE' : (request.body as { method?: string }).method))
    .toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
  const [initializeRequest, initializedRequest, firstPage, secondPage, deleted] = server.requests;
  expect(initializeRequest?.headers.authorization).toBe('Bearer local-test-token');
  expect(initializeRequest?.headers['mcp-session-id']).toBeUndefined();
  expect(initializeRequest?.headers['mcp-protocol-version']).toBeUndefined();
  expect(firstPage?.headers.accept).toContain('application/json');
  expect(firstPage?.headers.accept).toContain('text/event-stream');
  for (const request of [initializedRequest, firstPage, secondPage, deleted]) {
    expect(request?.headers.authorization).toBe('Bearer local-test-token');
    expect(request?.headers['mcp-session-id']).toBe('session-test');
    expect(request?.headers['mcp-protocol-version']).toBe('2025-06-18');
  }
  expect(firstPage?.body).toMatchObject({ params: {} });
  expect(secondPage?.body).toMatchObject({ params: { cursor: 'next-page' } });
});

it('calls a tool over SSE and preserves text and structured content', async () => {
  const server = await startServer((request, response, body) => {
    const message = body as Record<string, unknown>;
    if (request.method === 'DELETE') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (message.method === 'initialize') {
      const init = initialize(Number(message.id), 'session-call');
      json(response, { jsonrpc: '2.0', id: init.id, result: init.result }, init.sessionId);
      return;
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === 'tools/call') {
      eventStream(response, [
        { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [
              { type: 'text', text: '42' },
              { type: 'text', text: 'from calculate' },
            ],
            structuredContent: { value: 42, source: 'server' },
          },
        },
      ]);
      return;
    }
    response.writeHead(400);
    response.end();
  });

  const output = await callMcpTool({
    id: 'calculator',
    url: server.url,
    allowedTools: ['calculate'],
  }, 'calculate', { expression: '6 * 7' });

  expect(output).toBe('42\nfrom calculate\n\n{"value":42,"source":"server"}');
  const call = server.requests.find(request => (request.body as { method?: string })?.method === 'tools/call');
  expect(call?.body).toMatchObject({
    params: { name: 'calculate', arguments: { expression: '6 * 7' } },
  });
  expect(server.requests.at(-1)?.method).toBe('DELETE');
});

it('rejects disallowed tools before network access and never repeats a failed tool call', async () => {
  let toolCalls = 0;
  const server = await startServer((request, response, body) => {
    const message = body as Record<string, unknown>;
    if (request.method === 'DELETE') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (message.method === 'initialize') {
      const init = initialize(Number(message.id), 'session-once');
      json(response, { jsonrpc: '2.0', id: init.id, result: init.result }, init.sessionId);
      return;
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === 'tools/call') {
      toolCalls++;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'may have executed' }));
      return;
    }
    response.writeHead(400);
    response.end();
  });
  const serverConfig: McpServer = {
    id: 'write-once',
    url: server.url,
    allowedTools: ['write'],
  };

  await expect(callMcpTool(serverConfig, 'delete', {})).rejects.toThrow('not allowed');
  expect(server.requests).toHaveLength(0);

  await expect(callMcpTool(serverConfig, 'write', { value: 1 }))
    .rejects.toThrow('HTTP 500');
  expect(toolCalls).toBe(1);
  expect(server.requests.at(-1)?.method).toBe('DELETE');
});

it('does not follow redirects', async () => {
  let endpointHits = 0;
  let redirectTarget = '';
  const server = await startServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(307, { location: redirectTarget });
      response.end();
      return;
    }
    endpointHits++;
    response.writeHead(500);
    response.end();
  });
  redirectTarget = server.url;

  await expect(discoverMcpTools({
    id: 'redirect',
    url: server.url.replace('/mcp', '/redirect'),
    allowedTools: [],
  })).rejects.toThrow('MCP request failed');
  expect(endpointHits).toBe(0);
});

it('rejects remote plain HTTP before making a request', async () => {
  const send = vi.spyOn(globalThis, 'fetch');
  await expect(discoverMcpTools({
    id: 'remote',
    url: 'http://example.test/mcp',
    allowedTools: [],
  })).rejects.toThrow('HTTPS or loopback HTTP');
  expect(send).not.toHaveBeenCalled();
});

it('accepts HTTPS and sends bearer authorization', async () => {
  const send = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'https-server', version: '1' },
      },
    }, { headers: { 'mcp-session-id': 'secure-session' } }))
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(Response.json({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] },
    }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));

  await expect(discoverMcpTools({
    id: 'https',
    url: 'https://example.test/mcp',
    token: 'https-test-token',
    allowedTools: ['lookup'],
  })).resolves.toEqual([{ name: 'lookup', description: '', inputSchema: { type: 'object' } }]);

  for (const call of send.mock.calls) {
    const headers = call[1]?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer https-test-token');
    expect(call[1]?.redirect).toBe('error');
  }
});

it('rejects a response whose declared size exceeds the byte cap', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(1024 * 1024 + 1),
    },
  }));
  await expect(discoverMcpTools({
    id: 'oversized',
    url: 'https://example.test/mcp',
    allowedTools: [],
  })).rejects.toThrow('byte limit');
});
