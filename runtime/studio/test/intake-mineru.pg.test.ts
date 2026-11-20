import { factId } from '../../../kernel/src/declarations/ids.ts';
import { intakeIdFor } from '../intake-lifecycle.ts';
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgDb } from '../../../kernel/src/db/pg.ts';
import { applyKernelSchema } from '../../../kernel/src/schema.ts';
import { loadModuleDirectory } from '../../../kernel/src/loader.ts';
import { acknowledgeStartedWork, relayPending, runEffect, type WorkRef } from '../../../kernel/src/work/index.ts';
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
    const capture = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/capture', import.meta.url)));
    const content = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/content', import.meta.url)));
    intake = openIntake(db, capture, content, {
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

  function capture(requestId: string, extraction: string | null = 'mineru', mediaType = 'application/pdf', watermark = '0') {
    const form = new FormData();
    form.set('requestId', requestId);
    form.set('deletionWatermark', watermark);
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

  it('burns intake identities before replay and rejects a result returned after confirmation', async () => {
    const state = async () => (await fetch(origin + '/api/lifecycle')).json() as Promise<{watermark:string}>;
    expect((await state()).watermark).toBe('0');
    const prior = await (await capture('delete-during-send')).json() as IntakeMetadata;
    const path = origin + '/api/materials/' + prior.id;
    const erase = (confirmation: string) => fetch(path + '/erasure', {method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({requestId:'delete-this-original',expectedRev:prior.revision,confirmation})});
    expect((await erase('cancel')).status).toBe(403);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
    // Other tests may have queued ready work. Select this document's actual execution.
    const {rows:[intent]} = await db.query<{execution_ref:string}>(
      'SELECT execution_ref FROM work WHERE learner_id=$1 AND slot_key=$2',[studioLearner,intakeIdFor(factId(prior.id))]);
    const ref = await acknowledgeStartedWork(db,intent!.execution_ref);
    const running = openCloudIntakeWork(db,intake,{
      submit:async () => { entered.resolve(); return release.promise; },
      read:async () => { throw new Error('late result reached polling'); },
    }).execute(ref!);
    await entered.promise;
    const documentId = intakeIdFor(factId(prior.id));
    const { rows: [sent] } = await db.query<{provider_effect_id:string; started_tick:string}>(
      'SELECT provider_effect_id,started_tick FROM effects WHERE learner_id=$1 AND owner_id=$2', [studioLearner,documentId]);
    expect(sent?.provider_effect_id).toBeTruthy();
    await db.query(`INSERT INTO effects (learner_id,owner_kind,owner_id,step_key,label,input_digest,state,started_tick)
      SELECT id,'session','legacy-session','call','external','digest','started',clock FROM learners WHERE id=$1`, [studioLearner]);
    const confirmed = 'permanently-delete-original';
    try {
      const marker = join(directory,'intake',prior.id,'store-id');
      await rename(marker,marker + '.offline');
      const blocked = await (await erase(confirmed)).json() as {generation:string};
      expect(blocked).toMatchObject({blocked:true,original:'pending'});
      expect((await fetch(path + '/original')).status).toBe(404);
      await rename(marker + '.offline',marker);
      const receipt = await (await erase(confirmed)).json() as {generation:string};
      expect(receipt.generation).toBe(blocked.generation);
      expect(receipt).toMatchObject({blocked:true,original:'removed',copies:'unverified'});
      expect(await (await erase(confirmed)).json()).toEqual(receipt);
      expect(await readdir(join(directory,'intake',prior.id))).toEqual(['store-id']);
      expect(await state()).toMatchObject({watermark:receipt.generation,tombstones:[{generation:receipt.generation},{generation:receipt.generation}]});
      expect((await fetch(path + '/original')).status).toBe(404);
      expect((await capture('delete-during-send')).status).toBe(410);
      const stale = await capture('different-replay-id',null,'text/plain');
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({code:'deletion_watermark_stale'});
    } finally { release.resolve('private-late-result'); await running; }
    expect((await db.query('SELECT * FROM erased_effect_receipts WHERE learner_id=$1 AND owner_id=$2', [studioLearner,documentId])).rows)
      .toEqual([{learner_id:studioLearner,owner_id:documentId,...sent,erased_tick:(await state()).watermark,settlement:'unknown'}]);
    // A worker that loaded v7 before migration cannot reinstall the identity.
    await expect(db.query(`INSERT INTO facts(learner_id,id,type,current_rev,created_tick,changed_tick)
      VALUES ($1,$2,'legacy',1,1,1)`,[studioLearner,prior.id])).rejects.toThrow('Erased identity');
    await expect(db.query(`UPDATE effects SET state='done',result='"late response"'
      WHERE learner_id=$1 AND owner_id='legacy-session' AND state='started'`, [studioLearner]))
      .rejects.toMatchObject({code:'55000'});
    expect((await db.query("SELECT state,result FROM effects WHERE learner_id=$1 AND owner_id='legacy-session'", [studioLearner])).rows)
      .toEqual([{state:'started',result:null}]);
    const ids = [prior.id,intakeIdFor(factId(prior.id))];
    expect((await db.query('SELECT data FROM fact_revs WHERE learner_id=$1 AND fact_id=ANY($2)',[studioLearner,ids])).rows).toEqual([]);
    expect((await db.query('SELECT result FROM effects WHERE learner_id=$1 AND owner_id=ANY($2)',[studioLearner,ids])).rows).toEqual([]);
    expect((await db.query("SELECT input FROM commands WHERE learner_id=$1 AND input #>> '{input,materialId}'=$2",[studioLearner,prior.id])).rows).toEqual([]);
  });
  it.each(['finish','erase'])('resumes the same batch after an unrelated erasure (%s)', async outcome => {
    const {watermark} = await (await fetch(origin + '/api/lifecycle')).json() as {watermark:string};
    const a = await (await capture('other-' + outcome,null,'text/plain',watermark)).json() as IntakeMetadata;
    const b = await (await capture('poll-' + outcome,'mineru','application/pdf',watermark)).json() as IntakeMetadata;
    const erase = async (file: IntakeMetadata) => {
      const res = await fetch(origin + '/api/materials/' + file.id + '/erasure', {method:'POST',
        headers:{'content-type':'application/json'}, body:JSON.stringify({requestId:'erase-' + file.id,
          expectedRev:file.revision,confirmation:'permanently-delete-original'})});
      expect(await res.json()).toMatchObject({original:'removed'});
    };
    const owner = intakeIdFor(factId(b.id));
    const {rows:[work]} = await db.query<{execution_ref:string}>('SELECT execution_ref FROM work WHERE learner_id=$1 AND slot_key=$2',[studioLearner,owner]);
    const ref = await acknowledgeStartedWork(db,work!.execution_ref);
    const batch = 'isolated-batch-' + outcome;
    const submit = vi.fn<MineruClient['submit']>(async () => batch);
    const read = vi.fn<MineruClient['read']>().mockRejectedValueOnce(new Error('disconnected')).mockImplementationOnce(async () => {
      if (outcome === 'erase') await erase(b);
      return {state:'done',text:'synthetic OCR ' + outcome,pages:1};
    });
    const retry = () => openCloudIntakeWork(db,intake,{submit,read}).execute(ref!);
    await expect(retry()).rejects.toThrow('disconnected');
    const {rows:[saved]} = await db.query<{provider_effect_id:string;result:string}>('SELECT provider_effect_id,result FROM effects WHERE owner_id=$1',[owner]);
    expect(saved?.result).toBe(batch);
    await erase(a);
    await retry();
    expect(read.mock.calls.map(([input]) => input.batchId)).toEqual([batch,batch]);
    expect(submit).toHaveBeenCalledTimes(1);
    if (outcome === 'finish') expect((await intake.metadata(b.id)).fullText).toBe('synthetic OCR finish');
    else {
      expect((await fetch(origin + '/api/materials/' + b.id + '/original')).status).toBe(404);
      expect((await db.query('SELECT result FROM effects WHERE owner_id=$1',[owner])).rows).toEqual([]);
      expect((await db.query('SELECT provider_effect_id,settlement FROM erased_effect_receipts WHERE owner_id=$1',[owner])).rows)
        .toEqual([{provider_effect_id:saved!.provider_effect_id,settlement:'done'}]);
      await retry();
      expect(read).toHaveBeenCalledTimes(2);
      expect(submit).toHaveBeenCalledTimes(1);
    }
  });
  it('keeps a legacy batch receipt without adopting new evidence after an erasure', async () => {
    const {watermark} = await (await fetch(origin + '/api/lifecycle')).json() as {watermark:string};
    const other = await (await capture('old-batch-other',null,'text/plain',watermark)).json() as IntakeMetadata;
    const b = await (await capture('old-batch-document','mineru','application/pdf',watermark)).json() as IntakeMetadata;
    const owner = intakeIdFor(factId(b.id));
    const {rows:[work]} = await db.query<{execution_ref:string}>('SELECT execution_ref FROM work WHERE learner_id=$1 AND slot_key=$2',[studioLearner,owner]);
    const ref = (await acknowledgeStartedWork(db,work!.execution_ref))!;
    await runEffect(db,{learner:studioLearner,ownerKind:'session',ownerId:owner,stepKey:ref.generation,label:'intake-mineru',
      input:{mediaType:b.original.mediaType,sha256:b.original.sha256,revision:b.revision}},async () => 'original-legacy-batch');
    const submit = vi.fn<MineruClient['submit']>(), read = vi.fn<MineruClient['read']>().mockRejectedValue(new Error('disconnect'));
    const retry = () => openCloudIntakeWork(db,intake,{submit,read}).execute(ref);
    await expect(retry()).rejects.toThrow('disconnect');
    expect(read.mock.calls[0]?.[0].batchId).toBe('original-legacy-batch');
    const removed = await fetch(origin + '/api/materials/' + other.id + '/erasure',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({requestId:'erase-old-batch-other',expectedRev:other.revision,confirmation:'permanently-delete-original'})});
    expect(await removed.json()).toMatchObject({original:'removed'});
    await retry();
    expect(read).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect((await intake.metadata(b.id)).extraction.error).toContain('已停止轮询和重传');
    expect((await db.query('SELECT input_basis,result FROM effects WHERE owner_id=$1',[owner])).rows)
      .toEqual([{input_basis:null,result:'original-legacy-batch'}]);
  });
});
