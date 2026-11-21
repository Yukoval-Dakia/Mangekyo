import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Connection } from '@temporalio/client';
import pg from 'pg';

export const jsonHeaders = { 'content-type': 'application/json' };

export function requestJson(url, data, { method = data ? 'POST' : 'GET', headers = data ? jsonHeaders : undefined } = {}) {
  return fetch(url, { method, headers, body: data ? JSON.stringify(data) : undefined });
}

function assertJsonOk(response, path, result) {
  assert.ok(response.ok, path + ' ' + response.status + ' ' + JSON.stringify(result));
}

export function studioJsonApi(base, check = assertJsonOk) {
  return async (path, data, method, status) => {
    const response = await requestJson(new URL('/api/' + path, base), data, { method });
    const result = await response.json();
    check(response, path, result, status);
    return result;
  };
}

export async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  return port;
}

export function spawnStudio({ port, env, cwd = fileURLToPath(new URL('../../../runtime/studio/', import.meta.url)), inherit = false }) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd, env: { PATH: process.env.PATH, MANGEKYO_PORT: String(port), MANGEKYO_ACTIVATE_LOCAL_BUILD: '1', ...env },
    ...(inherit ? { stdio: 'inherit' } : {}),
  });
  let log = '';
  child.on('error', error => { log += String(error); });
  if (!inherit) {
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { log += data; });
  }
  return { child, log: () => log };
}

export async function temporalNamespace(address, schema) {
  const namespace = schema.replaceAll('_', '-');
  const connection = await Connection.connect({ address });
  try {
    await connection.workflowService.registerNamespace({ namespace, workflowExecutionRetentionPeriod: { seconds: 86_400 } });
  } catch (error) {
    await connection.close();
    throw error;
  }
  return { connection, namespace };
}

export async function isolatedSchema(databaseUrl, prefix = 'test_gui_') {
  const database = new URL(databaseUrl);
  const schema = prefix + randomUUID().replaceAll('-', '');
  const directory = resolve(process.argv[2] ?? 'node_modules/.cache/' + schema);
  await mkdir(directory, { recursive: true });
  const pool = new pg.Pool({ connectionString: database.href, options: '-c search_path=' + schema });
  return { database, schema, directory, pool };
}

export async function dropIsolatedSchema(pool, schema) {
  await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').finally(() => pool.end());
}

export async function stopStudio(host, timeout = 5000) {
  const { child } = host;
  const exited = new Promise(done => child.once('close', done));
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.race([exited, delay(timeout, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
}

export async function waitForSession(session, read, interval, timeout) {
  const deadline = Date.now() + timeout;
  while (session.status === 'pending' && Date.now() < deadline) {
    await delay(interval);
    session = await read(session.id);
  }
  return session;
}

export async function pollUntil(read, { attempts = 80, interval = 250 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const value = await read();
    if (value) return value;
    await delay(interval);
  }
  throw new Error('Timed out waiting for the expected state.');
}

export function providerRoute(settings, task = 'companion') {
  const providerId = settings.routes?.[task] ?? settings.activeProviderId;
  const provider = settings.providers.find(profile => profile.id === providerId);
  assert.ok(provider);
  return { providerId, baseUrl: provider.baseUrl, protocol: provider.protocol,
    model: provider.model, reasoningEffort: provider.reasoningEffort };
}
