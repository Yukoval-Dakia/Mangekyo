import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { json } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import pg from 'pg';
import { createPgDb } from '../../../kernel/src/db/pg.ts';
import { loadModuleDirectory } from '../../../kernel/src/loader.ts';
import { describeWork } from '../../../executors/temporal/src/index.ts';
import { openTextbook } from '../textbook.ts';
import { createStudioCommandHooks } from '../command-hooks.ts';
import { studioLearner } from '../identity.ts';

const database = new URL(process.env.MANGEKYO_P5_DATABASE_URL ?? '');
const temporal = process.env.MANGEKYO_P5_TEMPORAL ?? '';
assert.ok(/^postgres(ql)?:$/.test(database.protocol) && database.hostname === '127.0.0.1' && database.port);
assert.match(temporal, /^127\.0\.0\.1:\d+$/);
const schema = 'p5_' + randomUUID().replaceAll('-', '');
const directory = resolve(process.argv[2] ?? 'node_modules/.cache/' + schema);
const textbookHttpGrant = process.argv.includes('--textbook-http-grant');
await mkdir(directory, { recursive: true });
const sample = { official: 'P5_PRIVATE_EXPECTED', rubric: 'P5_PRIVATE_RUBRIC', answer: 'P5_LEARNER_WORK',
  linked: 'P5_PRIVATE_REFERENCE_BODY', alt: 'P5_PRIVATE_IMAGE_METADATA', original: 'P5_PINNED_TEXT', latest: 'P5_NEW_TEXT' };
let linkedId;
const captures = [];
const sessions = {};
const revokeGate = Promise.withResolvers();
const beforeRevocation = Promise.withResolvers();
const model = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    const body = await json(req);
    const messages = body.messages;
    const scenario = messages.filter(message => message.role === 'user').at(-1)?.content;
    const last = messages.at(-1);
    captures.push({ scenario, requestId: req.headers['x-client-request-id'], body });
    const wire = JSON.stringify(messages);
    for (const value of [sample.official, sample.rubric, sample.linked, sample.alt, linkedId].filter(Boolean))
      assert.ok(!wire.includes(value), 'Outbound private field: ' + value);
    const send = (delta, finish_reason) => 'data: ' + JSON.stringify({model: body.model, choices: [{delta, finish_reason}]}) + '\n\n';
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (last.role === 'tool') {
      const result = JSON.parse(last.content);
      if (scenario === 'attempt') {
        assert.equal(result.items[0].lens, 'diagnose');
        assert.equal(result.items[0].questions[0].answer, sample.answer);
        assert.equal(result.items[0].sourceRef.fact.rev, sessions.attempt.currentObject.rev);
        assert.equal(result.items[0].frozenPaper.rev, 1);
      } else if (scenario === 'page') {
        assert.equal(result.items[0].sourceRef.fact.rev, sessions.page.currentObject.rev);
        for (const text of [sample.original, 'P5_TABLE_CELL', 'P5_FORMULA']) assert.ok(result.items[0].content.includes(text));
        assert.ok(!wire.includes(sample.latest));
      } else if (scenario === 'observe') {
        assert.equal(result.status, 'saved');
      } else {
        assert.equal(scenario, 'unbound');
        assert.deepEqual(result.items.map(item => item.code), ['not_found', 'not_found']);
      }
      res.end(send({role: 'assistant', content: scenario === 'attempt' ? sample.answer : '已读取本轮结果。'}, null) + send({}, 'stop') + 'data: [DONE]\n\n');
      return;
    }
    if (scenario === 'attempt' || scenario === 'observe' || scenario === 'revoke') {
      assert.ok(wire.includes(sample.answer) && wire.includes('current_attempt'));
      if (scenario === 'revoke') {
        beforeRevocation.resolve();
        await revokeGate.promise;
      }
    } else if (scenario === 'page') {
      assert.ok(wire.includes(sample.original) && wire.includes('current_page') && !wire.includes(sample.latest));
    } else {
      assert.equal(scenario, 'unbound');
      assert.ok(!wire.includes('本轮打开的学习对象'));
    }
    const args = scenario === 'unbound' ? {refs:['current_attempt', 'current_page']}
      : scenario === 'page' ? {refs:['current_page']} : {refs:['current_attempt'], lens:'diagnose'};
    const tool = scenario === 'observe' ? {name:'record_observation', arguments: JSON.stringify({title:'P5 observation',
      text:'The original work was read before tools.', evidence_refs:[sessions.attempt.currentObject.id]})}
      : {name:'open_learning', arguments: JSON.stringify(args)};
    res.end(send({role:'assistant', tool_calls:[{index:0, id:'call_p5', type:'function',
      function:tool}]}, null) + send({}, 'tool_calls') + 'data: [DONE]\n\n');
  } catch (error) {
    console.error(error);
    res.destroy(error);
  }
}).listen(0, '127.0.0.1');
await once(model, 'listening');
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(done => probe.close(done));
const base = `http://127.0.0.1:${port}/api/`;
let studioLog = '';
const studio = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: {PATH: process.env.PATH, MANGEKYO_PORT: String(port), MANGEKYO_DATABASE_URL: database.href,
    MANGEKYO_DATABASE_SCHEMA: schema, MANGEKYO_ACTIVATE_LOCAL_BUILD: '1', TEMPORAL_ADDRESS: temporal,
    MANGEKYO_SETTINGS_FILE: resolve(directory, 'provider.json'), MANGEKYO_WORKSPACE_ACCESS_FILE: resolve(directory, 'workspace.json'),
    MANGEKYO_INTAKE_DATA_DIR: resolve(directory, 'intake'), MANGEKYO_LLM_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`},
});
const exited = once(studio, 'exit');
studio.stdout.on('data', data => {studioLog += data;});
studio.stderr.on('data', data => {studioLog += data;});
const pool = new pg.Pool({connectionString: database.href, options: '-c search_path=' + schema});
let connection;
const evidence = {schema, textbookHttpGrant, captures, sessions};

async function api(path, body, status = body === undefined ? 200 : 201, method = 'POST') {
  const response = await fetch(base + path, body === undefined ? undefined : {
    method, headers:{'content-type':'application/json'}, body:JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, status, path + ' ' + JSON.stringify(payload));
  return payload;
}
async function until(read) {
  for (let n = 0; n < 160; n++) {
    if (studio.exitCode !== null) throw new Error(studioLog);
    const value = await read();
    if (value) return value;
    await delay(250);
  }
  throw new Error('等待 Studio 状态超时。');
}
const turn = (question, currentObject) => ({caseId: 'companion', requestId: randomUUID(), question, currentObject});
const follow = (session, answer, currentObject) => api(`sessions/${session.id}/answers`, {
  requestId: randomUUID(), parentId: session.currentTurnId, answer, currentObject,
}, 202);
const open = receipt => until(async () => {
  const session = await api(`sessions/${receipt.id}`);
  return session.status !== 'pending' && session;
});
async function teaching(id, enabled) {
  const path = `workspace/access/records/${id}`;
  const {rev} = await api(path);
  return api(path, {expectedRev: rev, enabled}, 200, 'PUT');
}

try {
  await until(() => fetch(base + 'settings').then(response => response.ok, () => false));
  const {providers:[provider]} = await api('workspace/access/providers');
  const paper = await api('papers', {requestId: randomUUID(), title:'P5 Workbook', questions:[
    {kind:'exact', prompt:'Explain the first result.', answers:[sample.official], selfCheck:true},
    {kind:'rubric', prompt:'Explain the second result.', rubric:sample.rubric},
  ]});
  const submitted = await api(`papers/${paper.id}/attempts`, {requestId: randomUUID(), answers:{
    [paper.questions[0].id]: sample.answer, [paper.questions[1].id]: 'Second response',
  }}, 200);
  const attempt = submitted.attempts[0];
  assert.ok(attempt.rev > 0);
  await teaching(paper.id, true);
  const attemptGrant = await teaching(attempt.id, true);
  const attemptRef = {kind:'attempt', id:attempt.id, rev:attemptGrant.rev};
  const start = turn('attempt', attemptRef);
  await api('sessions', start, 403);
  await api(`workspace/access/providers/${provider.id}`, {baseUrl:provider.baseUrl, protocol:provider.protocol, enabled:true}, 200, 'PUT');
  await api('sessions', turn('fake body', {...attemptRef, text:'injected'}), 400);
  sessions.attempt = await api('sessions', start, 202);
  assert.deepEqual(sessions.attempt.currentObject, {alias:'current_attempt', id:attempt.id, rev:attemptGrant.rev});
  assert.equal((await api('sessions', start, 202)).id, sessions.attempt.id);
  await api('sessions', {...start, currentObject:{...attemptRef, rev:1}}, 409);
  const ready = await open(sessions.attempt);
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.ok(ready.turns.at(-1).reads.some(row => row.id === attempt.id && row.text.includes(sample.answer)));

  const linked = await api('organizer/notes', {requestId:randomUUID(), title:'Private fixture', markdown:sample.linked}, 200);
  linkedId = linked.id;
  const reference = {fact:{learner:studioLearner, id:linked.id, rev:linked.rev}, type:'activity.organizerNote', anchor:{kind:'whole'}};
  const blocks = [{kind:'text', text:sample.original}, {kind:'table', rows:[['P5_TABLE_CELL']]},
    {kind:'formula', latex:'P5_FORMULA'}, {kind:'reference', role:'citation', target:reference},
    {kind:'image', alt:sample.alt, source:reference}].map((body, index) => ({id:'block-' + index, parentId:null, body}));
  const draft = {requestId:randomUUID(), clientEditSeq:1, page:{title:'P5 Textbook', blocks}};
  const privatePage = await api('textbooks', draft);
  await api('sessions', turn('private page', {kind:'page', id:privatePage.id, rev:privatePage.rev}), 403);
  let textbook;
  if (textbookHttpGrant) {
    textbook = await teaching(privatePage.id, true);
  } else {
    const content = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/content', import.meta.url)));
    const host = openTextbook(createPgDb(pool, {schema}), content, createStudioCommandHooks());
    textbook = await host.create({...draft, requestId:randomUUID(), learner:studioLearner, purpose:['storage', 'teaching']});
  }
  const updated = await api(`textbooks/${textbook.id}`, {requestId:randomUUID(), clientEditSeq:2, expectedRev:textbook.rev,
    edits:[{kind:'rewrite', blockId:'block-0', body:{kind:'text', text:sample.latest}}]}, 200);
  assert.ok(updated.rev > textbook.rev);
  const original = await api(`textbooks/${textbook.id}?rev=${textbook.rev}`);
  sessions.page = await follow(ready, 'page', {kind:'page', id:original.id, rev:original.rev});
  assert.deepEqual(sessions.page.currentObject, {alias:'current_page', id:original.id, rev:original.rev});
  const page = await open(sessions.page);
  assert.equal(page.status, 'ready', JSON.stringify(page));
  sessions.unbound = await follow(page, 'unbound');
  assert.equal(sessions.unbound.currentObject, undefined);
  const unbound = await open(sessions.unbound);
  assert.equal(unbound.status, 'ready');
  sessions.observe = await follow(unbound, 'observe', attemptRef);
  const observe = await open(sessions.observe);
  assert.equal(observe.status, 'ready', JSON.stringify(observe));
  assert.equal(observe.turns.at(-1).writes[0].observation.status, 'saved');

  sessions.revoke = await api('sessions', turn('revoke', attemptRef), 202);
  await until(() => captures.some(hit => hit.scenario === 'revoke'));
  await Promise.race([beforeRevocation.promise, delay(2500).then(() => {throw new Error('撤权前模型替身未确认安全投影');})]);
  await teaching(attempt.id, false);
  revokeGate.resolve();
  evidence.revoked = await open(sessions.revoke);
  assert.equal(evidence.revoked.status, 'failed');
  await api('sessions', turn('denied again', attemptRef), 403);
  if (textbookHttpGrant) {
    await teaching(textbook.id, false);
    await api('sessions', turn('revoked page', {kind:'page', id:original.id, rev:original.rev}), 403);
  }
  const historical = await api(`sessions/${ready.id}`);
  assert.ok(!JSON.stringify(historical).includes(sample.answer));
  assert.deepEqual(captures.map(row => row.scenario), ['attempt','attempt','page','page','unbound','unbound','observe','observe','revoke']);

  connection = await Connection.connect({address: temporal});
  const client = new Client({connection});
  evidence.work = {};
  for (const [scenario, {currentTurnId}] of Object.entries(sessions)) {
    const {rows:[work]} = await pool.query('SELECT state, execution_ref FROM work WHERE slot_key=$1', [currentTurnId]);
    await client.workflow.getHandle(work.execution_ref).result();
    const workflow = await describeWork(client, work.execution_ref);
    assert.equal(workflow.status, 'COMPLETED');
    const {rows:effects} = await pool.query(`SELECT label, step_key, state, provider_effect_id FROM effects
      WHERE owner_kind='session' AND owner_id=$1 ORDER BY step_key`, [currentTurnId]);
    const billed = effects.filter(effect => effect.label === 'teaching-model');
    assert.deepEqual(billed.map(effect => effect.step_key), scenario === 'revoke' ? ['0'] : ['0', '16']);
    assert.ok(billed.every(effect => effect.state === 'done'));
    assert.deepEqual(billed.map(effect => effect.provider_effect_id), captures.filter(hit => hit.scenario === scenario).map(hit => hit.requestId));
    if (scenario === 'revoke' || scenario === 'observe') assert.ok(!effects.some(effect => effect.label === 'local:open_learning'));
    evidence.work[scenario] = {work, workflow, effects};
  }
  console.log('P5 Studio HTTP + PostgreSQL + Temporal + local model: aliases, pinned page, revoke, outbound and effects verified.');
} catch (error) {
  evidence.failure = String(error);
  throw error;
} finally {
  revokeGate.resolve();
  model.closeAllConnections();
  model.close();
  if (studio.exitCode === null) studio.kill('SIGTERM');
  await Promise.race([exited, delay(5000, undefined, {ref:false})]);
  if (studio.exitCode === null && studio.signalCode === null) studio.kill('SIGKILL');
  await connection?.close();
  await pool.end();
  await writeFile(resolve(directory, 'studio.log'), studioLog);
  await writeFile(resolve(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
