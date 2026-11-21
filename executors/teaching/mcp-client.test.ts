import {createHash} from 'node:crypto';
import {runCompanionTurn} from './index.ts';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, onTestFinished } from 'vitest';
import { McpTurnConnections, callMcpTool, discoverMcpTools, type McpServer } from './mcp-client.ts';
import { toolCall } from './test/chat.ts';
const searchTool = {
  name: 'search',
  description: 'Search the notes',
  inputSchema: {type: 'object', properties: {query: {type: 'string'}}},
};

async function protocolServer({failCall = false, stateless = false} = {}) {
  const requests: {method?: string; rpc?: string}[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') {
      requests.push({method: request.method});
      return response.writeHead(204).end();
    }
    const message = JSON.parse((await request.setEncoding('utf8').toArray()).join(''));
    requests.push({method: request.method ?? 'UNKNOWN', rpc: message.method});
    if (!stateless) response.setHeader('mcp-session-id', 'session-test');
    const result = (value: unknown) => JSON.stringify({jsonrpc: '2.0', id: message.id, result: value});
    const send = (value: unknown) => response.writeHead(200, {'content-type': 'application/json'}).end(result(value));
    switch (message.method) {
      case 'initialize':
        return send({protocolVersion: '2025-06-18', capabilities: {tools: {}},
          serverInfo: {name: 'test-server', version: '1'}});
      case 'notifications/initialized':
        return response.writeHead(202).end();
      case 'tools/list': {
        if (message.params?.cursor) return send({tools: [searchTool]});
        const first = result({tools: [{name: 'delete', inputSchema: {type: 'object'}}], nextCursor: 'next-page'});
        return response.writeHead(200, {'content-type': 'text/event-stream'}).end(`event: message\ndata: ${first}\n\n`);
      }
      case 'tools/call':
        return failCall ? response.writeHead(500, {'content-type': 'application/json'}).end('{"error":"may have executed"}')
          : send({content: [{type: 'text', text: 'ok'}]});
      default:
        return response.writeHead(400).end();
    }
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  onTestFinished(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  return {url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/mcp', requests};
}

it.each([
  {name: 'stops a recovered stateful turn before a new external request', stateful: true, revoked: false},
  {name: 'reauthorizes after a recovered stateless handshake', stateful: false, revoked: false},
  {name: 'stops after a recovered stateless handshake when revoked', stateful: false, revoked: true},
])('$name', async ({stateful, revoked}) => {
  const remote = stateful ? undefined : await protocolServer({stateless: true});
  const tool = stateful ? {name: 'next', description: '', inputSchema: {type: 'object'}} : searchTool;
  const server = {id: 'library', url: remote?.url ?? 'https://unused.invalid/mcp', allowedTools: [tool.name]} satisfies McpServer;
  const suffix = createHash('sha256').update(JSON.stringify([server.id, tool.name])).digest('hex').slice(0, 12);
  const name = `mcp_${tool.name}_${suffix}`;
  const calls = (...calls: ReturnType<typeof toolCall>[]) =>
    JSON.stringify({reportedModel: 'group/auto-deepseek-v4-1-flash', calls});
  const find = toolCall('find', 'find_tools', {query: tool.name});
  const effectSteps: number[] = [];
  const result = runCompanionTurn('继续', [], undefined, {
    provider: {baseUrl: 'https://unused.invalid'}, tools: {mcpServers: [server]},
    async runEffect(step, invoke) {
      effectSteps.push(step.index);
      if (step.index === 20_000) return JSON.stringify({stateful, tools: [tool]});
      if (step.index === 0) return stateful ? calls(find, toolCall('premature', name, {})) : calls(find);
      if (step.index === 8) return calls(stateful
        ? toolCall('after-discovery', name, {}) : toolCall('resumed', name, {query: '冻结预测证据'}));
      if (step.index === 16) return JSON.stringify({message: '完成'});
      return invoke('new-tool-request', async send => {
        if (revoked && remote?.requests.some(request => request.rpc === 'notifications/initialized')) throw new Error('evidence_scope');
        return send();
      });
    },
  });
  if (!remote) {
    await expect(result).rejects.toThrow('有状态 MCP 会话已中断');
    expect(effectSteps).toEqual([20_000, 0, 8, 9]);
    return;
  }
  if (revoked) await expect(result).rejects.toThrow('evidence_scope');
  else expect((await result).message).toBe('完成');
  expect(remote.requests.filter(request => request.rpc === 'initialize')).toHaveLength(1);
  expect(remote.requests.filter(request => request.rpc === 'tools/call')).toHaveLength(revoked ? 0 : 1);
});

it('keeps one remote session across discovery and consecutive tools in the same turn', async () => {
  const remote = await protocolServer();
  const server = {id: 'library', url: remote.url, allowedTools: ['search']};
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
  const serverConfig = {id: 'write-once', url: server.url, allowedTools: ['write']};

  await expect(callMcpTool(serverConfig, 'delete', {})).rejects.toThrow('not allowed');
  expect(server.requests).toHaveLength(0);

  await expect(callMcpTool(serverConfig, 'write', { value: 1 }))
    .rejects.toThrow('HTTP 500');
  expect(server.requests.filter(request => request.rpc === 'tools/call')).toHaveLength(1);
  expect(server.requests.at(-1)?.method).toBe('DELETE');
});
