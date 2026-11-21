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
import { describeWork } from '../../../executors/temporal/src/index.ts';
import { studioJsonApi } from './acceptance-fixtures.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const view = {
  version: 1, id: 'fixture-passage', revision: 'passage-r1',
  title: '尝试两种断句', fallback: '读原文，选择停顿位置。',
  sections: [{ id: 'passage', title: '原文', layout: 'stack', nodes: [
    { kind: 'selection', id: 'breakpoints', label: '原文与断点', layout: 'passage', selected: [],
      items: [{ id: 'gap-2', label: '有客' }, { id: 'gap-4', label: '至门' },
        { id: 'gap-6', label: '主人' }, { id: 'gap-8', label: '问之' }], tail: '而笑' },
    { kind: 'action', id: 'hand-in', label: '交卷', intent: 'submit', inputs: ['breakpoints'] },
  ] }],
};
const predictionPrompt = '你预计哪里停顿？';
const database = new URL(process.env.MANGEKYO_ARTIFACT_ACCEPTANCE_DATABASE_URL ?? '');
const temporal = process.env.MANGEKYO_ARTIFACT_ACCEPTANCE_TEMPORAL ?? '';
assert.ok(/^postgres(ql)?:$/.test(database.protocol) && database.hostname === '127.0.0.1' && database.port);
assert.match(temporal, /^127\.0\.0\.1:\d+$/);
const schema = 'gui_' + randomUUID().replaceAll('-', '');
const directory = resolve(process.argv[2] ?? 'node_modules/.cache/' + schema);
await mkdir(directory, { recursive: true });
let studioLog = '';
let generation;
const model = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    const body = await json(req);
    assert.ok(body.tools.some(tool => tool.function.name === 'mount_artifact'));
    const last = body.messages.at(-1);
    if (last.role === 'tool') {
      generation.toolWire = last.content;
      generation.toolResult = JSON.parse(last.content);
      await generation.finish.promise;
      const content = generation.mode === 'formal' ? '参考答案为 gap-2、gap-4。' : '已完成这道练习的准备。';
      const frame = (delta, finish_reason) =>
        'data: ' + JSON.stringify({ model: body.model, choices: [{ delta, finish_reason }] }) + '\n\n';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frame({ role: 'assistant', content }, null) + frame({}, 'stop') + 'data: [DONE]\n\n');
      return;
    }
    const message = { role: 'assistant', tool_calls: [{
      id: 'mount-fixture', type: 'function', function: { name: 'mount_artifact', arguments: JSON.stringify({
        view, ...(generation.mode === 'exploration' ? {} : {
          predictionPrompt,
          sentenceBreaks: generation.mode === 'rejected' ? [['gap-2', 'gap-4'], ['gap-4', 'gap-8']]
            : [['gap-2', 'gap-4'], ['gap-4', 'gap-6']],
        }),
      }) },
    }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      model: body.model, choices: [{ message, finish_reason: 'tool_calls' }],
    }));
  } catch (error) {
    console.error(error);
    res.writeHead(500).end();
  }
}).listen(0, '127.0.0.1');
await once(model, 'listening');
const freePort = createServer().listen(0, '127.0.0.1');
await once(freePort, 'listening');
const port = freePort.address().port;
await new Promise(done => freePort.close(done));
const base = 'http://127.0.0.1:' + port + '/api/';
const studio = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
  cwd,
  env: {
    PATH: process.env.PATH,
    MANGEKYO_PORT: String(port),
    MANGEKYO_DATABASE_URL: database.href,
    MANGEKYO_DATABASE_SCHEMA: schema,
    MANGEKYO_ACTIVATE_LOCAL_BUILD: '1',
    TEMPORAL_ADDRESS: temporal,
    MANGEKYO_SETTINGS_FILE: resolve(directory, 'provider.json'),
    MANGEKYO_WORKSPACE_ACCESS_FILE: resolve(directory, 'workspace.json'),
    MANGEKYO_ARTIFACT_ASSESSMENT_MODULE: resolve(cwd, 'test/artifact-assessment-witness.ts'),
    MANGEKYO_LLM_BASE_URL: 'http://127.0.0.1:' + model.address().port + '/v1',
  },
});
const exited = once(studio, 'exit');
studio.stdout.on('data', data => { studioLog += data; });
studio.stderr.on('data', data => { studioLog += data; });
const pool = new pg.Pool({ connectionString: database.href, options: '-c search_path=' + schema });
let connection;

async function until(read) {
  for (let i = 0; i < 180; i++) {
    if (studio.exitCode !== null) throw new Error(studioLog);
    const value = await read();
    if (value) return value;
    await delay(250);
  }
  throw new Error('等待 Studio 状态超时。');
}

const api = studioJsonApi(base, (response, path, result) => {
  assert.ok(response.ok, JSON.stringify({ path, status: response.status, result }));
});

function snapshot(session) {
  return session.artifacts?.[0] ?? session.turns.at(-1)?.artifacts?.[0];
}

function assertPrivate(wire) {
  assert.doesNotMatch(JSON.stringify(wire), /sentenceBreaks|"alternatives"|"qualification"|"witnessRef"|"parameters"|"assessment":|参考答案为/u);
}

async function streamBeforeSubmission(path) {
  const response = await fetch(base + path + '/events', { signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok);
  let pending = '';
  let exerciseDelivered = false;
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    pending += chunk;
    for (let end; (end = pending.indexOf('\n\n')) >= 0;) {
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const line = frame.split('\n').find(entry => entry.startsWith('data: '));
      if (!line) continue;
      const data = JSON.parse(line.slice(6));
      assertPrivate(data);
      if (frame.includes('event: artifact-snapshot') && !data.predicting) {
        exerciseDelivered = true;
        generation.finish.resolve();
      }
      if (frame.includes('event: complete') && exerciseDelivered) return;
    }
  }
  throw new Error('SSE 没有送达预期作品状态。');
}

function action(mount, nodeId, intent, answers, steps = []) {
  return { version: 1, mountId: mount.mountId, requestId: randomUUID(), baseStateRev: mount.stateRev,
    action: { version: 1, artifactId: mount.view.id, revision: mount.view.revision, nodeId, intent,
      answers, trace: { omitted: 0, steps } },
  };
}

async function start(mode = 'formal') {
  generation = { mode, finish: Promise.withResolvers() };
  const session = await api('sessions', { caseId: 'companion', requestId: randomUUID(), question: '请出一道断句练习。' });
  const path = 'sessions/' + session.id;
  return { path, toolResult: await until(() => generation.toolResult) };
}

function ready(path) {
  return until(async () => {
    const current = await api(path);
    return current.status === 'ready' && current;
  });
}

try {
  connection = await Connection.connect({ address: temporal });
  const temporalClient = new Client({ connection });
  await until(() => fetch(base + 'settings').then(r => r.ok, () => false));
  const { providers: [provider] } = await api('workspace/access/providers');
  const accessPath = 'workspace/access/providers/' + provider.id;
  const route = { baseUrl: provider.baseUrl, protocol: provider.protocol };
  await api(accessPath, { ...route, enabled: true }, 'PUT');

  for (const [ids, earned] of [
    [['gap-2', 'gap-4'], 100], [['gap-6', 'gap-4'], 100], [['gap-2', 'gap-4', 'gap-6'], 66], [[], null],
  ]) {
    const { path, toolResult } = await start();
    const first = await api(path);
    const mount = snapshot(first);
    assert.ok(mount?.predicting, JSON.stringify(toolResult));
    assertPrivate(first);
    const checkpoint = action(mount, 'record-prediction', 'saveDraft', { estimate: { kind: 'text', text: '预计有两个停顿。' } });
    const prediction = await api(path + '/artifact-actions', checkpoint);
    const before = await api(path);
    assertPrivate(before);
    await streamBeforeSubmission(path);
    const exercise = snapshot(before);
    assert.deepEqual(exercise.prediction, prediction.snapshot.prediction);
    assert.equal(exercise.prediction.id, prediction.receipt.wrote[0].id);
    assert.deepEqual(exercise.questionRef, { id: mount.mountId, rev: 1 });
    assert.deepEqual(exercise.view, { ...view, id: exercise.view.id });
    assertPrivate(await ready(path));
    const handIn = action(exercise, 'hand-in', 'submit', { breakpoints: { kind: 'selection', ids } },
      ids.map(objectId => ({ kind: 'toggle', nodeId: 'breakpoints', objectId, selected: true })));
    const submit = await api(path + '/artifact-actions', handIn);
    const state = earned === null ? 'incomplete' : 'complete';
    assert.ok(['queued', state].includes(submit.snapshot.assessment.state));
    const reopened = await until(async () => {
      const current = await api(path);
      return snapshot(current)?.assessment.state !== 'queued' && current;
    });
    const settled = snapshot(reopened);
    assert.equal(settled.assessment.state, state, JSON.stringify(settled.assessment));
    assert.deepEqual(settled.assessment.score, earned === null ? null : { earned, maximum: 100 });
    assert.equal(settled.assessment.result.outcomes[0].state, earned === null ? 'unsubmitted' : 'scored');
    assert.deepEqual(settled.assessment.result.releaseRef, exercise.questionRef);
    assert.deepEqual(settled.assessment.result.submissionRef, settled.assessment.submissionRef);
    assert.equal(settled.assessment.submissionRef.id, submit.receipt.wrote[0].id);
    assert.deepEqual(settled.prediction, exercise.prediction);
    assert.deepEqual(settled.view, exercise.view);
    const replay = await api(path + '/artifact-actions', handIn);
    assert.equal(replay.receipt.commandId, submit.receipt.commandId);
    assert.deepEqual(replay.snapshot.assessment, settled.assessment);

    const { rows } = await pool.query(`
      SELECT w.id, w.generation::int, w.state, w.execution_ref, o.state AS outbox,
        w.requested_tick = a.tick AS same_tick, d.lifecycle, d.manifest, a.data->>'predictionRef' AS prediction,
        m.data->'assessment'->'qualification' AS qualification, m.data->'assessment'->'runs' AS runs,
        (SELECT count(*)::int FROM effects e WHERE e.learner_id=d.learner_id AND e.owner_kind='derivation'
          AND e.owner_id=d.id) AS effects
      FROM work w JOIN slot_state s USING (learner_id, slot_type, slot_key)
      JOIN work_outbox o ON (o.learner_id, o.work_id) = (w.learner_id, w.id)
      JOIN derivations d ON (d.learner_id, d.id) = (s.learner_id, s.current_id)
      JOIN fact_revs a ON a.learner_id=w.learner_id AND a.fact_id=$1 AND a.rev=1
      JOIN fact_revs m ON m.learner_id=w.learner_id AND m.fact_id=$2 AND m.rev=1
      WHERE w.slot_type='activity.artifactFormalAssessment' AND s.scope_keys->'submissionRef'->>'id'=$1
    `, [settled.assessment.submissionRef.id, exercise.questionRef.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].generation, 1);
    assert.equal(rows[0].lifecycle, 'effective');
    assert.equal(rows[0].outbox, 'delivered');
    assert.equal(rows[0].state, 'satisfied');
    assert.equal(rows[0].same_tick, true);
    assert.equal(rows[0].effects, 0);
    await temporalClient.workflow.getHandle(rows[0].execution_ref).result();
    const workflow = await describeWork(temporalClient, rows[0].execution_ref);
    assert.equal(workflow.status, 'COMPLETED');
    assert.equal(rows[0].prediction, exercise.prediction.id);
    assert.equal(rows[0].qualification.samples.length, 4);
    assert.deepEqual(rows[0].runs.map(({ actual }) => actual.outcomes[0].earned ?? null), [100, 100, 66, null]);
  }

  const { path, toolResult } = await start('rejected');
  assert.deepEqual(toolResult, {
    ok: false, code: 'invalid_args', field: 'sentenceBreaks', message: '正式断句需要宿主独立核验。',
  });
  const rejectedEvents = await fetch(base + path + '/events', { signal: AbortSignal.timeout(15000) });
  assert.ok(rejectedEvents.ok);
  const rejectedStream = rejectedEvents.text();
  generation.finish.resolve();
  const rejected = await ready(path);
  assert.equal(snapshot(rejected), undefined);
  const wire = await rejectedStream;
  const turnId = rejected.currentTurnId;
  const { rows: archive } = await pool.query(`
    SELECT d.id, d.value->'trace' AS trace
    FROM slot_state s JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id
    WHERE s.slot_key=$1 AND d.value->>'action'='companion_reply'
  `, [turnId]);
  assert.equal(archive.length, 1);
  const learnerResponse = await fetch(base + path);
  assert.ok(learnerResponse.ok);
  const learnerWire = await learnerResponse.text();
  assert.deepEqual(JSON.parse(learnerWire), rejected);
  await writeFile(resolve(directory, 'rejected-model.json'), generation.toolWire);
  await writeFile(resolve(directory, 'rejected-learner.json'), learnerWire);
  await writeFile(resolve(directory, 'rejected-learner.sse'), wire);
  await writeFile(resolve(directory, 'rejected-archive.json'), JSON.stringify({ schema, path, turnId, ...archive[0] }, null, 2));

  const { path: exploration } = await start('exploration');
  generation.finish.resolve();
  const legacy = snapshot(await ready(exploration));
  const oldSubmission = action(legacy, 'hand-in', 'submit', { breakpoints: { kind: 'selection', ids: [] } });
  const oldReceipt = await api(exploration + '/artifact-actions', oldSubmission);
  assert.equal(oldReceipt.snapshot.submitted, true);
  assert.ok(!('assessment' in oldReceipt.snapshot) && !('questionRef' in legacy));
  assert.equal((await pool.query("SELECT count(*)::int FROM work WHERE slot_type='activity.artifactFormalAssessment'")).rows[0].count, 4);
  console.log('Formal scoring, Temporal settlement, replay and legacy exploration passed.');
  assertPrivate(rejected);
  assert.match(wire, /event: complete/u);
  for (const line of wire.split('\n')) {
    if (line.startsWith('data: ')) assertPrivate(JSON.parse(line.slice(6)));
  }
  assert.deepEqual(rejected.turns.at(-1).trace, ['挂载交互作品 · 未挂载']);
  assert.deepEqual(archive[0].trace, rejected.turns.at(-1).trace);
  console.log('Studio HTTP/SSE → PG/outbox → Temporal → effective: 100/100, 100/100, 66/100, unsubmitted; changed rules rejected; legacy submission preserved.');
} finally {
  generation?.finish.resolve();
  model.closeAllConnections();
  model.close();
  if (studio.exitCode === null) studio.kill('SIGTERM');
  await Promise.race([exited, delay(5000, undefined, { ref: false })]);
  if (studio.exitCode === null && studio.signalCode === null) studio.kill('SIGKILL');
  await connection?.close();
  await pool.end();
  await writeFile(resolve(directory, 'studio.log'), studioLog);
}
