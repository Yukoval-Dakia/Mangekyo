import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { testDatabaseUrl } from '../../../kernel/test/learner-database.ts';

const studioDir = fileURLToPath(new URL('..', import.meta.url));

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      probe.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

it.skipIf(!testDatabaseUrl)('keeps the studio HTTP surface alive while Temporal is unreachable', { timeout: 60_000 }, async () => {
  const schema = `test_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  const httpPort = await freePort();
  const temporalPort = await freePort();
  const directory = mkdtempSync(join(tmpdir(), 'mangekyo-offline-'));
  let log = '';
  const studio = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: studioDir,
    env: {
      PATH: process.env.PATH!,
      MANGEKYO_PORT: String(httpPort),
      MANGEKYO_DATABASE_URL: testDatabaseUrl!,
      MANGEKYO_DATABASE_SCHEMA: schema,
      TEMPORAL_ADDRESS: `127.0.0.1:${temporalPort}`,
      MANGEKYO_SETTINGS_FILE: join(directory, 'provider.json'),
      MANGEKYO_WORKSPACE_ACCESS_FILE: join(directory, 'workspace.json'),
    },
  });
  studio.stdout.on('data', data => { log += data; });
  studio.stderr.on('data', data => { log += data; });
  const exited = new Promise<number | null>(resolve => studio.once('close', code => resolve(code)));
  const get = () => fetch(`http://127.0.0.1:${httpPort}/api/cases`, { signal: AbortSignal.timeout(3000) });
  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      if (studio.exitCode !== null || studio.signalCode !== null) throw new Error('Studio 进程提前退出：' + log);
      try {
        ready = (await get()).status === 200;
      } catch {
        await delay(250);
      }
    }
    expect(ready, log).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect((await get()).status).toBe(200);
      await delay(300);
      expect(studio.exitCode, log).toBeNull();
    }
  } finally {
    studio.kill('SIGTERM');
    const code = await Promise.race([exited, delay(15_000).then(() => {
      studio.kill('SIGKILL');
      return 'timeout' as const;
    })]);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await pool.end();
    if (code === 'timeout') throw new Error('Studio 未能在 SIGTERM 后干净退出：' + log);
  }
});
