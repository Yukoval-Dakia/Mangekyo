import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {expect,it} from 'vitest';
import {createPgDb} from '../../../kernel/src/db/pg.ts';
import {commandId, learnerId} from '../../../kernel/src/declarations/ids.ts';
import {createCommandHandler} from '../../../kernel/src/commands/handle.ts';
import {kernelSchemaStatements} from '../../../kernel/src/schema.ts';
import {recordLocalRead} from '../../../kernel/src/work/effects.ts';
import {loadModuleDirectory} from '../../../kernel/src/loader.ts';
import {studioLearner,stableId} from '../identity.ts';
import {resolveSource} from '../source-read.ts';
import {openWorkbook} from '../workbook.ts';
import {openWorkspaceAccess} from '../workspace-access.ts'; import {openWorkspaceTools, type WorkspaceWitness} from '../workspace-agent.ts';
import {openLibrary} from '../library.ts'; import {openOrganizer} from '../organizer.ts';
import {learningOverviewPurpose, readLearningOverview} from '../learning-overview.ts';
import type {LearningOverviewFact} from '../../../modules/activity/workspace-values.ts';
import {workspaceQuery} from '../workspace-read.ts';
import {openTextbook} from '../textbook.ts';
import {readCurrentLearningObject} from '../current-learning-object.ts';

const connectionString = process.env.MANGEKYO_TEST_DATABASE_URL;
it.skipIf(!connectionString)('reopens authorized workspace versions and searches directed knowledge links in PostgreSQL', async () => {
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
    const source = await run('save_workspace',{kind:'concept',title:'时间线',body:'标出两段边界'},2);
    const page = await run('save_workspace',{kind:'page',title:'分段计时',body,tags:['方法'],links:[source.id]},3);
    return {source,page};
  }
  try {
    for (const sql of kernelSchemaStatements) await db.query(sql);
    await db.query('INSERT INTO learners (id) VALUES ($1)',[studioLearner]);
    const first = await author();
    expect(await author()).toEqual(first);
    const edit = turn('editor');
    const original = await edit('read_workspace',{id:first.page.id},1);
    expect(original.sourceRef).toEqual({v:1, fact:{id:first.page.id, rev:1, type:'activity.workspaceEntry'}, anchor:{kind:'whole'}});
    const start = body.lastIndexOf('计时');
    const ref = {...original.sourceRef, anchor:{kind:'text', field:'body', start, end:body.length}};
    const chosen = {id:JSON.stringify(ref)};
    expect(await edit('read_workspace',chosen,2)).toMatchObject({sourceRef:ref, content:'计时'});
    const updated = await edit('save_workspace',{id:first.page.id,title:'两段计时',body:body.slice(0,start)+'读表'},3);
    expect(updated).toMatchObject({id:first.page.id,rev:2,state:'done'});
    const saved = await edit('read_workspace',{id:first.page.id},4);
    expect(saved).toMatchObject({links:[first.source.id],tags:['方法'],title:'两段计时'});
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
    const content = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/content', import.meta.url)));
    const access = openWorkspaceAccess(db, activity, content); expect(access.categories).toEqual(expect.arrayContaining([{id: 'goal', label: '目标'}, {id: 'task', label: '任务'}]));
    const textbook = openTextbook(db, content, {async onFactsChanged() {}});
    const teachingPage = await textbook.create({learner:studioLearner, requestId:'textbook-teaching', clientEditSeq:0,
      page:{title:'我的教材', blocks:[{id:'intro', parentId:null, body:{kind:'text',text:'比对分段计时'}}]}});
    expect(await access.list(new URLSearchParams({category:'textbook'}))).toMatchObject({items:[{
      id:teachingPage.id, title:'我的教材', teaching:false, purposes:['storage'], excerpt:'比对分段计时',
    }]});
    const pageInput = {learner:studioLearner, id:teachingPage.id, purpose:'teaching'};
    await expect(textbook.get(pageInput)).rejects.toMatchObject({status:403});
    expect(await access.setTeaching(teachingPage.id,{enabled:true,expectedRev:1})).toMatchObject({rev:2,teaching:true});
    expect(await textbook.get(pageInput)).toMatchObject({rev:2,accessEpoch:'1'});
    await expect(textbook.get({...pageInput,rev:1})).rejects.toMatchObject({status:403});
    await access.setTeaching(teachingPage.id,{enabled:false,expectedRev:2});
    await expect(textbook.get({...pageInput,rev:2})).rejects.toMatchObject({status:403});
    expect(await textbook.get({...pageInput,purpose:'storage'})).toMatchObject({rev:3,accessEpoch:'2',title:'我的教材'});
    const overview = (callerPurpose = learningOverviewPurpose, maySend: (fact: LearningOverviewFact) => boolean = () => true) =>
      db.snapshot({learner: studioLearner}, tx => readLearningOverview(tx, {callerPurpose, maySend}));
    const library = openLibrary(db, activity), organizer = openOrganizer(db, activity);
    const noteSource = await library.capture({requestId:'private-note-source', title:'仅本人可见的来源', text:'来源正文'});
    const note = await organizer.note({requestId:'linked-note', materialId:noteSource.id, title:'关联笔记', markdown:'本人记录'});
    const noteGrant = await access.setTeaching(note.id,{enabled:true,expectedRev:1});
    const bind = (kind: 'page' | 'attempt', id: string, rev: number) => db.snapshot({learner:studioLearner},
      tx => readCurrentLearningObject(tx,{kind,id,rev},() => true));
    const boundNote = await bind('page',note.id,noteGrant.rev);
    expect(boundNote?.view).toMatchObject({title:'关联笔记',content:'本人记录'});
    const oldNote = await db.snapshot({learner:studioLearner},tx => resolveSource(tx,note.id,{recipient:'learner'}));
    expect(oldNote?.content).toContain(noteSource.id);
    const noteArgs = {id:note.id};
    await recordLocalRead(db,{learner:studioLearner,ownerKind:'session',ownerId:stableId('old note receipt'),
      stepKey:'1',label:'local:read_workspace',input:noteArgs},async () =>
      JSON.stringify({text:JSON.stringify(oldNote),witnesses:[boundNote!.root],workbookProjection:1}),async () => {});
    await expect(turn('old note receipt')('read_workspace',noteArgs,1)).rejects.toMatchObject({code:'evidence_scope'});
    expect(await turn('new note read')('read_workspace',noteArgs,1)).toMatchObject({content:'本人记录'});
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

    const materialId = stableId('paired material'), intakeId = stableId('intake-document', materialId);
    const capturedText = '长材料正文。'.repeat(1000);
    const command = createCommandHandler(db, {modules:[activity], hooks:{async onFactsChanged() {}}});
    await command({learner:studioLearner, actor:'learner', purpose:'storage', type:'activity.captureIntake',
      id:commandId(stableId('paired capture')), input:{materialId, intakeId, title:'长材料',
        original:{name:'study.txt', mediaType:'text/plain', size:1, sha256:'0'.repeat(64)},
        extraction:{status:'ok', method:'utf8', text:capturedText, error:null, warnings:[], pages:null,
          truncated:false, characterCount:capturedText.length}}});
    // Legacy workspaces granted the material and left the paired text storage-only.
    await command({learner:studioLearner, actor:'learner', purpose:'storage', type:'activity.setWorkspaceTeaching',
      id:commandId(stableId('legacy material grant')), input:{id:materialId, expectedRev:1, enabled:true}});
    expect(await access.setTeaching(materialId,{enabled:true,expectedRev:2})).toMatchObject({rev:2, changed:true});
    const scoped = (blockedId?: string) => db.snapshot({learner:studioLearner}, tx => resolveSource(tx, materialId,
      {recipient:'workspace', maySend:fact => fact.ref.id !== blockedId}));
    const captured = await scoped();
    expect(captured).toMatchObject({content:capturedText, sourceRef:{textFact:{id:intakeId,rev:2}}});
    expect(await scoped(intakeId)).toBeUndefined();
    await command({learner:studioLearner, actor:'learner', purpose:'storage', type:'activity.correctIntakeText',
      id:commandId(stableId('paired correction')), input:{materialId,intakeId,expectedRev:2,text:'更正后的正文。'}});
    expect(await scoped()).toMatchObject({content:'更正后的正文。',sourceRef:{textFact:{rev:3}}});
    const seen: WorkspaceWitness[] = [];
    const pinnedHost = openWorkspaceTools({db,turn:stableId('pinned material reread'),prior:[],authorize:async () => {},
      track: item => seen.push(item), maySend:() => true});
    const pinned = JSON.parse(await pinnedHost.execute('read_workspace',{id:JSON.stringify(captured?.sourceRef)},1));
    expect(pinned).toMatchObject({content:capturedText.slice(0,4000),sourceRef:captured?.sourceRef});
    expect(seen).toEqual(expect.arrayContaining([expect.objectContaining({id:intakeId,rev:2,mode:'pinned'})]));
    await db.query('UPDATE facts SET purpose=$3 WHERE learner_id=$1 AND id=$2', [studioLearner,intakeId,['teaching']]);
    await expect(library.reading(materialId)).rejects.toMatchObject({status:404});
    await db.query(`UPDATE fact_revs SET data=jsonb_set(data,'{materialId}',to_jsonb($3::text))
      WHERE learner_id=$1 AND fact_id=$2 AND rev=3`,[studioLearner,intakeId,stableId('different material')]);
    expect(await scoped()).toBeUndefined();
    await expect(access.setTeaching(materialId,{enabled:false,expectedRev:3})).rejects.toMatchObject({status:409});

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
    const observe = turn('narrow observation');
    const evidence = {title:'风向观察',text:'这次按方位描述了风向。',evidence_refs:[JSON.stringify(answer)]};
    expect(await observe('record_observation',evidence,1)).toMatchObject({ok:false,code:'evidence_not_opened',next:{tool:'open_learning'}});
    await observe('open_learning',{refs:JSON.stringify(answer)},2);
    const written = await observe('record_observation',evidence,3);
    expect(written).toMatchObject({ok:true,kind:'inferred',ref:{rev:1},undo_token:expect.any(String)});
    const withdrawn = await access.undoObservation(written.ref.id,{undo_token:written.undo_token});
    expect(withdrawn).toMatchObject({status:'withdrawn',ref:{id:written.ref.id,rev:2}});
    expect(await access.undoObservation(written.ref.id,{undo_token:written.undo_token})).toEqual(withdrawn);
    const legacyObservation = await observe('record_observation',{...evidence,text:question.prompt},4);
    expect(legacyObservation).toMatchObject({ok:true});

    const diagnose = turn('diagnose frozen submission');
    const diagnosis = {refs:attempt.id,lens:'diagnose'};
    expect(await diagnose('open_learning',diagnosis,1)).toMatchObject({ok:false,code:'not_found'});
    const paperGrant = await access.setTeaching(paper.id,{enabled:true,expectedRev:1});
    expect(await diagnose('read_workspace',{id:legacyObservation.ref.id},7)).toMatchObject({content:expect.stringContaining(question.prompt)});
    expect(await diagnose('open_learning',{...diagnosis,refs:paper.id},2)).toMatchObject({ok:false,code:'not_found'});
    const openedDiagnosis = await diagnose('open_learning',diagnosis,3);
    expect(openedDiagnosis).toMatchObject({ok:true,items:[{
      frozenPaper:{id:paper.id,rev:1},
      questions:[{prompt:question.prompt,answer:'实测东北风',assessment:{verdict:'incorrect'},
        independence:'unknown',help_exposure:{state:'unknown'}}],
      image_crop:{state:'unavailable'},effective_duration_ms:{state:'unavailable'},
    }]});
    expect(JSON.stringify(openedDiagnosis)).not.toContain('参考答案独有字样');
    const reopenedPaper = await diagnose('read_workspace',{id:paper.id},4);
    expect(reopenedPaper.content).toContain(question.prompt);
    expect(JSON.stringify(await diagnose('read_workspace',{id:JSON.stringify(reopenedPaper.sourceRef)},5)))
      .not.toContain('参考答案独有字样');
    expect(JSON.stringify(opened)).not.toContain('参考答案独有字样');
    const currentAttempt = await bind('attempt',attempt.id,opened.rev);
    expect(currentAttempt?.openedAnswer).toBe(true);
    const bound = openWorkspaceTools({db,turn:stableId('bound observation'),prior:[],authorize:async () => {},
      track() {},maySend:() => true,currentObject:currentAttempt});
    const observation = JSON.parse(await bound.execute('record_observation',evidence,1));
    expect(observation).toMatchObject({ok:true});
    await access.setTeaching(paper.id,{enabled:false,expectedRev:paperGrant.rev});
    expect(await diagnose('open_learning',diagnosis,3)).toMatchObject({ok:false,code:'basis_stale'});
    expect(await diagnose('read_workspace',{id:observation.ref.id},6)).toEqual({error:expect.any(String)});
    expect(await diagnose('read_workspace',{id:legacyObservation.ref.id},7)).toEqual({error:expect.any(String)});
    expect(await diagnose('read_workspace',{id:legacyObservation.ref.id},8)).toEqual({error:expect.any(String)});
    const legacyOwnerRead = await db.snapshot({learner:studioLearner},tx =>
      resolveSource(tx,legacyObservation.ref.id,{recipient:'learner'}));
    expect(legacyOwnerRead?.content).toContain(question.prompt);

    const privatePaper = await workbook.save({requestId:'search-preview',title:'检索速度卷',questions:[
      {kind:'exact',prompt:'写出速度单位。',answers:['内部答案标记']},
      {kind:'rubric',prompt:'解释全程速度。',rubric:'内部评分规则标记'},
    ]});
    await access.setTeaching(privatePaper.id,{enabled:true,expectedRev:1});
    const preview = await edit('search_workspace',{query:'检索速度卷',kind:'paper'},8);
    expect(preview).toMatchObject({results:[{id:privatePaper.id,excerpt:expect.stringContaining('写出速度单位。')}]});
    expect(JSON.stringify(preview)).not.toMatch(/内部答案标记|内部评分规则标记/u);
    const paperRef = new URLSearchParams({ref:JSON.stringify(preview.results[0].sourceRef)});
    expect(JSON.stringify(await access.record(privatePaper.id,paperRef))).toContain('内部评分规则标记');
    paperRef.set('view','preview');
    expect(await access.record(privatePaper.id,paperRef)).toMatchObject({content:'写出速度单位。\n\n解释全程速度。'});

    await admin.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA ${schema}`);
    const graph = turn('graph');
    const concept = await graph('save_workspace', {kind:'concept', title:'平均速度 Kinematics', body:'用总路程和总时间。'}, 1);
    const originalQuestion = await graph('save_workspace', {kind:'question', title:'骑行题', tags:['运动'], body:'骑行全程的平均速度是多少？', answer:'答案检索隔离词'}, 2);
    const variant = await graph('save_workspace', {kind:'question', title:'往返变式', tags:['运动'], body:'请计算这两段路程的往返平均速度并说明分母。', answer:'12 千米每小时'}, 3);
    const compound = await graph('save_workspace', {kind:'concept',title:'分段运动',body:'先掌握平均速度。'},15);
    const use = (id: string) => ({id, rev:1, accessEpoch:'0'});
    const claim = (kind: string, from: {id:string}, to: {id:string}, targetKind = 'question') => ({
      kind, scope:'运动学', from:{kind:kind === 'prereq_of' ? 'concept' : 'question', sourceUse:use(from.id)}, to:{kind:targetKind, sourceUse:use(to.id)},
      sourceUses:[use(from.id), use(to.id)],
    });
    const handle = createCommandHandler(db, {modules:[content], hooks:{async onFactsChanged() {}}});
    const write = (type:string, key:string, actor:'learner'|'companion', edge:ReturnType<typeof claim>, proof = {}) =>
      handle({learner:studioLearner, id:commandId(stableId(key)), actor, purpose:'teaching', type:'content.'+type,
        input:{id:stableId('edge',key), edge, purpose:'teaching', ...proof}});
    await write('createKnowledgeEdge','target','learner',claim('targets_concept', originalQuestion, concept, 'concept'));
    await write('createKnowledgeEdge','prerequisite','learner',claim('prereq_of',concept,compound,'concept'));
    const variantEdge = {...claim('variant_of', variant, originalQuestion),
      variant:{familyId:'ride', preserved:['总路程/总时间'], changed:['返程速度'], spoilsNext:'former'}};
    expect((await write('createKnowledgeEdge','candidate','companion',variantEdge)).state).toBe('proposed');
    const proof = await write('recordKnowledgeEdgeEvidence','checked','learner',variantEdge,{method:'trusted_source'});
    const verified = {verification:use(proof.wrote[0]!.id)};
    await expect(write('createVerifiedKnowledgeEdge','wrong','companion',{...variantEdge, scope:'另一范围'},verified)).rejects.toThrow('不符');
    expect((await write('createVerifiedKnowledgeEdge','verified','companion',variantEdge,verified)).state).toBe('done');

    const filters = {conceptId:concept.id, kinds:['question'], tags:['运动'], edgeKinds:['targets_concept','variant_of']};
    expect(await graph('search_workspace',{...filters,conceptId:compound.id,edgeKinds:['prereq_of','targets_concept']},16))
      .toMatchObject({results:[{id:originalQuestion.id,hop:2}],edges:[{kind:'prereq_of'},{kind:'targets_concept'}]});
    expect(await graph('search_workspace', {...filters,hops:0}, 4)).toMatchObject({conceptRef:{fact:{id:concept.id,rev:1}},edges:[]});
    expect(await graph('search_workspace', {...filters,hops:1}, 5)).toMatchObject({results:[{id:originalQuestion.id,hop:1}]});
    const chain = await graph('search_workspace', {...filters,hops:2}, 6);
    expect(chain).toMatchObject({results:[{id:originalQuestion.id,hop:1}, {id:variant.id,hop:2,occurredAt:null,tags:['运动'],exposure:'unknown'}],
      edges:[{kind:'targets_concept',traversal:'reverse'}, {kind:'variant_of',traversal:'reverse',author:'companion',variant:{spoilsNext:'former'}}]});
    const variantRef = new URLSearchParams({ref:JSON.stringify(chain.results[1].sourceRef),view:'preview'});
    expect(await access.record(variant.id,variantRef)).toMatchObject({rev:1,content:'请计算这两段路程的往返平均速度并说明分母。'});
    expect(await graph('read_workspace',{id:JSON.stringify(chain.edges[1].sourceRef)},7)).toMatchObject({from:{fact:{id:variant.id,rev:1}},to:{fact:{id:originalQuestion.id,rev:1}}});
    const lookup = new URLSearchParams({conceptId:concept.id,hops:'2',kinds:'question'});
    expect(await access.list(lookup)).toMatchObject({items:[{id:originalQuestion.id},{id:variant.id}]});
    expect(await graph('search_workspace',{query:'往返平均速度',kind:'question',tags:['运动']},8)).toMatchObject({
      results:[{id:variant.id,excerpt:'请计算这两段路程的往返平均速度并说明分母。',matched:expect.arrayContaining(['fts'])}]});
    expect(await graph('search_workspace',{query:'kinematiks',kind:'concept'},9)).toMatchObject({results:[{id:concept.id,matched:['trgm']}]});
    expect(await graph('search_workspace',{query:'答案检索隔离词'},10)).toMatchObject({results:[]});
    expect(await graph('search_workspace',{kind:'attempt',query:'海风',since:'2000-01-01'},11)).toMatchObject({results:[{id:attempt.id,occurredAt:expect.any(String)}]});
    expect(await graph('search_workspace',{kind:'question',exposureFilter:'unexposed'},12)).toMatchObject({results:[],unappliedFilters:[{reason:'coverage_unknown'}]});
    expect(await graph('search_workspace',{...filters,edgeKinds:['prereq_of']},14)).toMatchObject({results:[],edges:[]});

    const witness: WorkspaceWitness[] = [];
    const batchHost = openWorkspaceTools({db,turn:stableId('batch opens'),prior:[],authorize:async () => {},track:item => witness.push(item),maySend:() => true});
    const batch = JSON.parse(await batchHost.execute('open_learning',{
      refs:[JSON.stringify(ref),originalQuestion.id,JSON.stringify(chain.edges[1].sourceRef),stableId('missing object')],
    },20));
    expect(batch).toMatchObject({ok:false,code:'partial_success',items:[
      {id:first.page.id,rev:1,content:'计时'}, {id:originalQuestion.id,content:'骑行全程的平均速度是多少？'},
      {kind:'variant_of'}, {ok:false,code:'not_found',next:{tool:'search_workspace'}},
    ]});
    expect(JSON.stringify(batch)).not.toContain('答案检索隔离词');
    const part = JSON.parse(await batchHost.execute('open_learning',{refs:privatePaper.id,part:'question:2'},21)).items[0];
    expect(part).toMatchObject({content:'解释全程速度。',sourceRef:{anchor:{kind:'question'}}});
    expect(JSON.parse(await batchHost.execute('open_learning',{refs:JSON.stringify(part.sourceRef)},22)).items[0].content).toBe(part.content);
    const revokedHost = openWorkspaceTools({db,turn:stableId('batch revoked'),prior:witness,authorize:async () => {},track() {},
      maySend:fact => fact.ref.id !== originalQuestion.id});
    const mixed = JSON.parse(await revokedHost.execute('open_learning',{refs:[originalQuestion.id,variant.id]},24));
    expect(mixed.items).toMatchObject([{ok:false,code:'access_revoked'},{id:variant.id}]);
    const indexed = {learner:studioLearner,id:variant.id,rev:1,accessEpoch:'0',type:'activity.workspaceEntry'};
    await db.snapshot({learner:studioLearner}, async tx => {
      const query = {query:'与表面词完全不同',kind:'question',tags:['运动']};
      const access = {recipient:'workspace',maySend:() => true} as const;
      expect(await workspaceQuery(tx,query,access,{matched:'semantic',candidates:[
        {...indexed,id:originalQuestion.id,accessEpoch:'1'}, {...indexed,learner:stableId('other learner')}, indexed,indexed,
      ]})).toMatchObject({results:[{id:variant.id,matched:['semantic']}]});
      expect(await workspaceQuery(tx,filters,{recipient:'workspace',maySend:fact => fact.ref.id !== originalQuestion.id}))
        .toMatchObject({results:[],edges:[]});
    });
    await access.setTeaching(originalQuestion.id,{enabled:false,expectedRev:1});
    expect(await graph('search_workspace',{...filters,hops:2},6)).toMatchObject({error:expect.any(String)});
    expect(await graph('search_workspace',{...filters,hops:2},13)).toMatchObject({results:[],edges:[]});
    await db.snapshot({learner:learnerId(stableId('other learner'))}, async tx =>
      expect(await workspaceQuery(tx,filters,{recipient:'learner'})).toBeUndefined());
  } finally {
    await db.close(); await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.close();
  }
});
