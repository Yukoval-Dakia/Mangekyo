import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {expect,it} from 'vitest';
import {createPgDb} from '../../../kernel/src/db/pg.ts';
import {kernelSchemaStatements} from '../../../kernel/src/schema.ts';
import {studioLearner,stableId} from '../identity.ts';
import {openWorkspaceTools} from '../workspace-agent.ts';

const connectionString = process.env.MANGEKYO_TEST_DATABASE_URL;
it.skipIf(!connectionString)('replays a workspace search and preserves linked sources when a later turn patches a page', async () => {
  const schema = 'workspace_test_'+randomBytes(6).toString('hex');
  const admin = createPgDb(new pg.Pool({connectionString}));
  await admin.query('CREATE SCHEMA '+schema);
  const db = createPgDb(new pg.Pool({connectionString}),{schema});
  function turn(name:string) {
    const host = openWorkspaceTools({db, turn:stableId(name), prior:[], authorize:async () => {}, track() {}, maySend:() => true});
    return async (tool:string, args:Record<string,unknown>, step:number) => JSON.parse(await host.execute(tool,args,step));
  }
  async function author() {
    const run = turn('author');
    const search = await run('search_workspace',{query:'分段计时'},1);
    const source = await run('save_workspace',{kind:'concept',title:'时间线',body:'标出两段边界'},2);
    const page = await run('save_workspace',{kind:'page',title:'分段计时',body:'画出已知两段',tags:['方法'],links:[source.id]},3);
    return {search,source,page};
  }
  try {
    for (const sql of kernelSchemaStatements) await db.query(sql);
    await db.query('INSERT INTO learners (id) VALUES ($1)',[studioLearner]);
    const trySave = turn('invalid input');
    const note = {kind:'note',title:'方法笔记',body:'先画时间线。'};
    expect((await trySave('save_workspace',note,1)).error).toContain('kind="page"');
    const page = {...note,kind:'page'};
    expect((await trySave('save_workspace',{...page,links:['时间线']},2)).error).toContain('links[0]');
    expect((await trySave('save_workspace',{...page,content:'正文'},3)).error).toMatch(/content.*body/);
    expect((await trySave('save_workspace',page,4)).state).toBe('done');
    const first = await author();
    expect(first.search.results).toEqual([]);
    expect(first.page.state).toBe('done');
    expect(await author()).toEqual(first);
    const edit = turn('editor');
    const original = await edit('read_workspace',{id:first.page.id},1);
    expect(original.links).toEqual([first.source.id]);
    const updated = await edit('save_workspace',{id:first.page.id,title:'两段计时'},2);
    expect(updated).toMatchObject({id:first.page.id,rev:2,state:'done'});
    const saved = await edit('read_workspace',{id:first.page.id},3);
    expect(saved).toMatchObject({links:[first.source.id],tags:['方法'],title:'两段计时'});
    expect(saved.content).toContain('画出已知两段');
    const privateHost = openWorkspaceTools({db,turn:stableId('another provider'),prior:[],authorize:async () => {},track() {},
      maySend:fact => fact.ref.id !== first.source.id});
    const hidden = JSON.parse(await privateHost.execute('read_workspace',{id:first.page.id},1));
    expect(hidden.error).toBeTruthy();
    expect(hidden.content).toBeUndefined();
  } finally {
    await db.close();
    await admin.query('DROP SCHEMA '+schema+' CASCADE');
    await admin.close();
  }
});
