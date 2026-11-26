import {expect,it} from 'vitest';
import type {CommandHooks, FactChange} from '../../../kernel/src/commands/contracts.ts';
import type {CanonicalEvidenceSliceV1} from '../../../kernel/src/pipeline-contracts.ts';
import {commandId, factId, learnerId} from '../../../kernel/src/declarations/ids.ts';
import type {Tick} from '../../../kernel/src/declarations/ids.ts';
import {createCommandHandler} from '../../../kernel/src/commands/handle.ts';
import {recordLocalRead} from '../../../kernel/src/work/effects.ts';
import {studioLearner,stableId} from '../identity.ts';
import {openLearningTools} from '../learning-tools.ts';
import {pythonReads} from '../../../executors/teaching/python-sdk.ts';
import {resolveSource, type WorkspaceSourceRecipient} from '../source-read.ts';
import {openWorkbook} from '../workbook.ts';
import {openWorkspaceAccess} from '../workspace-access.ts'; import {openWorkspaceTools, type WorkspaceWitness} from '../workspace-agent.ts';
import {openLibrary} from '../library.ts'; import {openOrganizer} from '../organizer.ts';
import {intakeWriteTargets} from '../intake.ts';
import {learningOverviewPurpose, readLearningOverview} from '../../../modules/activity/learning-overview.ts';
import type {LearningOverviewFact} from '../../../modules/activity/workspace-values.ts';
import {workbookRubricAssessmentType, workbookRubricAssessmentVersion, workbookRubricVersion} from '../../../modules/activity/workbook-values.ts';
import {workspaceQuery} from '../workspace-read.ts';
import {openTextbook} from '../textbook.ts';
import {readCurrentLearningObject} from '../current-learning-object.ts';
import {openResearch} from '../research.ts';
import {openRelationReview} from '../workspace-relation.ts';
import {factWriter} from '../../../modules/learner/test/facts.ts';
import {retentionPaperType,retentionTeachingPurpose} from '../../../modules/activity/retention-posttest.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { loadStudioTestModule } from './modules.ts';

it.skipIf(!testDatabaseUrl)('reopens authorized workspace versions and searches directed knowledge links in PostgreSQL', () =>
  withLearnerDatabase(studioLearner, async db => {
    const body = '画出已知两段🧭：计时，再计时';
    const makeHost = (turn:string, options:Partial<Parameters<typeof openWorkspaceTools>[0]> = {}) =>
      openWorkspaceTools({db,turn,prior:[],authorize:async()=>{},track(){},maySend:()=>true,...options});
    function turn(name:string) {
      const host = makeHost(stableId(name));
      return async (tool:string, args:Record<string,unknown>, step:number) => JSON.parse(await host.execute(tool,args,step));
    }
    async function author() {
      const run = turn('author');
      const source = await run('save_workspace',{kind:'concept',title:'时间线',body:'标出两段边界'},2);
      const page = await run('save_workspace',{kind:'page',title:'分段计时',body,tags:['方法'],links:[source.id]},3);
      return {source,page};
    }
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
    const privateHost = makeHost(stableId('another provider'),{maySend:fact => fact.ref.id !== first.source.id});
    const hidden = JSON.parse(await privateHost.execute('read_workspace',{id:first.page.id},1));
    expect(hidden).toMatchObject({ok:false, code:'not_found'});
    expect(hidden.content).toBeUndefined();

    const activity = await loadStudioTestModule('activity');
    const capture = await loadStudioTestModule('capture');
    const content = await loadStudioTestModule('content');
    const plan = await loadStudioTestModule('plan');
    const access = openWorkspaceAccess(db, activity, content, capture, plan); expect(access.categories).toEqual(expect.arrayContaining([{id: 'goal', label: '目标'}, {id: 'task', label: '任务'}]));
    const textbook = openTextbook(db, content, {async onFactsChanged() {}});
    const turnId = stableId('textbook source turn');
    const submitTurn = createCommandHandler(db,{modules:[activity],hooks:{async onFactsChanged() {}}});
    await submitTurn({learner:studioLearner,actor:'learner',purpose:'teaching',type:'activity.submitTurn',
      id:commandId(turnId),input:{id:turnId,data:{caseId:'companion',sessionId:turnId,parentId:null,
        answer:'这段对话用于本轮教学。',model:'local-test',baseUrl:'http://127.0.0.1'}}});
    const pageWriter = makeHost(turnId,{pageBasis:[{id:turnId,type:'activity.studyTurn',rev:1,epoch:'0'}]});
    const byCompanion = JSON.parse(await pageWriter.execute('save_page',{title:'伴学方法',content:'先找已知条件。'},1));
    expect(byCompanion).toMatchObject({ok:true,status:'saved'});
    expect(await textbook.get({learner:studioLearner,id:byCompanion.ref})).toMatchObject({title:'伴学方法'});
    await db.snapshot({learner:studioLearner},async tx =>
      expect(await resolveSource(tx,turnId,{recipient:'learner'})).toBeUndefined());
    await db.query('UPDATE facts SET purpose=$3 WHERE learner_id=$1 AND id=$2',[studioLearner,turnId,['teaching-disabled']]);
    await expect(textbook.get({learner:studioLearner,id:byCompanion.ref})).rejects.toMatchObject({status:403});
    const teachingPage = await textbook.create({learner:studioLearner, requestId:'textbook-teaching', clientEditSeq:0,
      page:{title:'我的教材', blocks:[{id:'intro', parentId:null, body:{kind:'text',text:'比对分段计时'}}]}});
    expect(await access.list(new URLSearchParams({category:'textbook'}))).toMatchObject({items:[{
      id:teachingPage.id, title:'我的教材', teaching:false, purposes:['storage'], excerpt:'比对分段计时',
    }]});
    const pageInput = {learner:studioLearner, id:teachingPage.id, purpose:'teaching'};
    await expect(textbook.get(pageInput)).rejects.toMatchObject({status:403});
    expect(await access.setTeaching(teachingPage.id,{enabled:true,expectedRev:1})).toMatchObject({rev:2,teaching:true});
    expect(await textbook.get(pageInput)).toMatchObject({rev:2,accessEpoch:'1'});
    const textbookTool = turn('native textbook block');
    expect(await textbookTool('open_learning',{refs:teachingPage.id},1)).toMatchObject({ok:true,items:[{
      blocks:[{id:'intro',parentId:null,kind:'text'}],
    }]});
    const openedBlock = await textbookTool('open_learning',{refs:teachingPage.id,part:'block:intro'},2);
    expect(openedBlock).toMatchObject({ok:true,items:[{content:'比对分段计时',sourceRef:{
      fact:{id:teachingPage.id,rev:2},anchor:{kind:'block',blockId:'intro'},
    }}]});
    const blockRef = {refs:JSON.stringify(openedBlock.items[0].sourceRef)};
    expect(await textbookTool('open_learning',blockRef,3)).toMatchObject({ok:true,items:[{content:'比对分段计时'}]});
    await expect(textbook.get({...pageInput,rev:1})).rejects.toMatchObject({status:403});
    await access.setTeaching(teachingPage.id,{enabled:false,expectedRev:2});
    expect(await textbookTool('open_learning',blockRef,4)).toMatchObject({ok:false,code:'access_revoked'});
    await expect(textbook.get({...pageInput,rev:2})).rejects.toMatchObject({status:403});
    expect(await textbook.get({...pageInput,purpose:'storage'})).toMatchObject({rev:3,accessEpoch:'2',title:'我的教材'});
    const overview = (callerPurpose = learningOverviewPurpose, maySend: (fact: LearningOverviewFact) => boolean = () => true) =>
      db.snapshot({learner: studioLearner}, tx => readLearningOverview(tx, {callerPurpose, maySend}));
    const library = openLibrary(db, capture, content, plan), organizer = openOrganizer(db, activity, plan);
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
    expect(await edit('read_workspace',chosen,2)).toMatchObject({ok:false, message:expect.any(String)});
    expect(await edit('read_workspace',chosen,5)).toMatchObject({rev:1,content:'计时'});

    const materialId = stableId('paired material'), intakeId = stableId('intake-document', materialId);
    const capturedText = '长材料正文。'.repeat(1000);
    const hooks = {async onFactsChanged() {}};
    const command = createCommandHandler(db, {
      modules: [activity, capture, content],
      hooks,
      crossModuleWrites: {
        ...intakeWriteTargets,
        'activity.setWorkspaceTeaching': {set_purpose: ['activity.textMaterial']},
      },
    });
    const captureRequest = {learner:studioLearner, actor:'learner', purpose:'storage', type:'activity.captureIntake',
      id:commandId(stableId('paired capture')), input:{materialId, intakeId, title:'长材料',
        original:{name:'study.txt', mediaType:'text/plain', size:1, sha256:'0'.repeat(64)},
        extraction:{status:'ok', method:'utf8', text:capturedText, error:null, warnings:[], pages:null,
          truncated:false, characterCount:capturedText.length}}} as const;
    const correctOnly = createCommandHandler(db, {
      modules: [capture, content], hooks,
      crossModuleWrites: {'activity.captureIntake': {correct: ['activity.textMaterial']}},
    });
    await expect(correctOnly(captureRequest)).rejects.toThrow('Create write must target a registry-owned fact type');
    await command(captureRequest);
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
    const pinnedHost = makeHost(stableId('pinned material reread'),{track:item => seen.push(item)});
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
      image_crop:{state:'unavailable',reason:'no-source-image'},effective_duration_ms:{state:'unavailable'},
      concept_history:{state:'unknown',reason:'no-linked-concepts'},mastery:{state:'unknown',reason:'no-linked-concepts'},
      retention:{state:'unknown',reason:'no-linked-concepts'},
    }]});
    expect(JSON.stringify(openedDiagnosis)).not.toContain('参考答案独有字样');

    const questionAuthor = turn('diagnosis question author');
    const diagnosisConcept = await questionAuthor('save_workspace',{kind:'concept',title:'风向',body:'按方位描述风向。'},1);
    const sourceQuestion = await questionAuthor('save_workspace',{kind:'question',title:'风向题',body:'描述风向。',
      answer:'内部答案正向',links:[diagnosisConcept.id]},2);
    const conceptGrant = await access.setTeaching(diagnosisConcept.id,{enabled:true,expectedRev:1});
    await access.setTeaching(sourceQuestion.id,{enabled:true,expectedRev:1});
    const photoMaterial = stableId('diagnosis photo material'), photoIntake = stableId('intake-document',photoMaterial);
    await command({learner:studioLearner,actor:'learner',purpose:'storage',type:'activity.captureIntake',
      id:commandId(stableId('diagnosis photo capture')),input:{materialId:photoMaterial,intakeId:photoIntake,title:'拍卷',
      requestedExtraction:'vision_llm',original:{name:'paper.png',mediaType:'image/png',size:4,sha256:'c'.repeat(64)},
      extraction:{status:'ok',method:'vision_llm',text:'描述风向。',error:null,warnings:[],pages:null,truncated:false,characterCount:5}}});
    await access.setTeaching(photoMaterial,{enabled:true,expectedRev:1});
    const linkedQuestions = [{id:'q1',kind:'exact' as const,prompt:'描述风向。',answers:['内部答案正向'],
      sourceQuestionRef:{id:sourceQuestion.id,rev:sourceQuestion.rev}}];
    const linkedPaper = await workbook.save({requestId:'linked-photo-paper',title:'拍卷诊断',materialId:photoMaterial,questions:linkedQuestions});
    const linkedQuestion = linkedPaper.questions[0]!;
    const linkedSubmission = (await workbook.submit(linkedPaper.id,{requestId:'linked-photo-attempt',
      answers:{[linkedQuestion.id]:'实测北风'}})).attempts[0]!;
    const linkedPaperGrant = await access.setTeaching(linkedPaper.id,{enabled:true,expectedRev:1});
    await access.setTeaching(linkedSubmission.id,{enabled:true,expectedRev:1});
    const historyPaper = factId(stableId('diagnosis history paper')), historyIssue = stableId('diagnosis history issue');
    await factWriter(db,{learner:studioLearner,purpose:'teaching'})([{kind:'create',id:historyPaper,
      factType:retentionPaperType,purpose:['storage',retentionTeachingPurpose],data:{title:'独立后测',materialId:null,
      savedAt:new Date().toISOString(),questions:linkedQuestions}}],211);
    await command({learner:studioLearner,actor:'learner',purpose:'teaching',type:'activity.issueRetentionPosttest',
      id:commandId(stableId('diagnosis history issuance')),input:{id:historyIssue,data:{condition:'studio-closed-workbook-v1',
      gradingVersion:'workbook-v1',forecastKey:stableId('diagnosis history forecast key'),forecastId:stableId('diagnosis history forecast'),
      effectiveTick:'1',paper:{id:historyPaper,rev:1},paperEpoch:'0',itemId:linkedQuestion.id,
      startedAt:new Date().toISOString(),through:new Date(Date.now()+86_400_000).toISOString()}}});
    await command({learner:studioLearner,actor:'learner',purpose:'teaching',type:'activity.submitWorkbookAttempt',
      id:commandId(stableId('diagnosis history submission')),
      input:{id:stableId('diagnosis history attempt'),condition:'studio-closed-workbook-v1',data:{paperId:historyIssue,requestId:'diagnosis-history',
      submittedAt:new Date().toISOString(),answers:{[linkedQuestion.id]:'北风'}}}});
    const now = new Date().toISOString();
    await db.tx({learner:studioLearner},tx => tx.withLearnerWrite(async tick => {
      const id = stableId('diagnosis forecast'), value = {kind:'value',value:{method:{id:'cognition',version:'3'},
        estimate:{kind:'probabilistic',probability:.91,interval:[.8,.96],uncertainty:.1,effectiveEvidence:1,
          bucket:{kcId:diagnosisConcept.id,representation:'symbolic',context:'practice',method:'direct'},basis:null},
        input:{target:{activity:'frozen-workbook-item',paper:{id:linkedPaper.id,rev:linkedPaperGrant.rev},
          itemId:linkedQuestion.id,condition:'same-item',gradingVersion:'workbook-v1'},
          window:{requestedAt:now,through:new Date(Date.now()+86_400_000).toISOString()},
          observedThrough:tick,observations:[]}}};
      const manifest = {version:1,learner:studioLearner,purpose:'teaching',gatherTick:tick,
        inputs:[{kind:'fact',id:linkedPaper.id,rev:linkedPaperGrant.rev,accessEpoch:'1',mode:'following'}]};
      await tx.insert('derivations',{learner_id:studioLearner,id,slot_type:'predict.forecast',slot_key:id,
        deriver:'learner/retention-forecast@1',scope_keys:'{}',value:JSON.stringify(value),lifecycle:'effective',
        freshness:'current',gather_tick:tick,effective_tick:tick,manifest:JSON.stringify(manifest)});
      await tx.insert('slot_state',{learner_id:studioLearner,slot_type:'predict.forecast',slot_key:id,
        current_id:id,last_id:id,pending:'none',changed_tick:tick,scope_keys:'{}'});
    }));
    const positive = await diagnose('open_learning',{refs:linkedSubmission.id,lens:'diagnose'},10);
    expect(positive).toMatchObject({
      ok: true,
      items: [{
        image_crop: { state: 'available', mediaType: 'image/png' },
        concept_history: { state: 'observed', concepts: [{ conceptId: diagnosisConcept.id, recentAttempts: [{ outcome: 'incorrect' }] }] },
        mastery: { state: 'observed', concepts: [{ conceptId: diagnosisConcept.id, status: expect.any(String) }] },
        retention: { state: 'observed', concepts: [{ conceptId: diagnosisConcept.id, probability: .91 }] },
      }],
    });
    expect(JSON.stringify(positive)).not.toContain('内部答案正向');
    const conceptRevocation = await access.setTeaching(diagnosisConcept.id,{enabled:false,expectedRev:conceptGrant.rev});
    expect(await diagnose('open_learning',{refs:linkedSubmission.id,lens:'diagnose'},11)).toMatchObject({ok:false,code:'basis_stale'});
    await access.setTeaching(diagnosisConcept.id,{enabled:true,expectedRev:conceptRevocation.rev});
    const reopenedPaper = await diagnose('read_workspace',{id:paper.id},4);
    expect(reopenedPaper.content).toContain(question.prompt);
    expect(JSON.stringify(await diagnose('read_workspace',{id:JSON.stringify(reopenedPaper.sourceRef)},5)))
      .not.toContain('参考答案独有字样');
    expect(JSON.stringify(opened)).not.toContain('参考答案独有字样');
    const currentAttempt = await bind('attempt',attempt.id,opened.rev);
    expect(currentAttempt?.openedAnswer).toBe(true);
    const bound = makeHost(stableId('bound observation'),{currentObject:currentAttempt});
    const observation = JSON.parse(await bound.execute('record_observation',evidence,1));
    expect(observation).toMatchObject({ok:true});
    const timedInput = {requestId:'timed-attempt',answers:{[question.id]:'实测东北风'},effectiveDurationMs:3200};
    const timed = (await workbook.submit(paper.id,timedInput)).attempts.find(item => item.requestId === timedInput.requestId)!;
    expect(timed.effectiveDurationMs).toBe(3200);
    expect((await workbook.submit(paper.id,{...timedInput,effectiveDurationMs:4200})).attempts.find(item => item.id === timed.id))
      .toMatchObject({effectiveDurationMs:3200});
    await expect(workbook.submit(paper.id,{...timedInput,effectiveDurationMs:-1})).rejects.toMatchObject({status:400});
    const timedGrant = await access.setTeaching(timed.id,{enabled:true,expectedRev:1});
    expect(await diagnose('open_learning',{...diagnosis,refs:timed.id},9)).toMatchObject({ok:true,items:[{
      effective_duration_ms:{state:'observed',value:3200,source:'browser-focus-v1'},
    }]});
    await access.setTeaching(timed.id,{enabled:false,expectedRev:timedGrant.rev});
    await access.setTeaching(paper.id,{enabled:false,expectedRev:paperGrant.rev});
    expect(await diagnose('open_learning',diagnosis,3)).toMatchObject({ok:false,code:'basis_stale'});
    expect(await diagnose('read_workspace',{id:observation.ref.id},6)).toMatchObject({ok:false, message:expect.any(String)});
    expect(await diagnose('read_workspace',{id:legacyObservation.ref.id},7)).toMatchObject({ok:false, message:expect.any(String)});
    expect(await diagnose('read_workspace',{id:legacyObservation.ref.id},8)).toMatchObject({ok:false, message:expect.any(String)});
    const legacyOwnerRead = await db.snapshot({learner:studioLearner},tx =>
      resolveSource(tx,legacyObservation.ref.id,{recipient:'learner'}));
    expect(legacyOwnerRead?.content).toContain(question.prompt);

    const privatePaper = await workbook.save({requestId:'search-preview',title:'检索速度卷',questions:[
      {kind:'exact',prompt:'写出速度单位。',answers:['内部答案标记']},
      {kind:'rubric',prompt:'解释全程速度。',rubric:'内部评分规则标记'},
    ]});
    const paced = {
      requestId: 'paced-attempt', paperRev: privatePaper.revision, answers: {q1:'米每秒',q2:null},
      effectiveDurationMs: 0,
      pacing: {version:1,items:[{questionId:'q1',effectiveDurationMs:0,skipped:true,returned:true}]},
    };
    const legacyPaced = {...timedInput,requestId:paced.requestId};
    const legacyReceipt = await workbook.submit(paper.id,legacyPaced);
    const handIn = (input = paced) => workbook.submit(privatePaper.id,input);
    const [firstPaced, concurrentPaced] = await Promise.all([handIn(),handIn()]);
    expect(firstPaced.attempts).toMatchObject([{
      paperRev: paced.paperRev, answers: paced.answers, pacing: paced.pacing, effectiveDurationMs:0,
    }]);
    expect(concurrentPaced.attempts).toEqual(firstPaced.attempts);
    expect((await workbook.submit(paper.id,legacyPaced)).attempts).toEqual(legacyReceipt.attempts);
    await expect(workbook.submit(paper.id,{...paced,paperRev:paper.revision})).rejects.toMatchObject({status:409});
    await expect(handIn({...paced,answers:{q1:' 米每秒 ',q2:null}})).rejects.toMatchObject({status:409});
    const privatePaperGrant = await access.setTeaching(privatePaper.id,{enabled:true,expectedRev:1});
    await expect(handIn({...paced,requestId:'stale-pacing'})).rejects.toMatchObject({status:409});
    expect((await handIn()).attempts).toEqual(firstPaced.attempts);
    const preview = await edit('search_workspace',{query:'检索速度卷',kind:'paper'},8);
    expect(preview).toMatchObject({results:[{id:privatePaper.id,excerpt:expect.stringContaining('写出速度单位。')}]});
    expect(JSON.stringify(preview)).not.toMatch(/内部答案标记|内部评分规则标记/u);
    const paperRef = new URLSearchParams({ref:JSON.stringify(preview.results[0].sourceRef)});
    expect(JSON.stringify(await access.record(privatePaper.id,paperRef))).toContain('内部评分规则标记');
    paperRef.set('view','preview');
    expect(await access.record(privatePaper.id,paperRef)).toMatchObject({content:'写出速度单位。\n\n解释全程速度。'});

    await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
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
    for (const anchor of [{kind:'whole'}, {kind:'question', itemId:'question'}]) {
      const sourceRef = {...chain.results[1].sourceRef, anchor};
      const params = new URLSearchParams({ref:JSON.stringify(sourceRef), view:'preview'});
      expect(await access.record(variant.id, params)).toEqual({
        id:variant.id, rev:1, title:'往返变式', sourceRef, content:'请计算这两段路程的往返平均速度并说明分母。',
      });
    }
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
    const batchHost = makeHost(stableId('batch opens'),{track:item => witness.push(item)});
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
    const revokedHost = makeHost(stableId('batch revoked'),{prior:witness,maySend:fact => fact.ref.id !== originalQuestion.id});
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
    expect(await graph('search_workspace',{...filters,hops:2},6)).toMatchObject({ok:false, code:'basis_stale'});
    expect(await graph('search_workspace',{...filters,hops:2},13)).toMatchObject({results:[],edges:[]});
    await db.snapshot({learner:learnerId(stableId('other learner'))}, async tx =>
      expect(await workspaceQuery(tx,filters,{recipient:'learner'})).toBeUndefined());

    const relation = turn('save relation');
    const research = openResearch(db, activity, await loadStudioTestModule('companion'));
    const relationChanges: FactChange[] = [];
    const onRelationChange: CommandHooks['onFactsChanged'] = async (tx, tick, changes) => {
      relationChanges.push(...changes);
      await research.activityChanged(tx, tick, changes);
    };
    const review = openRelationReview(db,content,onRelationChange);
    const draft = {kind:'contrasts_with',from:concept.id,to:compound.id,scope:'适用条件'};
    const query = new URLSearchParams({conceptId:concept.id,direction:'outbound',edgeKinds:draft.kind});
    await relation('search_workspace',{kind:'concept',query:'分段运动'},1);
    expect(await relation('save_relation',draft,2)).toMatchObject({code:'evidence_not_opened',next:{tool:'open_learning'}});
    const endpoints = await relation('open_learning',{refs:[concept.id,compound.id]},3);
    const from = endpoints.items[0].sourceRef;
    expect(await relation('save_relation',{...draft,from:JSON.stringify({...from,fact:{...from.fact,rev:2}})},4))
      .toMatchObject({code:'version_conflict',field:'from',next:{tool:'open_learning'}});
    const proposal = await relation('save_relation',{...draft,from:JSON.stringify(from)},5);
    expect(proposal).toMatchObject({ok:true,status:'proposed'});
    expect(await access.list(query)).toMatchObject({edges:[]});
    const accepted = await review.accept(proposal.proposalId);
    expect(await review.accept(proposal.proposalId)).toEqual(accepted);
    expect(relationChanges).toMatchObject([{factType:'content.knowledgeEdge',kind:'create',ref:{id:accepted.ref.fact.id,rev:1}}]);
    expect(await access.list(query)).toMatchObject({edges:[{
      id:accepted.ref.fact.id,kind:draft.kind,from,to:endpoints.items[1].sourceRef,
    }]});
    await review.undo(accepted.ref.fact.id,{undo_token:accepted.undo_token});
    expect(relationChanges.at(-1)).toMatchObject({factType:'content.knowledgeEdge',kind:'retract',ref:{id:accepted.ref.fact.id,rev:2}});
    await access.setTeaching(compound.id,{enabled:false,expectedRev:1});
    expect(await relation('save_relation',draft,6)).toMatchObject({code:'access_revoked',next:{tool:'search_workspace'}});

    // agentVersion 2 narrowSaves turns reject the retired names before any write runs.
    const narrow = makeHost(stableId('narrow saves'),{narrowSaves:true});
    for (const name of ['save_workspace','save_relation'])
      expect(JSON.parse(await narrow.execute(name,{},1))).toMatchObject({ok:false,code:'tool_unavailable'});

    // save_question revisions reopen the target through the turn's own witnesses, never self-reference the basis.
    const draftWitnesses: import('../workspace-question.ts').DraftWitness[] = [];
    const quHost = makeHost(stableId('question author'),{narrowSaves:true,draftBasis:()=>draftWitnesses});
    const qu = async (args:Record<string,unknown>,step:number) => JSON.parse(await quHost.execute('save_question',args,step));
    const created = await qu({title:'往返题',prompt:'往返平均速度是多少？'},1);
    expect(created).toMatchObject({ok:true,data:{status:'draft',rev:1}});
    const rejected = await qu({ref:created.data.ref,expected_rev:1,patch:{title:'x'}},2);
    expect(rejected).toMatchObject({ok:false,code:'evidence_not_opened'});
    const pinQuestion = async (rev:number) => draftWitnesses.push({id:created.data.ref,rev,
      epoch:await db.snapshot({learner:studioLearner},tx=>tx.query<{epoch:string}>(
        'SELECT access_epoch::text AS epoch FROM facts WHERE learner_id=$1 AND id=$2',[studioLearner,created.data.ref])).then(r=>r.rows[0]!.epoch as Tick)});
    await pinQuestion(1);
    const metaRef = (rev:number) => JSON.stringify({v:1,fact:{id:created.data.ref,rev,type:'content.asset'},anchor:{kind:'block',blockId:'prompt'}});
    const revised = await qu({ref:created.data.ref,expected_rev:1,patch:{title:'往返题·改'},append_metadata:{tags:[{kind:'target_skill',term:'平均速度',scope:'往返',source_ref:metaRef(2)}]}},3);
    expect(revised).toMatchObject({ok:true,data:{rev:2}});
    await pinQuestion(2);
    expect(await qu({ref:created.data.ref,expected_rev:2,append_metadata:{solutions:[{method:'定义法',explanation:'总路程除以总时间。',source_ref:metaRef(2)}]}},4))
      .toMatchObject({ok:true,data:{rev:2}});
    expect(await qu({ref:created.data.ref,expected_rev:1,patch:{title:'z'}},5)).toMatchObject({ok:false,code:'version_conflict'});
    const stored = await db.snapshot({learner:studioLearner},tx=>tx.query<{purpose:string[]}>(
      'SELECT purpose FROM facts WHERE learner_id=$1 AND id=$2',[studioLearner,created.data.ref]));
    expect(stored.rows[0]?.purpose).toEqual(['storage']);
    draftWitnesses.push({id:teachingPage.id as never,rev:3,epoch:'2' as Tick}); // P0：撤销 teaching 后 create/revise 均 access_revoked。
    expect(await qu({title:'隔离题',prompt:'p'},6)).toMatchObject({ok:false,code:'access_revoked'});
    expect(await qu({ref:created.data.ref,expected_rev:2,append_metadata:{tags:[{kind:'target_skill',term:'t',scope:'s',source_ref:metaRef(2)}]}},7)).toMatchObject({ok:false,code:'access_revoked'}); draftWitnesses.splice(1);

    // Simulate a previously graded rubric slot; the two source grants and Studio calls use live entry points.
    const gradedQuestion = privatePaper.questions[1]!;
    const gradedAnswer = '路程除以时间';
    const {attempts:[gradedAttempt]} = await workbook.submit(privatePaper.id, {
      requestId:'bus-rubric', answers:{[gradedQuestion.id]:gradedAnswer},
    });
    if (!gradedAttempt) throw new Error('Missing rubric attempt');
    const gradedAttemptId = gradedAttempt.id;
    await access.setTeaching(gradedAttempt.id,{enabled:true,expectedRev:1});
    const gradeId = stableId('bus-rubric-result');
    await db.tx({learner:studioLearner}, tx => tx.withLearnerWrite(async tick => {
      const scope = JSON.stringify({paperId:privatePaper.id,attemptId:gradedAttempt.id});
      const inputs = [gradedAttempt.id, privatePaper.id].map(id =>
        ({kind:'fact',id,rev:2,accessEpoch:'1',mode:'pinned'}));
      await tx.insert('derivations', {learner_id:tx.learner,id:gradeId,slot_type:workbookRubricAssessmentType,slot_key:gradeId,
        deriver:workbookRubricAssessmentVersion,scope_keys:scope,lifecycle:'effective',freshness:'current',
        gather_tick:tick,effective_tick:tick,manifest:JSON.stringify({version:1,learner:tx.learner,purpose:'storage',gatherTick:tick,inputs}),
        value:JSON.stringify({paperId:privatePaper.id,attemptId:gradedAttempt.id,questionId:gradedQuestion.id,requestId:'bus-rubric',
          assessedAt:new Date().toISOString(),assessmentVersion:workbookRubricAssessmentVersion,rubricVersion:workbookRubricVersion,
          rubric:'内部评分规则标记',providerBaseUrl:'fixture',verdict:'correct',feedback:'正确',evidence:[gradedAnswer],trace:[]})});
      await tx.insert('slot_state',{learner_id:tx.learner,slot_type:workbookRubricAssessmentType,slot_key:gradeId,
        current_id:gradeId,last_id:gradeId,scope_keys:scope,changed_tick:tick});
    }));
    async function openGradedAttempt(name:string, denyPaper:boolean) {
      const bases: unknown[] = [];
      const tools = makeHost(stableId(name),{trackAssessment:basis => bases.push(basis),maySend:fact => !denyPaper || fact.ref.id !== privatePaper.id});
      return {result:JSON.parse(await tools.execute('read_workspace',{id:gradedAttemptId},1)),bases};
    }
    const grade = await openGradedAttempt('bus-allowed',false);
    expect(grade.result.assessments).toMatchObject([{verdict:'correct',evidence:[gradedAnswer]}]);
    expect(grade.bases).toMatchObject([{facts:[{id:gradedAttempt.id,mode:'following'},{id:privatePaper.id,mode:'pinned'}]}]);
    const blocked = await openGradedAttempt('bus-restricted',true);
    expect(blocked.result).toMatchObject({id:gradedAttemptId});
    expect(blocked.result.assessments).toBeUndefined();
    expect(blocked.bases).toEqual([]);

    const runId = stableId('whole-exam-sdk');
    let allowPaper = true;
    const maySend: WorkspaceSourceRecipient = fact => allowPaper || fact.ref.id !== privatePaper.id;
    const authorize = async () => {}, track = () => {};
    const workspace = makeHost(runId,{authorize,track,maySend});
    const sdk = openLearningTools({db,turn:runId,workspace,authorize,track,maySend,manageBeliefs:false,trackRetention:track,
      authorizeRemote:async()=>true,readContext:async()=>undefined,saveBelief:async()=>'',onDelivered:async()=>{}});
    const reads = pythonReads([{method:'evidence_slice',args:{exam_pacing:true,paper_ids:[privatePaper.id]}}]);
    expect(reads).toBeDefined();
    const packet = await sdk.preparePython!(reads!,1);
    expect(packet).toMatchObject({ok:true,values:[{events:[{
      ref:gradedAttempt.id,rev:2,occurred_at:gradedAttempt.submittedAt,help_level:'unknown',
      exam_pacing:{paper_key:JSON.stringify([privatePaper.id,privatePaperGrant.rev])},
    }]}]});
    if (!packet.ok) throw new Error('Missing whole-exam evidence');
    expect(packet.values[0]).not.toHaveProperty('events.0.exam_pacing.score');
    expect(JSON.stringify(packet)).not.toMatch(/内部评分规则标记|路程除以时间/u);
    const pacingAttempt = firstPaced.attempts[0]!;
    const pacingGrant = await access.setTeaching(pacingAttempt.id,{enabled:true,expectedRev:1});
    const processReads = pythonReads([{method:'evidence_slice',args:{exam_pacing_items:true,paper_ids:[privatePaper.id]}}]);
    if (!processReads) throw new Error('逐题过程 SDK 读取尚不可用。');
    const process = await sdk.preparePython!(processReads,2);
    if (!process.ok) throw new Error(JSON.stringify(process));
    const events = (process.values[0] as CanonicalEvidenceSliceV1).events.filter(event => event.exam_pacing_item);
    expect(events).toMatchObject([{occurred_at:pacingAttempt.submittedAt,help_level:'unknown',claim_ids:[],
      effective_duration_ms:0,exam_pacing_item:{attempt_ref:{id:pacingAttempt.id,rev:pacingGrant.rev},
        paper_key:JSON.stringify([privatePaper.id,privatePaper.revision]),item_id:'q1',position:1,item_count:2,
        skipped:true,returned:true}}]);
    allowPaper = false;
    expect(await sdk.preparePython!(reads!,1)).toMatchObject({ok:false,code:'access_revoked'});
    expect(await sdk.preparePython!(processReads,2)).toMatchObject({ok:false,code:'access_revoked'});
    allowPaper = true;
    await access.setTeaching(pacingAttempt.id,{enabled:false,expectedRev:pacingGrant.rev});
    expect(await sdk.preparePython!(processReads,2)).toMatchObject({ok:false,code:'access_revoked'});
    const fresh = await sdk.preparePython!(processReads,3);
    if (!fresh.ok) throw new Error(JSON.stringify(fresh));
    expect((fresh.values[0] as CanonicalEvidenceSliceV1).events.every(event => !event.exam_pacing_item)).toBe(true);
  }));
