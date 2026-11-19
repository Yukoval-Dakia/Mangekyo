import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import pg from 'pg';

const { MANGEKYO_DATABASE_URL, MANGEKYO_PORT, TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } = process.env;
assert.equal(process.argv[2], '--isolated', '请指定独立的本机 PG、Temporal 和 Studio 端口，并加 --isolated。');
assert.equal(new URL(MANGEKYO_DATABASE_URL).hostname, '127.0.0.1');
assert.match(TEMPORAL_ADDRESS, /^127\.0\.0\.1:\d+$/);
assert.ok(TEMPORAL_NAMESPACE && TEMPORAL_NAMESPACE !== 'default' && Number(MANGEKYO_PORT) > 0);
const schema = 'research_' + randomUUID().replaceAll('-', '');
const dir = await mkdtemp(join(tmpdir(), 'mangekyo-research-proof-'));
const barrier = 517123;
const env = {
  PATH: process.env.PATH, MANGEKYO_DATABASE_URL, MANGEKYO_PORT, TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE,
  MANGEKYO_DATABASE_SCHEMA: schema, MANGEKYO_TASK_QUEUE: schema, MANGEKYO_ACTIVATE_LOCAL_BUILD: '1',
  MANGEKYO_SETTINGS_FILE: join(dir, 'empty-provider.json'), MANGEKYO_INTAKE_DATA_DIR: join(dir, 'intake'),
};
const processes = [];
function start(mode, label = mode) {
  const log = openSync(join(dir, label + '.log'), 'w');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: new URL('../', import.meta.url), env: { ...env, MANGEKYO_PROCESS: mode }, stdio: ['ignore', log, log],
  });
  closeSync(log);
  processes.push(child);
  return child;
}
async function until(read) {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (value) return value;
    await delay(200);
  }
  throw new Error('等待超时。证据目录 ' + dir);
}
async function api(path, method = 'GET', data, expected = 200) {
  const response = await fetch('http://127.0.0.1:' + MANGEKYO_PORT + path, {
    method, headers: { 'content-type': 'application/json', connection: 'close' },
    ...(data && { body: JSON.stringify({ requestId: randomUUID(), ...data }) }),
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}
const sql = new pg.Client({ connectionString: MANGEKYO_DATABASE_URL });
const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
const temporal = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
const isWaiting = async () => (await sql.query(
  "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND NOT granted", [barrier],
)).rowCount;

try {
  start('web');
  const settings = '/api/research/settings';
  await until(() => api(settings).catch(error => { if (error instanceof TypeError) return null; throw error; }));
  await sql.connect();
  await sql.query('SET search_path TO ' + schema);
  await sql.query(`CREATE FUNCTION stop_publish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.type = 'companion.publishWorksheet' THEN PERFORM pg_advisory_xact_lock(${barrier}); END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER stop_publish BEFORE INSERT ON commands FOR EACH ROW EXECUTE FUNCTION stop_publish();`);
  await sql.query('SELECT pg_advisory_lock($1)', [barrier]);
  assert.deepEqual(await api(settings), { enabled: false, revision: 0, paidBudget: 0 });
  const paper = await api('/api/papers', 'POST', { title: '矩形面积', questions: [
    { kind: 'numeric', prompt: '长 6 厘米、宽 4 厘米，面积是多少平方厘米？', answer: 24, tolerance: 0 },
  ] }, 201);
  const questionId = paper.questions[0].id;
  const attempts = '/api/papers/' + paper.id + '/attempts';
  const submit = async answer => (await api(attempts, 'POST', { answers: { [questionId]: answer } })).attempts
    .find(attempt => attempt.answers[questionId] === Number(answer));
  const old = await submit('20');
  const ungranted = await submit('10');
  const path = attempts + '/' + old.id + '/research';
  const permission = path + '-permission';
  assert.deepEqual(await api(permission), { allowed: false, revision: 1 });
  assert.deepEqual(await api(permission, 'PUT', { revision: 1, allowed: true }), { allowed: true, revision: 2 });
  assert.equal((await sql.query('SELECT id FROM work')).rowCount, 0);
  assert.deepEqual(await api(path), { worksheet: null });
  assert.equal((await api(settings, 'PUT', { revision: 0, enabled: true })).enabled, true);

  // The enabling client has closed. Observe durable work and retry without requesting the artifact.
  const first = start('worker', 'worker-first');
  await until(isWaiting);
  const [{ execution_ref: id }] = (await sql.query("SELECT execution_ref FROM work WHERE slot_type = 'companion.researchDelivery'")).rows;
  const [{ coordinator }] = (await sql.query("SELECT data->>'coordinatorRef' AS coordinator FROM fact_revs WHERE data ? 'coordinatorRef'")).rows;
  const run = temporal.workflow.getHandle(id);
  const before = await run.describe();
  assert.equal(before.raw.pendingActivities[0].attempt, 1);
  assert.equal((await sql.query("SELECT id FROM commands WHERE type = 'companion.publishWorksheet'")).rowCount, 0);
  await new Promise(resolve => { first.once('exit', resolve); first.kill('SIGKILL'); });
  assert.equal(first.signalCode, 'SIGKILL');
  await sql.query('SELECT pg_advisory_unlock($1)', [barrier]);
  const second = start('worker', 'worker-second');
  await run.result();
  const reopenedAt = new Date().toISOString();
  const { worksheet } = await api(path);
  assert.equal(worksheet.method, 'deterministic-v1');
  assert.equal(worksheet.cost, 0);
  assert.equal(worksheet.autonomy, 0);
  assert.ok(worksheet.steps.length > 0 && worksheet.deliveredAt <= reopenedAt);
  assert.deepEqual(await api(path), { worksheet });
  const source = await api(worksheet.source.href);
  assert.equal(source.attemptId, old.id);
  assert.equal(source.questionId, questionId);
  assert.equal(source.feedback.answer, 20);
  assert.equal(source.feedback.expected.value, 24);
  assert.deepEqual(await api(attempts + '/' + ungranted.id + '/research'), { worksheet: null });
  const after = await run.describe();
  assert.equal(after.runId, before.runId);
  const history = await run.fetchHistory();
  assert.ok(history.events.some(event => event.activityTaskStartedEventAttributes?.attempt === 2));
  const receipts = (await sql.query("SELECT type, receipt FROM commands WHERE type IN ('companion.prepareResearch', 'companion.publishWorksheet') ORDER BY tick")).rows;
  assert.deepEqual(receipts.map(row => row.type), ['companion.prepareResearch', 'companion.publishWorksheet']);
  assert.deepEqual(await api(permission, 'PUT', { revision: 2, allowed: false }), { allowed: false, revision: 3 });
  assert.deepEqual(await api(path), { worksheet: null });
  await api(worksheet.source.href, 'GET', undefined, 404);
  const report = { schema, namespace: TEMPORAL_NAMESPACE, workerPids: [first.pid, second.pid], taskQueue: after.taskQueue,
    workflowId: id, runId: after.runId, workerBefore: before.raw.pendingActivities[0].lastWorkerIdentity,
    worksheet, source, receipts, reopenedAt, revoked: { worksheet: null, sourceStatus: 404 } };
  await writeFile(join(dir, 'work-history.json'), JSON.stringify(history, null, 2));
  await writeFile(join(dir, 'coordinator-history.json'), JSON.stringify(
    await temporal.workflow.getHandle('coordinator:' + coordinator).fetchHistory(), null, 2,
  ));
  await writeFile(join(dir, 'proof.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ dir, ...report }, null, 2));
} finally {
  for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await sql.end();
  await connection.close();
}
