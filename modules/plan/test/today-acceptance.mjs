import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gatherSnapshot } from '../../../kernel/src/derivations/gather.ts';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createCommandReadContext } from '../../../kernel/src/commands/reads.ts';
import { withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { loadModuleDirectory } from '../../../kernel/src/loader.ts';
import { openOrganizer } from '../../../runtime/studio/organizer.ts';
import { studioLearner } from '../../../runtime/studio/identity.ts';
import { planToday, sessionRule } from '../today.ts';
import { openPack, checkPack } from '../offline-pack.ts';
import { studyGoal } from '../goal-values.ts';

const base = {now:'2026-11-18T11:00:00Z', timeZone:'Asia/Tokyo', constraints:{budget_min:20,locks:['fixed'],deadlines:[]}};
const noLocks = {...base.constraints, locks:[]};
const make = (id, minutes, information, props={})=>({id, title:id, topic:id, kind:'review', minutes, information, durationBasis:'冻结课堂估时',
  input:'write', open:{kind:'activity',id,rev:1}, reason:'读图独立检验', evidence:['fixture/'+id], delayImpact:'推迟独立检验', ...props});
const fixed = make('fixed',4,0);
const candidates = [fixed,make('convert',8,1),make('graph',8,.9),make('units',8,.4)];
const school = {kind:'schoolwork',topic:'convert',date:'2026-11-19',minutes:12};
const ids = plan=>plan.items.map(i=>i.candidate.id);

test('固定周三晚，明日作业取消时仅重排未开始项；三分钟、跨日、长假和三战役',()=>{
  const unknown = planToday({...base,constraints:{budget_min:null,locks:[],deadlines:[]},candidates:[]});
  assert.equal(unknown.assumedMinutes,15); assert.match(unknown.budgetBasis,/未知/);
  assert.equal(planToday({...base,constraints:{budget_min:0,locks:[],deadlines:[]},candidates:[]}).items.length,0);
  const before = planToday({...base,candidates,rules:[school]});
  const after = planToday({...base,candidates});
  assert.deepEqual(ids(before),['graph','units']);
  assert.deepEqual(ids(after),['convert','graph']);
  assert.deepEqual(before.protectedItems,after.protectedItems);
  assert.equal(before.totalMinutes,20);
  assert.equal(before.tradeoffs[0].activityId,'convert');
  const draft = make('draft',4,0,{state:'in-progress',date:before.day,draftRef:'draft@5'});
  const next = {...base,now:'2026-11-18T15:01:00Z',constraints:noLocks};
  const session = sessionRule(base.now,base.timeZone,3,'tired');
  assert.equal(session.expiresAt,'2026-11-18T15:00:00.000Z');
  assert.deepEqual(planToday({...next,candidates:[draft],rules:[session]}).protectedItems,[draft]);
  assert.equal(planToday({...next,candidates:[],rules:[session]}).budgetMinutes,20);
  const one = planToday({...next,candidates,mode:'one-hand'});
  assert.equal(one.totalMinutes,3); assert.equal(one.items[0].candidate.input,'tap');
  const long = {...next,candidates:[make('forty-four',44,1),make('forty-five',45,1),make('hour',60,1,{input:'voice'})],
    constraints:{budget_min:60,locks:[],deadlines:[]},duration:'45min+'};
  assert.deepEqual(planToday(long).shortlist,['forty-five','hour']);
  assert.deepEqual(planToday({...long,mode:'voice'}).shortlist,['hour']);
  assert.deepEqual(planToday({...long,mode:'one-hand'}).shortlist,[]);
  const examScope = {kind:'exam',date:'2026-11-25',scope:['graph','formula'],weights:[{topic:'graph',weight:50},{topic:'formula',weight:50}]};
  const sprintCandidates = [make('ordinary',4,1),make('ordinary-short',3,1),
    make('archetype',4,0,{topic:'graph',examPrep:{kind:'archetype',coveredQuestionCount:5}}),
    make('card',3,0,{topic:'formula',examPrep:{kind:'first-aid'}})];
  const campaignInput = {...next,now:base.now,candidates:sprintCandidates,rules:[examScope],
    constraints:{budget_min:7,locks:[],deadlines:[]}};
  const sprint = planToday(campaignInput);
  assert.deepEqual(ids(sprint),['archetype','card']);
  assert.match(sprint.items[0].why.join(' '),/5 道原卷题/);
  assert.deepEqual(ids(planToday({...campaignInput,rules:[examScope,{kind:'campaign',campaign:'steady'}]})),
    ['ordinary','ordinary-short']);
  const forecast = {exam:examScope,frozenAt:base.now,low:70,high:85,maximum:100,assessment:{id:'assess',rev:2},
    calibration:{id:'calibrate',rev:1},methodVersion:'calibrated@1',absoluteError:8};
  const recovery = {...next,now:'2026-11-26T11:00:00Z',rules:[examScope],frozenExamForecast:forecast,
    lastOpenedAt:'2026-10-26T11:00:00Z',candidates:[make('probe',4,1,{kind:'probe'}),
      make('long-review',11,1,{kind:'recovery'}),make('review',6,0,{kind:'recovery'}),make('second',5,0,{kind:'recovery'})]};
  const examScore = {submission:{id:'submitted',rev:1},forecastAssessment:forecast.assessment,
    submittedAt:'2026-11-25T11:00:00Z',score:{earned:65,maximum:100}};
  const afterExam = planToday({...recovery,examScore});
  assert.equal(afterExam.items.length,1);
  assert.ok(!afterExam.shortlist.includes('probe') && !afterExam.shortlist.includes('long-review'));
  assert.equal(afterExam.scoreReview.status,'below-expected-range');
  assert.equal(planToday({...recovery,examScore:{...examScore,score:{earned:75,maximum:100}}}).scoreReview.status,'within-expected-range');
  assert.equal(planToday({...recovery,examScore:{...examScore,forecastAssessment:{id:'assess',rev:1}}}).scoreReview.kind,'unknown');
  const returnInput = {...next,lastOpenedAt:'2026-10-27T11:00:00Z',rules:[
    {...examScope,scope:['weak'],weights:[{topic:'weak',weight:100}]}
  ],candidates:[
    make('weak',4,.2,{kind:'probe',retention:.2,examPrep:{kind:'archetype',coveredQuestionCount:12}}),
    make('uncertain',6,1,{kind:'probe'}),make('stable',6,0,{retention:.9})
  ]};
  const returning = planToday(returnInput);
  assert.deepEqual(ids(returning),['uncertain','weak']);
  assert.deepEqual(returning.overview,{retained:['stable'],faded:['weak'],unknown:['uncertain']});
  const protectedReturn = planToday({...returnInput,candidates:[...returnInput.candidates,draft,fixed],
    constraints:base.constraints});
  assert.deepEqual([ids(protectedReturn),protectedReturn.protectedItems],[[],[draft,fixed]]);
  const localRules = [...[school],{kind:'defer',activityId:'graph',until:'2026-11-20'},
    {kind:'replace',activityId:'convert',replacementId:'units',date:before.day}];
  assert.deepEqual(ids(planToday({...base,candidates,rules:localRules})),['units']);
  const rest = planToday({...base,candidates,rules:[{kind:'rest',date:before.day}]});
  assert.deepEqual([ids(rest),rest.protectedItems,rest.conflicts.length],[[],[fixed],1]);
});

test('Organizer 实库验收：空库、T-7 跨时区、考后切换、长假重排及规则回执',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-18T05:00:00Z')});
  const learner = studioLearner, goalId = '00000000000000000000000002', ruleId = '00000000000000000000000003';
  await withLearnerDatabase(learner, async db => {
    const modules = await Promise.all(['..','../../activity'].map(p=>loadModuleDirectory(fileURLToPath(new URL(p+'/',import.meta.url)))));
    const organizer = openOrganizer(db,modules[1],modules[0],{onFactsChanged:async()=>{}});
    const today = params => organizer.today(new URLSearchParams(params));
    const oneHand = await today({mode:'one-hand'});
    const fixedPack = oneHand.items[0].candidate;
    assert.equal(oneHand.budgetMinutes,3);
    assert.equal(fixedPack.input,'tap');
    const save = (requestId,data,prior) => organizer.rule({requestId:'today-'+requestId,data,id:prior?.id,expectedRev:prior?.rev ?? null});
    const packLock = await save('filter-lock',{kind:'lock',date:oneHand.day,activityId:fixedPack.id});
    const fifteen = await today({mode:'one-hand',duration:'15min'});
    const longer = await today({duration:'45min+'});
    assert.equal(fifteen.budgetMinutes,15); assert.ok(fifteen.items.every(i=>i.candidate.input==='tap'));
    assert.equal(longer.assumedMinutes,45); assert.deepEqual(longer.items,[]);
    assert.deepEqual(longer.protectedItems,[fixedPack]);
    await assert.rejects(()=>today({duration:'bad'}),{status:400});
    const handle = createCommandHandler(db,{modules,hooks:{onFactsChanged:async()=>{}}});
    let n = 10;
    const req = (type,input,actor='learner',purpose='storage')=>({learner,type,input,actor,purpose,id:String(++n).padStart(26,'0')});
    const read = (id,purpose='storage')=>db.snapshot({learner},tx=>createCommandReadContext(tx,purpose).fact(id,{mode:'following'}));
    await save('clear-filter-lock',null,packLock);
    const [paper, pinned] = await Promise.all(['接着练','本人锁定'].map((title,i)=>
      handle(req('activity.saveWorkbookPaper',{id:String(20+i).padStart(26,'0'),data:{title,materialId:null,
        savedAt:new Date().toISOString(),questions:[{id:'q1',kind:'numeric',prompt:'2 + 3 = ?',answer:5,tolerance:0,unit:null,explanation:null}]}}))
        .then(receipt => receipt.wrote[0].id+'@1')));
    const lock = await save('today-lock',{kind:'lock',date:oneHand.day,activityId:pinned});
    const exam = await save('exam',{kind:'exam',date:'2026-11-25',scope:['接着练'],weights:[{topic:'接着练',weight:100}]});
    for (const [timeZone,day,campaign] of [['America/Los_Angeles','2026-11-17','steady'],['Asia/Tokyo','2026-11-18','sprint']]) {
      const view = await today({timeZone});
      assert.deepEqual([view.day,view.campaign],[day,campaign]);
    }
    const manual = await save('manual',{kind:'campaign',campaign:'steady'});
    assert.equal((await today()).campaign,'steady');
    await save('resume-automatic',null,manual);
    await save('correct-scope',{kind:'exam',date:'2026-11-25',scope:['本人锁定'],weights:[]},exam);
    const homework = await save('homework',{...school,date:oneHand.day,minutes:7});
    const returning = () => today({lastOpenedAt:'2026-10-28T05:00:00Z'});
    for (let completed=0;completed<2;completed++) {
      const view = await returning();
      assert.deepEqual([view.returning,view.campaign,view.schoolMinutes],[true,'sprint',7]);
      assert.deepEqual(view.protectedItems.filter(c=>c.state!=='completed').map(c=>c.id),[pinned]);
      assert.ok(view.totalMinutes + view.schoolMinutes <= view.budgetMinutes);
      assert.equal(view.items.length,1);
      const {kind,id,rev} = view.items[0].candidate.open;
      assert.equal(kind,'pack');
      await organizer.submit({requestId:'today-probe-'+completed,id,rev,choice:0,consent:'teaching'});
    }
    const resumed = await returning();
    assert.deepEqual(ids(resumed),[paper]);
    assert.equal(resumed.protectedItems.filter(c=>c.state==='completed').length,2);
    const rest = await save('rest',{kind:'rest',date:oneHand.day});
    const rested = await returning();
    assert.deepEqual([ids(rested),rested.protectedItems,rested.conflicts.length],[[],resumed.protectedItems,1]);
    await save('clear-rest',null,rest);
    await save('clear-homework',null,homework);
    await save('clear-lock',null,lock);
    for (const [date,campaign,expected] of [['26','recovery',['pack/reflection']],['28','steady',[paper,pinned]]]) {
      t.mock.timers.setTime(Date.parse('2026-11-'+date+'T05:00:00Z'));
      const view = await today();
      assert.equal(view.campaign,campaign);
      assert.deepEqual(ids(view).sort(),expected.sort());
      if (campaign==='recovery') assert.equal(view.scoreReview.kind,'unknown');
    }
    const deriver = modules[0].derivers.get('plan/today');
    const input = {...base,constraints:noLocks,candidates:[]};
    const gathered = await gatherSnapshot(db,{learner,purpose:'storage'},ctx=>deriver.gather(ctx,async()=>input));
    assert.deepEqual(gathered.plan.effects,[]);
    const {items} = deriver.derive(gathered.plan.data).value;
    assert.equal(items.length,2);
    const {id,rev} = items[0].candidate.open;
    const card = openPack(id,rev);
    assert.ok(card.prompt && card.choices.length===3 && !('correct' in card));
    const checked = card.choices.map((_,i)=>checkPack(id,rev,i));
    assert.equal(checked.filter(a=>a.result==='correct').length,1);
    assert.throws(()=>checkPack(id,rev+1,0));
    const submission = req('activity.recordEvidence',{id:'00000000000000000000000004',data:checked[0].record},'learner','teaching');
    const receipt = await handle(submission);
    assert.deepEqual(await handle(submission),receipt);
    assert.deepEqual((await read(receipt.wrote[0].id,'teaching')).value,checked[0].record);
    assert.equal(studyGoal({text:'历史目标'}).status,'active');
    await handle(req('activity.setStudyGoal',{id:goalId,data:{text:'读图'}}));
    const proposed = req('plan.setGoalStatus',{id:goalId,expectedRev:1,status:'paused'},'companion');
    assert.equal((await handle(proposed)).state,'proposed');
    assert.equal((await read(goalId)).value.status,'active');
    await handle.decideProposal({...req(proposed.type,{}),proposalId:proposed.id,selection:true},(_,input)=>input);
    assert.equal((await read(goalId)).value.status,'paused');
    for (const [i,status] of ['active','completed','exited'].entries()) {
      await handle(req('plan.setGoalStatus',{id:goalId,expectedRev:i+2,status}));
      const goal = {id:goalId,...(await read(goalId)).value};
      assert.equal(planToday({...input,goal,candidates:[make('graph',8,.9,{goalId})]}).shortlist.includes('graph'),status==='active');
    }
    const create = req('plan.saveRule',{id:ruleId,expectedRev:null,data:school});
    await handle(create);
    const fromFacts = await gatherSnapshot(db,{learner,purpose:'storage'},ctx=>deriver.gather(ctx,async ctx=>{
      const [goal,rule] = await Promise.all([goalId,ruleId].map(id=>ctx.read.fact(id,{mode:'following'})));
      return {...input,goal:{id:goalId,...goal.value},rules:[rule.value],candidates};
    }));
    assert.deepEqual(fromFacts.manifest.inputs.map(w=>w.id).sort(),[goalId,ruleId]);
    assert.deepEqual(fromFacts.manifest.inputs.map(w=>w.mode),['following','following']);
    assert.equal(deriver.derive(fromFacts.plan.data).value.activeGoal,null);
    await handle(req('plan.saveRule',{id:ruleId,expectedRev:1,data:{...school,minutes:7}}));
    await assert.rejects(()=>handle(req('plan.saveRule',{id:ruleId,expectedRev:1,data:null})),/revision conflict/);
    await handle(req('plan.saveRule',{id:ruleId,expectedRev:2,data:null}));
    await assert.rejects(()=>read(ruleId));
  }, {postgres: false});
});
