import { expect, it } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { studioLearner } from '../identity.ts';
import { openStudioNotion } from '../notion.ts';
import { loadStudioTestModule } from './modules.ts';

it.skipIf(!testDatabaseUrl)('binds the Notion settings receipt to the command and current generation', () =>
  withLearnerDatabase(studioLearner, async db => {
    const host = openStudioNotion(db, await loadStudioTestModule('capture'));
    const target = {requestId:'settings-first', deletionWatermark:'0', selectionId:'course', expectedEpoch:'0'};
    const grant = {...target, root:{kind:'page', id:'00000000000000000000000000000001'}, preset:'storage', recipients:[]};
    const first = await host.mutate('grant', grant);
    expect(await host.mutate('grant', grant)).toEqual(first);
    await expect(host.mutate('grant', {...grant, preset:'learning'})).rejects.toMatchObject({status:409});
    await expect(host.mutate('grant', {...grant, preset:'temporary'})).rejects.toMatchObject({status:422});
    const revoke = {...target, requestId:'settings-revoke', expectedEpoch:'1'};
    expect(await host.mutate('revoke', revoke)).toMatchObject({active:false, epoch:'2'});
    await expect(host.mutate('grant', grant)).rejects.toMatchObject({status:409});
    expect((await host.settings()).selections).toMatchObject([{active:false, sources:[]}]);
  }));
