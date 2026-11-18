import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const [address, serverId, tool, question, receipt, flag] = process.argv.slice(2);
if (!address || !serverId || !tool || !question || !receipt || flag !== '--live')
  throw new Error('用法：node runtime/studio/test/mcp-acceptance.mjs 本机地址 服务ID 工具名 问题 预期回执 --live');
const studio = new URL(address);
assert(studio.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(studio.hostname));
assert(!question.includes(receipt), '预期回执应只在工具服务端和验收者手里。');

async function api(path, body) {
  const response = await fetch(new URL('/api/' + path, studio), body && {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
  });
  assert.ok(response.ok, path + ' HTTP ' + response.status);
  return response.json();
}

const settings = await api('settings');
const server = settings.mcpServers.find(entry => entry.id === serverId);
assert(server?.enabled && server.allowedTools.includes(tool), '请先在设置里启用服务并勾选本工具。');
const providerId = settings.routes?.companion ?? settings.activeProviderId;
const provider = settings.providers.find(profile => profile.id === providerId);
assert.ok(provider);
const route = {providerId, baseUrl: provider.baseUrl, protocol: provider.protocol,
  model: provider.model, reasoningEffort: provider.reasoningEffort};
const grants = [{id: serverId, url: server.url, allowedTools: [tool]}];
let session = await api('sessions', {caseId: 'companion', question, requestId: randomUUID(), route, mcpGrants: grants});
const deadline = Date.now() + 5 * 60_000;
while (session.status === 'pending' && Date.now() < deadline) {
  await delay(800);
  session = await api('sessions/' + session.id);
}
assert.equal(session.status, 'ready', session.error ?? session.id);
const turn = session.turns[0];
assert(turn?.reportedModel, '回合须保留服务报告的模型。');
assert(turn.trace?.some(entry => entry.startsWith('MCP · ' + server.id + ' / ' + tool + '\n') && entry.includes(receipt)));
assert(turn.message.includes(receipt), '最终回复须使用工具返回的回执。');
console.log(JSON.stringify({session: session.id, requestedModel: route.model,
  reportedModel: turn.reportedModel, trace: turn.trace, message: turn.message}, null, 2));
