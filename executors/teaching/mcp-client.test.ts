import {createHash} from 'node:crypto';
import {runStudyAgent} from './study-agent.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { McpTurnConnections, callMcpTool, discoverMcpTools, type McpServer } from './mcp-client.ts';

type RecordedRequest = {
  method: string | undefined;
  body: unknown;
};

type TestServer = {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
};

const servers: TestServer[] = [];
const searchTool = {
  name: 'search',
  description: 'Search the notes',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
};

afterEach(async () => {
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
      requests.push({ method: request.method, body });
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

function mcpServer(id: string, url: string, allowedTools: string[] = []): McpServer {
  return {id, url, allowedTools};
}

function initializeResult(serverName = 'test-server') {
  return {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: serverName, version: '1' },
  };
}

function initialize(response: ServerResponse, id: number, sessionId: string): void {
  json(response, {jsonrpc: '2.0', id, result: initializeResult()}, sessionId);
}

function protocolMessage(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  sessionId: string,
): Record<string, unknown> | undefined {
  if (request.method === 'DELETE') {
    response.writeHead(204);
    response.end();
    return undefined;
  }
  const message = body as Record<string, unknown>;
  if (message.method === 'initialize') {
    initialize(response, Number(message.id), sessionId);
    return undefined;
  }
  if (message.method === 'notifications/initialized') {
    response.writeHead(202);
    response.end();
    return undefined;
  }
  return message;
}

async function protocolServer(): Promise<TestServer> {
  return startServer((request, response, body) => {
    const message = protocolMessage(request, response, body, 'session-test');
    if (!message) return;
    const result = (value: unknown) => ({jsonrpc: '2.0', id: message.id, result: value});
    if (message.method === 'tools/list') {
      const cursor = (message.params as {cursor?: string})?.cursor;
      if (cursor) {
        json(response, result({tools: [searchTool]}));
      } else {
        const tools = [{name: 'delete', inputSchema: {type: 'object'}}];
        eventStream(response, [result({tools, nextCursor: 'next-page'})]);
      }
    } else if (message.method === 'tools/call') {
      json(response, result({content: [{type: 'text', text: 'ok'}]}));
    } else {
      response.writeHead(400).end();
    }
  });
}

it('stops a recovered stateful turn before a new external tool request', async () => {
  const server = mcpServer('library', 'https://unused.invalid/mcp', ['next']);
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
  const server = mcpServer('library', remote.url, ['search']);
  const connections = new McpTurnConnections();
  try {
    expect(await discoverMcpTools(server, connections)).toEqual([searchTool]);
    for (const topic of ['start', 'continue'])
      expect(await callMcpTool(server, 'search', {topic}, connections)).toBe('ok');
    expect(remote.requests.filter(req => req.method === 'DELETE')).toHaveLength(0);
    expect(remote.requests.filter(req => (req.body as {method?: string})?.method === 'initialize')).toHaveLength(1);
  } finally {
    await connections.close();
  }
  expect(remote.requests.at(-1)?.method).toBe('DELETE');
});

it('rejects disallowed tools before network access and never repeats a failed tool call', async () => {
  let toolCalls = 0;
  const server = await startServer((request, response, body) => {
    const message = protocolMessage(request, response, body, 'session-once');
    if (!message) return;
    if (message.method === 'tools/call') {
      toolCalls++;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'may have executed' }));
      return;
    }
    response.writeHead(400);
    response.end();
  });
  const serverConfig = mcpServer('write-once', server.url, ['write']);

  await expect(callMcpTool(serverConfig, 'delete', {})).rejects.toThrow('not allowed');
  expect(server.requests).toHaveLength(0);

  await expect(callMcpTool(serverConfig, 'write', { value: 1 }))
    .rejects.toThrow('HTTP 500');
  expect(toolCalls).toBe(1);
  expect(server.requests.at(-1)?.method).toBe('DELETE');
});
