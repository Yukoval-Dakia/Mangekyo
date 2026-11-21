import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { generateResearchDraft } from '../../../executors/teaching/research-worker.ts';
import { commandId, factId } from '../../../kernel/src/declarations/ids.ts';
import { effectBudgetUsage, EffectBudgetExceeded } from '../../../kernel/src/work/effects.ts';
import { newUlid } from '../../../kernel/src/work/identity.ts';
import { eraseOriginal } from '../../../kernel/src/lifecycle.ts';
import { failWork } from '../../../kernel/src/work/index.ts';
import { bindWorkPayload } from '../../../kernel/src/work/payload.ts';
import { emitTodo } from '../../../kernel/src/work/todos.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { workerCall } from '../../research/worker-dispatch.ts';
import { studioLearner as learner } from '../identity.ts';

it.skipIf(!testDatabaseUrl).each(['concurrency', 'recovery', 'erasure', 'failure'])('handles question author budget through %s', scenario =>
  withLearnerDatabase(learner, async db => {
    const directory = await mkdtemp(join(tmpdir(), 'question-author-budget-'));
    const prior = process.env.MANGEKYO_SETTINGS_FILE;
    const file = join(directory, 'provider.json');
    process.env.MANGEKYO_SETTINGS_FILE = file;
    const firstSent = Promise.withResolvers<void>(), secondSent = Promise.withResolvers<void>();
    const releaseAuthors = Promise.withResolvers<void>();
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { messages } = JSON.parse(Buffer.concat(chunks).toString());
      const author = messages[0].content.startsWith('设计');
      requests.push(author ? messages[1].content : 'solve');
      if (author) {
        (messages[1].content === 'a' ? firstSent : secondSent).resolve();
        await releaseAuthors.promise;
      }
      const output = author ? {title:'Test', question:'2+2?', answer:4} : {answer:4, reason:'Two pairs make four.'};
      res.writeHead(200, {'content-type':'application/json',
        ...(scenario !== 'recovery' || author ? {'x-actual-usd-micros':'10'} : {})});
      res.end(JSON.stringify({model:'test-author', choices:[{finish_reason:'stop',
        message:{role:'assistant', content:JSON.stringify(output)}}]}));
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No local gateway address');
      const baseUrl = 'http://127.0.0.1:' + address.port + '/v1';
      await writeFile(file, JSON.stringify({providers:[{id:'test', baseUrl, model:'test-author',
        credentialRevision:'test'}], activeProviderId:'test'}));
      const tariff = {route:'test', endpoint:baseUrl + '/chat/completions', model:'test-author',
        reserveUsdMicros:10, retentionDays:0, protocol:'openai'} as const;
      const now = Date.now();
      const grant = {profile:'question_author', model:tariff.model, route:tariff.route, providerId:'test',
        accountRevision:'test', limitMicros:40, maxPerCallMicros:10, maxRetentionDays:0, expiresAtMs:now+60_000} as const;
      const prepare = async (key: string) => {
        const source = factId(newUlid());
        const todo = await db.tx({learner}, tx => tx.withLearnerWrite(tick => emitTodo(tx,tick,{
          dedupKey:key, trigger:{kind:'immediate'}, workerProfile:grant.profile, goal:key,
          sourceFactRev:{id:source, revision:1, accessEpoch:'0'}, refs:[],
          autonomyTier:1, budgetCap:30, settingsRevision:1, expiresAtMs:grant.expiresAtMs,
        }, now, async () => true)));
        const work = {learner, workId:todo!.id, generation:'1'};
        expect(await db.tx({learner}, tx => bindWorkPayload(tx,work,[source],
          {factId:factId(newUlid()), commandId:commandId(newUlid())}))).toBe(true);
        return {source, work, run: () => generateResearchDraft(grant.profile, key,
          workerCall(db,todo!.id,source,grant,tariff,async () => {},new AbortController().signal,work).call)};
      };
      const a = await prepare('a');
      const usage = () => db.snapshot({learner}, effectBudgetUsage);
      if (scenario === 'recovery') {
        await db.query(`CREATE FUNCTION stop_author_publication() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'publication interrupted'; END $$`);
        await db.query(`CREATE TRIGGER stop_author_publication BEFORE UPDATE OF state ON effects
          FOR EACH ROW WHEN (OLD.step_key LIKE '%:author') EXECUTE FUNCTION stop_author_publication()`);
      }
      if (scenario === 'erasure') {
        await db.tx({learner}, tx => tx.withLearnerWrite(tick => tx.insert('facts', {
          learner_id:learner, id:a.source, type:'test.original', current_rev:1, created_tick:tick, changed_tick:tick,
        })));
      }
      const first = a.run();
      void first.catch(firstSent.reject);
      await firstSent.promise;
      const atFirstSend = await usage();
      if (scenario === 'recovery') {
        releaseAuthors.resolve();
        await expect(first).rejects.toThrow('publication interrupted');
        expect(await usage()).toEqual({held:20n, settled:10n});
        await db.query('DROP TRIGGER stop_author_publication ON effects');
        await expect(a.run()).resolves.toMatchObject({title:'Test'});
        expect(requests).toEqual(['a','solve','solve']);
        expect(await usage()).toEqual({held:20n, settled:10n});
        return;
      }
      if (scenario === 'erasure' || scenario === 'failure') {
        if (scenario === 'erasure') await eraseOriginal(db,{learner},{actor:'learner',confirmed:true,requestId:commandId(newUlid()),
          root:a.source,expectedRev:1},async () => ({ids:[a.source],commandTypes:[]}),async () => {});
        else expect(await failWork(db,a.work)).toBe(true);
        expect(await usage()).toEqual({held:10n, settled:0n});
        releaseAuthors.resolve();
        await expect(first).rejects.toThrow('no recoverable output');
        if (scenario === 'erasure') await expect(a.run()).rejects.toMatchObject({status:410});
        else await expect(a.run()).rejects.toThrow('Work payload is no longer active');
        expect(requests).toEqual(['a']);
        expect(await usage()).toEqual({held:0n, settled:10n});
        return;
      }
      const b = await prepare('b');
      const second = b.run();
      const concurrent = await Promise.race([secondSent.promise.then(() => 'sent'), second.then(() => 'done', () => 'denied')]);
      releaseAuthors.resolve();
      const results = await Promise.allSettled([first, second]);
      const after = await usage();
      expect({atFirstSend, concurrent, requests, outcomes:results.map(result => result.status), after}).toEqual({
        atFirstSend:{held:30n, settled:0n}, concurrent:'denied', requests:['a','solve','solve'],
        outcomes:['fulfilled','rejected'], after:{held:0n, settled:30n},
      });
      await expect(second).rejects.toBeInstanceOf(EffectBudgetExceeded);
    } finally {
      releaseAuthors.resolve();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (prior === undefined) delete process.env.MANGEKYO_SETTINGS_FILE;
      else process.env.MANGEKYO_SETTINGS_FILE = prior;
      await rm(directory,{recursive:true, force:true});
    }
  }));
