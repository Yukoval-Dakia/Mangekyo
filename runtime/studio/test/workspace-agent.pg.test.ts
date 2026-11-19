import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {expect,it} from 'vitest';
import {createPgDb} from '../../../kernel/src/db/pg.ts';
import {learnerId} from '../../../kernel/src/declarations/ids.ts';
import {kernelSchemaStatements} from '../../../kernel/src/schema.ts';
import {loadModuleDirectory} from '../../../kernel/src/loader.ts';
import {studioLearner,stableId} from '../identity.ts';
import {resolveSource} from '../source-read.ts';
import {openWorkbook} from '../workbook.ts';
import {openWorkspaceAccess} from '../workspace-access.ts'; import {openWorkspaceTools} from '../workspace-agent.ts';
import {openLibrary} from '../library.ts'; import {openOrganizer} from '../organizer.ts';
import {learningOverviewPurpose, readLearningOverview} from '../learning-overview.ts';
import type {LearningOverviewFact} from '../../../modules/activity/workspace-values.ts';

const connectionString = process.env.MANGEKYO_TEST_DATABASE_URL;
it.skipIf(!connectionString)('preserves source links and resolves workspace anchors under revision and purpose changes', async () => {
  const schema = 'workspace_test_'+randomBytes(6).toString('hex');
  const admin = createPgDb(new pg.Pool({connectionString}));
  await admin.query('CREATE SCHEMA '+schema);
  const db = createPgDb(new pg.Pool({connectionString}),{schema});
  const body = '画出已知两段🧭：计时，再计时';
  function turn(name:string) {
    const host = openWorkspaceTools({db, turn:stableId(name), prior:[], authorize:async () => {}, track() {}, maySend:() => true});
    return async (tool:string, args:Record<string,unknown>, step:number) => JSON.parse(await host.execute(tool,args,step));
  }
  async function author() {
    const run = turn('author');
    const search = await run('search_workspace',{query:'分段计时'},1);
    const source = await run('save_workspace',{kind:'concept',title:'时间线',body:'标出两段边界'},2);
    const page = await run('save_workspace',{kind:'page',title:'分段计时',body,tags:['方法'],links:[source.id]},3);
    return {search,source,page};
  }
  try {
    for (const sql of kernelSchemaStatements) await db.query(sql);
    await db.query('INSERT INTO learners (id) VALUES ($1)',[studioLearner]);
    const first = await author();
    expect(first.search.results).toEqual([]);
    expect(first.page.state).toBe('done');
    expect(await author()).toEqual(first);
    const edit = turn('editor');
    const original = await edit('read_workspace',{id:first.page.id},1);
    expect(original.links).toEqual([first.source.id]);
    expect(original.sourceRef).toEqual({v:1, fact:{id:first.page.id, rev:1, type:'activity.workspaceEntry'}, anchor:{kind:'whole'}});
    const start = body.lastIndexOf('计时');
    const ref = {...original.sourceRef, anchor:{kind:'text', field:'body', start, end:body.length}};
    const chosen = {id:JSON.stringify(ref)};
    expect(await edit('read_workspace',chosen,2)).toMatchObject({sourceRef:ref, content:'计时'});
    const updated = await edit('save_workspace',{id:first.page.id,title:'两段计时',body:body.slice(0,start)+'读表'},3);
    expect(updated).toMatchObject({id:first.page.id,rev:2,state:'done'});
    const saved = await edit('read_workspace',{id:first.page.id},4);
    expect(saved).toMatchObject({links:[first.source.id],tags:['方法'],title:'两段计时'});
    expect(saved.content).toContain('画出已知两段');
    expect(await edit('read_workspace',chosen,2)).toMatchObject({rev:1, content:'计时'});
    await db.snapshot({learner:studioLearner}, async tx => {
      const followed = await resolveSource(tx,ref,{recipient:'learner'},'following');
      expect(followed).toMatchObject({sourceRef:{fact:{rev:2}}, content:'读表'});
      expect(await resolveSource(tx,followed?.sourceRef,{recipient:'learner'})).toEqual(followed);
    });
    await db.snapshot({learner:learnerId(stableId('other learner'))}, async tx =>
      expect(await resolveSource(tx,ref,{recipient:'learner'})).toBeUndefined());
    const privateHost = openWorkspaceTools({db,turn:stableId('another provider'),prior:[],authorize:async () => {},track() {},
      maySend:fact => fact.ref.id !== first.source.id});
    const hidden = JSON.parse(await privateHost.execute('read_workspace',{id:first.page.id},1));
    expect(hidden.error).toBeTruthy();
    expect(hidden.content).toBeUndefined();

    const activity = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/activity',import.meta.url)));
    const access = openWorkspaceAccess(db, activity); expect(access.categories).toEqual(expect.arrayContaining([{id: 'goal', label: '目标'}, {id: 'task', label: '任务'}]));
    const overview = (callerPurpose = learningOverviewPurpose, maySend: (fact: LearningOverviewFact) => boolean = () => true) =>
      db.snapshot({learner: studioLearner}, tx => readLearningOverview(tx, {callerPurpose, maySend}));
    const library = openLibrary(db, activity), organizer = openOrganizer(db, activity);
    expect((await overview()).goal).toMatchObject({state: 'empty'});
    await library.setGoal({requestId: 'overview-old', text: '旧目标'}); await library.setGoal({requestId: 'overview-current', text: '保持每日法语输入'});
    const task = await organizer.task({requestId: 'overview-task', title: '复习动词', date: '2026-11-19'});
    await access.setTeaching(stableId('study-goal', 'overview-old'), {enabled: true, expectedRev: 1});
    const goal = await access.setTeaching(stableId('study-goal', 'overview-current'), {enabled: true, expectedRev: 1}); const openedTask = await access.setTeaching(task.id, {enabled: true, expectedRev: task.rev}); expect((await overview('research')).witnesses).toEqual([]);
    const current = await overview();
    expect(current).toMatchObject({goal: {state: 'set', text: '保持每日法语输入', witness: {id: goal.id, rev: goal.rev, accessEpoch: '1'}},
      tasks: {state: 'available', items: [{id: task.id, rev: openedTask.rev, title: '复习动词', date: '2026-11-19', done: false}]}, witnesses: [{id: goal.id}, {id: task.id}]});
    expect(await overview(learningOverviewPurpose, fact => fact.id !== task.id)).toMatchObject({tasks: {state: 'empty'}, witnesses: current.witnesses.slice(0, 1)});
    await access.setTeaching(task.id, {enabled: false, expectedRev: openedTask.rev}); await access.setTeaching(goal.id, {enabled: false, expectedRev: goal.rev});
    expect((await overview()).witnesses).toEqual([]);
    const revoked = await access.setTeaching(first.page.id,{enabled:false,expectedRev:updated.rev});
    await access.setTeaching(first.page.id,{enabled:true,expectedRev:revoked.rev});
    expect(await edit('read_workspace',chosen,2)).toEqual({error:expect.any(String)});
    expect(await edit('read_workspace',chosen,5)).toMatchObject({rev:1,content:'计时'});

    const workbook = openWorkbook(db, activity);
    const paper = await workbook.save({requestId:'source-paper',title:'海风',questions:[
      {kind:'exact',prompt:'记录一次风向。',answers:['参考答案独有字样']},
    ]});
    const question = paper.questions[0]!;
    const submitted = await workbook.submit(paper.id,{requestId:'source-attempt',answers:{[question.id]:'实测东北风'}});
    const attempt = submitted.attempts[0]!;
    await access.setTeaching(attempt.id,{enabled:true,expectedRev:1});
    const opened = await edit('read_workspace',{id:attempt.id},6);
    const answer = {...opened.sourceRef, anchor:{kind:'answer-slot',itemId:question.id,slotId:'answer'}};
    const result = await edit('read_workspace',{id:JSON.stringify(answer)},7);
    expect(result).toMatchObject({sourceRef:answer,content:'实测东北风'});
    expect(JSON.stringify(result)).not.toContain('参考答案独有字样');
  } finally {
    await db.close(); await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.close();
  }
});
