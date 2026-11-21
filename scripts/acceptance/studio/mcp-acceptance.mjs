import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import { providerRoute, requestJson, waitForSession } from './acceptance-fixtures.mjs';

const [address, serverId, tool, question, receipt, flag] = process.argv.slice(2);
if (!address || !serverId || !tool || !question || !receipt || flag !== '--live')
  throw new Error('用法：node scripts/acceptance/studio/mcp-acceptance.mjs 本机地址 服务ID 工具名 问题 预期回执 --live');
const studio = new URL(address);
assert(studio.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(studio.hostname));
assert(!question.includes(receipt), '预期回执应只在工具服务端和验收者手里。');

async function api(path, body) {
  const response = await requestJson(new URL('/api/' + path, studio), body);
  assert.ok(response.ok, path + ' HTTP ' + response.status);
  return response.json();
}

const settings = await api('settings');
const server = settings.mcpServers.find(entry => entry.id === serverId);
assert(server?.enabled && server.allowedTools.includes(tool), '请先在设置里启用服务并勾选本工具。');
const route = providerRoute(settings, 'companion');
const grants = [{id: serverId, url: server.url, allowedTools: [tool]}];
const pending = await api('sessions', {caseId: 'companion', question, requestId: randomUUID(), route, mcpGrants: grants});
const session = await waitForSession(pending, id => api('sessions/' + id), 800, 5 * 60_000);
assert.equal(session.status, 'ready', session.error ?? session.id);
const turn = session.turns[0];
assert(turn?.reportedModel, '回合须保留服务报告的模型。');
assert(turn.trace?.some(entry => entry.startsWith('MCP · ' + server.id + ' / ' + tool + '\n') && entry.includes(receipt)));
assert(turn.message.includes(receipt), '最终回复须使用工具返回的回执。');
console.log(JSON.stringify({session: session.id, requestedModel: route.model,
  reportedModel: turn.reportedModel, trace: turn.trace, message: turn.message}, null, 2));
