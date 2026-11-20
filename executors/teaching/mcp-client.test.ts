import {createHash} from 'node:crypto';
import {runCompanionTurn} from './index.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { McpTurnConnections, callMcpTool, discoverMcpTools, type McpServer } from './mcp-client.ts';

const closeServers: (() => Promise<void>)[] = [];
const searchTool = {
  name: 'search',
  description: 'Search the notes',
  inputSchema: {type: 'object', properties: {query: {type: 'string'}}},
};

afterEach(() => Promise.all(closeServers.splice(0).map(close => close())));

async function protocolServer({failCall = false, stateless = false} = {}) {
  const requests: {method?: string; rpc?: string}[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') {
      requests.push({method: request.method});
      response.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({method: request.method ?? 'UNKNOWN', rpc: message.method});
    if (!stateless) response.setHeader('mcp-session-id', 'session-test');
    const result = (value: unknown) => JSON.stringify({jsonrpc: '2.0', id: message.id, result: value});
    switch (message.method) {
      case 'initialize':
        response.writeHead(200, {'content-type': 'application/json'}).end(result({
          protocolVersion: '2025-06-18', capabilities: {tools: {}},
          serverInfo: {name: 'test-server', version: '1'},
        }));
        break;
      case 'notifications/initialized':
        response.writeHead(202).end();
        break;
      case 'tools/list':
        if (message.params?.cursor) {
          response.writeHead(200, {'content-type': 'application/json'}).end(result({tools: [searchTool]}));
        } else {
          const first = result({tools: [{name: 'delete', inputSchema: {type: 'object'}}], nextCursor: 'next-page'});
          response.writeHead(200, {'content-type': 'text/event-stream'}).end('event: message\ndata: ' + first + '\n\n');
        }
        break;
      case 'tools/call':
        response.writeHead(failCall ? 500 : 200, {'content-type': 'application/json'}).end(
          failCall ? '{"error":"may have executed"}' : result({content: [{type: 'text', text: 'ok'}]}));
        break;
      default:
        response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  closeServers.push(() => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return {url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/mcp', requests};
}

function mcpServer(id: string, url: string, allowedTools: string[] = []): McpServer {
  return {id, url, allowedTools};
}

it('stops a recovered stateful turn before a new external tool request', async () => {
  const server = mcpServer('library', 'https://unused.invalid/mcp', ['next']);
  const name = 'mcp_next_' + createHash('sha256').update(JSON.stringify(['library', 'next'])).digest('hex').slice(0, 12);
  const effectSteps: number[] = [];
  const call = (id: string, name: string, args: object) => ({id, type: 'function', function: {name, arguments: JSON.stringify(args)}});
  const reply = (...calls: ReturnType<typeof call>[]) => JSON.stringify({reportedModel: 'group/auto-deepseek-v4-1-flash', calls});
  const result = runCompanionTurn('继续', [], undefined, {provider: {baseUrl: 'https://unused.invalid'}, tools: {mcpServers: [server]},
    runEffect: async (step, invoke) => {
      effectSteps.push(step.index);
      if (step.index === 20_000) return JSON.stringify({stateful: true, tools: [{name: 'next', description: '', inputSchema: {type: 'object'}}]});
      if (step.index === 0) return reply(call('find', 'find_tools', {query: 'next'}), call('premature', name, {}));
      if (step.index === 8) return reply(call('after-discovery', name, {}));
      return invoke('new-tool-request');
    }});
  await expect(result).rejects.toThrow('有状态 MCP 会话已中断');
  expect(effectSteps).toEqual([20_000, 0, 8, 9]);
});

it.each([false, true])('rechecks authorization after a recovered stateless MCP handshake (revoked: %s)', async revoked => {
  const remote = await protocolServer({stateless:true});
  const server = mcpServer('library', remote.url, ['search']);
  const name = 'mcp_search_' + createHash('sha256').update(JSON.stringify(['library','search'])).digest('hex').slice(0,12);
  const result = runStudyAgent([{role:'user',content:'继续'}], {provider:{baseUrl:'https://unused.invalid'}, tools:{mcpServers:[server]},
    async runEffect(step, invoke) {
      if (step.index === 20_000) return JSON.stringify({stateful:false, tools:[searchTool]});
      if (step.index === 0) return JSON.stringify({reportedModel:'group/auto-deepseek-v4-1-flash', calls:[
        {id:'resumed',type:'function',function:{name,arguments:'{"query":"冻结预测证据"}'}},
      ]});
      if (step.index === 8) return JSON.stringify({message:'完成'});
      return invoke('new-tool-request', async send => {
        if (revoked && remote.requests.some(request => request.rpc === 'notifications/initialized')) throw new Error('evidence_scope');
        return send();
      });
    }});
  if (revoked) await expect(result).rejects.toThrow('evidence_scope');
  else expect((await result).message).toBe('完成');
  expect(remote.requests.filter(request => request.rpc === 'initialize')).toHaveLength(1);
  expect(remote.requests.filter(request => request.rpc === 'tools/call')).toHaveLength(revoked ? 0 : 1);
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
    expect(remote.requests.filter(req => req.rpc === 'initialize')).toHaveLength(1);
  } finally {
    await connections.close();
  }
  expect(remote.requests.at(-1)?.method).toBe('DELETE');
});

it('rejects disallowed tools before network access and never repeats a failed tool call', async () => {
  const server = await protocolServer({failCall:true});
  const serverConfig = mcpServer('write-once', server.url, ['write']);

  await expect(callMcpTool(serverConfig, 'delete', {})).rejects.toThrow('not allowed');
  expect(server.requests).toHaveLength(0);

  await expect(callMcpTool(serverConfig, 'write', { value: 1 }))
    .rejects.toThrow('HTTP 500');
  expect(server.requests.filter(request => request.rpc === 'tools/call')).toHaveLength(1);
  expect(server.requests.at(-1)?.method).toBe('DELETE');
});
