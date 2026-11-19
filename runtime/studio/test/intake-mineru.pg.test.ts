import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgDb } from '../../../kernel/src/db/pg.ts';
import { applyKernelSchema } from '../../../kernel/src/schema.ts';
import { loadModuleDirectory } from '../../../kernel/src/loader.ts';
import { acknowledgeStartedWork, relayPending, type WorkRef } from '../../../kernel/src/work/index.ts';
import { studioLearner } from '../identity.ts';
import { openCloudIntakeWork, type MineruClient } from '../intake-cloud.ts';
import { handleIntakeRequest, openIntake, type IntakeMetadata } from '../intake.ts';

const connectionString = process.env.MANGEKYO_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('MinerU intake in PostgreSQL', () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof createPgDb>;
  let intake: ReturnType<typeof openIntake>;
  let server: ReturnType<typeof createServer>;
  let directory: string;
  let origin: string;
  let failCapture = false;
  const schema = 'mineru_intake_' + process.pid;
  const refs: WorkRef[] = [];
  const pdf = Buffer.from('%PDF-1.7\n% synthetic upload');
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mangekyo-intake-'));
    vi.stubEnv('MANGEKYO_INTAKE_DATA_DIR', directory);
    vi.stubEnv('MANGEKYO_MINERU_TOKEN', 'test-token');
    pool = new pg.Pool({ connectionString });
    await pool.query('CREATE SCHEMA ' + schema);
    db = createPgDb(new pg.Pool({ connectionString }), { schema });
    await applyKernelSchema(db);
    await db.query('INSERT INTO learners(id) VALUES ($1)', [studioLearner]);
    const activity = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/activity', import.meta.url)));
    intake = openIntake(db, activity, {
      async onFactsChanged() {
        if (failCapture) throw new Error('simulated save failure');
      },
    });
    server = createServer((req, res) => {
      void handleIntakeRequest(intake, req, res, new URL(req.url!, 'http://127.0.0.1').pathname, req.method);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    origin = 'http://127.0.0.1:' + address.port;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await db?.close();
    if (pool) {
      await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await pool.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function capture(requestId: string, extraction: string | null = 'mineru', mediaType = 'application/pdf') {
    const form = new FormData();
    form.set('requestId', requestId);
    if (extraction !== null) form.set('extraction', extraction);
    form.set('file', new Blob([mediaType === 'text/plain' ? '本地文本' : pdf], { type: mediaType }),
      mediaType === 'text/plain' ? 'note.txt' : 'exam.pdf');
    return fetch(origin + '/api/intake', { method: 'POST', body: form });
  }
  async function nextWork() {
    await relayPending(db, async (_, intent) => {
      const ref = await acknowledgeStartedWork(db, intent);
      if (ref) refs.push(ref);
    });
    const ref = refs.shift();
    if (!ref) throw new Error('No durable intake work');
    return ref;
  }

  it('returns a saved receipt first and resumes polling without reuploading', async () => {
    expect(await (await capture('local-intake', null, 'text/plain')).json()).toMatchObject({
      fullText: '本地文本', extraction: { method: 'utf8', status: 'ok' },
    });
    const receipt = await (await capture('mineru-success')).json() as IntakeMetadata;
    expect(receipt.extraction.status).toBe('pending');
    expect((await intake.original(receipt.id)).stored.sha256).toBe(receipt.original.sha256);
    expect((await (await capture('mineru-success')).json() as IntakeMetadata).id).toBe(receipt.id);
    expect((await capture('mineru-success', 'local')).status).toBe(409);

    const submit = vi.fn<MineruClient['submit']>(async () => 'batch-test');
    const read = vi.fn<MineruClient['read']>()
      .mockRejectedValueOnce(new Error('connect'))
      .mockResolvedValueOnce({ state: 'pending', pages: 2 })
      .mockResolvedValueOnce({ state: 'done', text: '完整正文\n$\\frac{1}{2}$', pages: 2 });
    const ref = await nextWork();
    const work = () => openCloudIntakeWork(db, intake, { submit, read }, 0);
    await expect(work().execute(ref)).rejects.toThrow('connect');
    expect((await intake.metadata(receipt.id)).extraction.status).toBe('pending');
    await work().execute(ref);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0].bytes).toEqual(pdf);
    expect(await (await fetch(origin + '/api/materials/' + receipt.id)).json()).toMatchObject({
      fullText: '完整正文\n$\\frac{1}{2}$',
      extraction: { method: 'mineru', status: 'ok', pages: 2 },
    });
  });

  it('keeps original bytes on failure and does not replace a manual correction', async () => {
    const failed = await (await capture('mineru-failed')).json() as IntakeMetadata;
    const client: MineruClient = {
      submit: async () => { throw new Error('lost acknowledgment'); },
      read: async () => { throw new Error('unexpected poll'); },
    };
    await openCloudIntakeWork(db, intake, client).execute(await nextWork());
    expect(await intake.metadata(failed.id)).toMatchObject({ fullText: null, extraction: { status: 'failed' } });
    expect((await intake.original(failed.id)).stored.size).toBe(pdf.length);

    const pending = await (await capture('mineru-corrected')).json() as IntakeMetadata;
    const ref = await nextWork();
    const read = async () => {
      await intake.correct({ materialId: pending.id, expectedRev: pending.revision, text: '人工更正', requestId: 'manual-correction' });
      return { state: 'done', text: '过期识别', pages: 1 } as const;
    };
    await openCloudIntakeWork(db, intake, { submit: async () => 'batch-test', read }).execute(ref);
    expect(await intake.metadata(pending.id)).toMatchObject({ fullText: '人工更正', extraction: { status: 'corrected' } });
  });

  it('rejects ambiguous or invalid intake and leaves a failed save retryable', async () => {
    const originals = () => readdir(join(directory, 'intake'));
    const before = await originals();
    const form = new FormData();
    form.set('requestId', 'mineru-invalid-fields');
    form.set('extraction', 'mineru');
    form.append('extraction', 'local');
    form.set('file', new Blob([pdf], { type: 'application/pdf' }), 'exam.pdf');
    expect((await fetch(origin + '/api/intake', { method: 'POST', body: form })).status).toBe(400);
    failCapture = true;
    try { expect((await capture('mineru-retry-save')).status).toBe(500); }
    finally { failCapture = false; }
    expect(await originals()).toEqual(before);
    expect((await capture('mineru-retry-save')).status).toBe(201);
  });

});
