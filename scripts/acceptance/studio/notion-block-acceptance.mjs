import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import pg from 'pg';
import { startWork } from '../../../executors/temporal/src/index.ts';
import { pollUntil, spawnStudio, studioJsonApi } from './acceptance-fixtures.mjs';

const [database, temporal, schema, port, namespace = 'default'] = process.argv.slice(2);
assert.match(database, /^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/postgres$/);
assert.match(temporal, /^127\.0\.0\.1:\d+$/);
assert.match(schema, /^notion_[a-z0-9_]+$/);
const home = await mkdtemp(join(tmpdir(), 'notion-studio-'));
const uuid = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
const [root, a, b, revoked, stay, changed, added, other] = [1, 2, 3, 4, 5, 6, 7, 8].map(uuid);
const list = results => ({ object: 'list', results, has_more: false, next_cursor: null });
const stamp = hour => '2026-11-20T0' + hour + ':00:00.000Z';
const paragraph = (id, text) => ({ object: 'block', id, type: 'paragraph', has_children: false,
  paragraph: { rich_text: [{ plain_text: text }] } });
let hour = 1, outage = false, outsideCursor = false;
const pages = { [a]: [[stay, 'STAY'], [changed, 'OLD']], [b]: [], [revoked]: [[other, 'REVOKED']] };
const page = id => ({ object: 'page', id, parent: { type: 'data_source_id', data_source_id: root },
  last_edited_time: stamp(id === revoked ? 1 : hour), properties: {} });
const traffic = [];
const notion = createServer((req, res) => {
  traffic.push([req.method, req.url]);
  const id = req.url.split('/')[3];
  if (outage && req.url === '/v1/pages/' + a) return res.writeHead(502).end('{}');
  const reply = req.url === '/v1/data_sources/' + root + '/query' ? list(outsideCursor ? [page(b)] : [page(a), page(b)])
    : req.url?.startsWith('/v1/pages/') ? page(id) : pages[id] && list(pages[id].map(([id, text]) => paragraph(id, text)));
  res.writeHead(reply ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply ?? {}));
}).listen(0, '127.0.0.1');
await once(notion, 'listening');
const env = { PATH: process.env.PATH, HOME: home, PGPASSWORD: process.env.PGPASSWORD,
  MANGEKYO_DATABASE_URL: database, MANGEKYO_DATABASE_SCHEMA: schema,
  MANGEKYO_NOTION_TEST_ORIGIN: 'http://127.0.0.1:' + notion.address().port, MANGEKYO_PORT: port,
  TEMPORAL_ADDRESS: temporal, TEMPORAL_NAMESPACE: namespace, MANGEKYO_TASK_QUEUE: schema, MANGEKYO_ACTIVATE_LOCAL_BUILD: '1' };
const children = [];
function studio(mode) {
  children.push(spawnStudio({ port, env: { ...env, MANGEKYO_PROCESS: mode }, inherit: true }).child);
}
const base = 'http://127.0.0.1:' + port;
const api = studioJsonApi(base, (response, path, body, status = 200) =>
  assert.equal(response.status, status, path + ' ' + JSON.stringify(body)));
const post = (action, fields, status) => api('notion/selections/' + action,
  { deletionWatermark: '0', expectedEpoch: '1', selectionId: 'course', ...fields }, 'POST', status);
const reader = { id: 'studio:learning-reader', purpose: 'learning' };
const pool = new pg.Pool({ connectionString: database, options: '-c search_path=' + schema });
const rows = async () => (await pool.query(`SELECT w.slot_key::jsonb AS basis,w.state,o.state AS delivery,
  w.id AS work_id,w.generation::text,o.intent_id,s.last_error FROM work w JOIN work_outbox o ON o.intent_id=w.execution_ref
  JOIN slot_state s ON (s.learner_id,s.slot_type,s.slot_key)=(w.learner_id,w.slot_type,w.slot_key) WHERE w.slot_type='capture.notionBlock'
  ORDER BY w.requested_tick,w.slot_key`)).rows;
async function until(probe) {
  return pollUntil(probe, { attempts: 120, interval: 500 });
}
let temporalConnection;
try {
  studio('web');
  await until(async () => (await fetch(base + '/api/notion/settings').catch(() => undefined))?.ok);
  await post('grant', { requestId: 'grant-course', expectedEpoch: '0', root: { kind: 'data-source', id: root },
    preset: 'learning', recipients: [reader] });
  const first = await post('sync', { requestId: 'sync-first' });
  assert.deepEqual((await rows()).map(row => row.basis.blockId), [stay, changed]);
  hour++;
  pages[a] = [[stay, 'STAY'], [changed, 'EDITED'], [added, 'ADDED']];
  const second = await post('sync', { requestId: 'sync-edit' });
  const requests = traffic.length;
  assert.deepEqual(await post('sync', { requestId: 'sync-edit' }), second);
  assert.equal(traffic.length, requests);
  hour++;
  pages[a] = [[stay, 'STAY'], [added, 'ADDED']];
  pages[b] = [[changed, 'EDITED']];
  await post('sync', { requestId: 'sync-move' });
  hour++;
  await post('sync', { requestId: 'sync-clock-only' });
  await post('grant', { selectionId: 'revoked', requestId: 'grant-revoked', expectedEpoch: '0', root: { kind: 'page', id: revoked },
    preset: 'learning', recipients: [reader] });
  const withdrawn = await post('sync', { selectionId: 'revoked', requestId: 'sync-revoked' });
  await post('revoke', { selectionId: 'revoked', requestId: 'revoke-reader', recipient: reader });
  await post('sync', { selectionId: 'revoked', requestId: 'sync-revoked' }, 409);
  const beforeWorker = traffic.length;
  outage = true;
  studio('worker');
  await until(async () => (await rows()).every(row => row.state !== 'ready'));
  const beforeRecovery = await rows();
  const blocked = beforeRecovery.filter(row => row.last_error?.code === 'notion-remote-unconfirmed');
  assert.deepEqual(blocked.map(row => row.basis.blockId), [stay, added]);
  assert.equal(traffic.slice(beforeWorker).filter(([, url]) => url === '/v1/pages/' + a).length, 10);
  outsideCursor = true;
  const healthy = await post('sync', { requestId: 'sync-while-old-page-offline' });
  assert.equal(healthy.sources.length, 1);
  assert.equal(healthy.sources[0].id, first.sources[1].id);
  assert.deepEqual(await rows(), beforeRecovery);
  outage = false;
  await post('sync', { requestId: 'sync-recovered' });
  await until(async () => (await rows()).every(row => row.state !== 'ready'));
  const final = await rows();
  for (const prior of blocked) {
    const current = final.find(row => row.work_id === prior.work_id);
    assert.equal(current.generation, '2');
    assert.notEqual(current.intent_id, prior.intent_id);
  }
  console.log(JSON.stringify({ final, traffic }));
  const [sourceA, sourceB] = first.sources.map(row => row.id);
  const ordered = beforeRecovery.map(prior => final.find(row => row.work_id === prior.work_id));
  assert.deepEqual(ordered.map(({ basis, state }) => [basis.id, basis.blockId, basis.rev, state]), [
    [sourceA, stay, 1, 'blocked'], [sourceA, changed, 1, 'cancelled'], [sourceA, changed, 2, 'cancelled'],
    [sourceA, added, 2, 'blocked'], [sourceB, changed, 2, 'blocked'], [withdrawn.sources[0].id, other, 1, 'cancelled'],
  ]);
  assert.equal((await pool.query(`SELECT label FROM effects WHERE label='resolve-notion-block-links'
    UNION ALL SELECT type FROM facts WHERE type IN ('content.knowledgeEdge','content.knowledgeEdgeEvidence')`)).rowCount, 0);
  temporalConnection = await Connection.connect({ address: temporal });
  const client = new Client({ connection: temporalConnection, namespace });
  for (const { intent_id: id, delivery, state, last_error } of final) {
    if (state === 'blocked') assert.match(last_error?.reason ?? '', /概念解析器及连边核验回执/);
    assert.equal(delivery, 'routed_delivered');
    await until(async () => (await client.workflow.getHandle(id).describe()).status.name === 'COMPLETED');
    const run = await client.workflow.getHandle(id).describe();
    await startWork(client, id, { taskQueue: run.taskQueue });
    assert.equal((await client.workflow.getHandle(id).describe()).runId, run.runId);
    console.log(JSON.stringify({ id, runId: run.runId, taskQueue: run.taskQueue, status: run.status.name }));
  }
  assert.deepEqual(await rows(), final);
} finally {
  for (const child of children) child.kill('SIGTERM');
  await temporalConnection?.close();
  await pool.end();
  notion.close();
}
