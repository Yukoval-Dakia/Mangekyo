import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gatherSnapshot } from '../../../kernel/src/derivations/gather.ts';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createCommandReadContext } from '../../../kernel/src/commands/reads.ts';
import { withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { openOrganizer } from '../../../runtime/studio/organizer.ts';
import { studioLearner } from '../../../runtime/studio/identity.ts';
import { loadStudioTestModule } from '../../../runtime/studio/test/modules.ts';
import { planToday, sessionRule } from '../today.ts';
import { checkPack } from '../offline-pack.ts';

const base = {now:'2026-11-18T11:00:00Z', timeZone:'Asia/Tokyo', constraints:{budget_min:20,locks:['fixed'],deadlines:[]}};
const noLocks = {...base.constraints, locks:[]};
const make = (id, minutes, information, props={})=>({id, title:id, topic:id, kind:'review', minutes, information, durationBasis:'冻结课堂估时',
  input:'write', open:{kind:'activity',id,rev:1}, reason:'读图独立检验', evidence:['fixture/'+id], delayImpact:'推迟独立检验', ...props});
const fixed = make('fixed',4,0);
const candidates = [fixed,make('convert',8,1),make('graph',8,.9),make('units',8,.4)];
const school = {kind:'schoolwork',topic:'convert',date:'2026-11-19',minutes:12};
const ids = plan=>plan.items.map(i=>i.candidate.id);

test('固定周三晚，明日作业取消时仅重排未开始项；跨日、长假和三战役',()=>{
  assert.equal(planToday({...base,constraints:{...noLocks,budget_min:0},candidates:[]}).items.length,0);
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
  const long = {...next,candidates:[make('forty-four',44,1),make('forty-five',45,1),make('hour',60,1,{input:'voice'})],
    constraints:{budget_min:60,locks:[],deadlines:[]},duration:'45min+'};
  for (const [mode,expected] of [['any',['forty-five','hour']],['voice',['hour']],['one-hand',[]]])
    assert.deepEqual(planToday({...long,mode}).shortlist,expected);
  const examScope = {kind:'exam',date:'2026-11-25',scope:['weak','formula'],weights:[{topic:'weak',weight:50},{topic:'formula',weight:50}]};
  const examCandidates = [
    make('weak',4,.2,{kind:'probe',retention:.2,examPrep:{kind:'archetype',coveredQuestionCount:12}}),
    make('uncertain',6,1,{kind:'probe'}),make('stable',3,1,{retention:.9}),
    make('card',3,0,{topic:'formula',examPrep:{kind:'first-aid'}}),
  ];
  const campaignInput = {...base,candidates:examCandidates,rules:[examScope],
    constraints:{...noLocks,budget_min:9}};
  const sprint = planToday(campaignInput);
  assert.deepEqual(ids(sprint),['weak','card']);
  assert.match(sprint.items[0].why.join(' '),/12 道原卷题/);
  assert.deepEqual(ids(planToday({...campaignInput,rules:[examScope,{kind:'campaign',campaign:'steady'}]})),
    ['stable','uncertain']);
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
  const review = change => planToday({...recovery,examScore:{...examScore,...change}}).scoreReview;
  assert.equal(review({score:{earned:75,maximum:100}}).status,'within-expected-range');
  assert.equal(review({forecastAssessment:{...forecast.assessment,rev:1}}).kind,'unknown');
  const returnInput = {...campaignInput,...next,lastOpenedAt:'2026-10-27T11:00:00Z'};
  const returning = planToday(returnInput);
  assert.deepEqual(ids(returning),['uncertain','weak']);
  assert.deepEqual(returning.overview,{retained:['stable'],faded:['weak'],unknown:['uncertain','formula']});
  const protectedReturn = planToday({...returnInput,candidates:[...returnInput.candidates,draft,fixed],
    constraints:base.constraints,rules:[...returnInput.rules,session]});
  assert.deepEqual([ids(protectedReturn),protectedReturn.protectedItems],[[],[draft,fixed]]);
  assert.equal(protectedReturn.budgetMinutes,20);
  const localRules = [school,{kind:'defer',activityId:'graph',until:'2026-11-20'},
    {kind:'replace',activityId:'convert',replacementId:'units',date:before.day}];
  assert.deepEqual(ids(planToday({...base,candidates,rules:localRules})),['units']);
  const completed = (topic,returnProbeResult) => make('probe-'+topic,3,0,{kind:'probe',state:'completed',date:before.day,topic,returnProbeResult});
  for (const [topic,result,expected] of [['graph','unknown','convert'],['graph','incorrect','graph'],['convert','correct','graph']]) {
    const view = planToday({...base,lastOpenedAt:returnInput.lastOpenedAt,candidates:[...candidates,completed(topic,result),completed('units','unknown')],
      rules:[{...school,date:before.day,topic:'校内任务',minutes:8}]});
    assert.deepEqual([ids(view),view.protectedItems[0],view.totalMinutes+view.schoolMinutes],[[expected],fixed,20]);
    assert.equal(view.items[0].candidate.evidence.includes('fixture/probe-graph'),result==='incorrect');
  }
});

test('Organizer 实库验收：空库、T-7 跨时区、考后切换、长假重排及规则回执',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-18T05:00:00Z')});
  const learner = studioLearner, goalId = '00000000000000000000000002';
  await withLearnerDatabase(learner, async db => {
    const modules = await Promise.all(['activity','plan'].map(loadStudioTestModule));
    const hooks = {onFactsChanged:async()=>{}};
    const organizer = openOrganizer(db,...modules,hooks);
    const today = params => organizer.today(new URLSearchParams(params));
    const cold = await today();
    assert.equal(cold.assumedMinutes,15);
    assert.match(cold.budgetBasis,/未知/);
    assert.equal(cold.items.length,2);
    const oneHand = await today({mode:'one-hand'});
    const fixedPack = oneHand.items[0].candidate;
    assert.equal(oneHand.budgetMinutes,3);
    assert.equal(oneHand.totalMinutes,3);
    assert.equal(fixedPack.input,'tap');
    const save = (requestId,data,prior) => organizer.rule({requestId:'today-'+requestId,data,id:prior?.id,expectedRev:prior?.rev ?? null});
    const packLock = await save('filter-lock',{kind:'lock',date:oneHand.day,activityId:fixedPack.id});
    const fifteen = await today({mode:'one-hand',duration:'15min'});
    const longer = await today({duration:'45min+'});
    assert.equal(fifteen.budgetMinutes,15); assert.ok(fifteen.items.every(i=>i.candidate.input==='tap'));
    assert.equal(longer.assumedMinutes,45); assert.deepEqual(longer.items,[]);
    assert.deepEqual(longer.protectedItems,[fixedPack]);
    await assert.rejects(()=>today({duration:'bad'}),{status:400});
    const handle = createCommandHandler(db,{modules,hooks});
    let n = 10;
    const req = (type,input,actor='learner')=>({learner,type,input,actor,purpose:'storage',id:String(++n).padStart(26,'0')});
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
    const correctedExam = await save('correct-scope',{kind:'exam',date:'2026-11-25',scope:['本人锁定'],weights:[]},exam);
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
      const submission = {requestId:'today-probe-'+completed,id,rev,choice:0,consent:'teaching'};
      const receipt = await organizer.submit(submission);
      if (completed === 0) {
        const card = await organizer.open(new URLSearchParams({kind,id,rev}));
        assert.ok(card.prompt && card.choices.length===3 && !('correct' in card));
        const checked = card.choices.map((_,i)=>checkPack(id,rev,i));
        assert.equal(checked.filter(a=>a.result==='correct').length,1);
        await assert.rejects(()=>organizer.submit({...submission,rev:rev+1}),{status:400});
        assert.deepEqual(await organizer.submit(submission),receipt);
        const saved = await read(receipt.id,'teaching');
        assert.deepEqual(saved.value,{...checked[0].record,submittedAt:new Date().toISOString(),
          offlinePack:{id,rev,choice:0,result:checked[0].result}});
      }
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
    const date = '2026-11-29', {timeZone} = base;
    const paperCandidate = resumed.items[0].candidate;
    const warmup = {kind:'lock',date,activityId:paper,warmup:{timeZone,open:paperCandidate.open}};
    await save('next-ordinary-lock',{kind:'lock',date,activityId:pinned});
    const anchor = await save('next-warmup',warmup);
    await assert.rejects(save('warmup-stale',{...warmup,warmup:{timeZone,open:{...paperCandidate.open,rev:2}}},anchor), /热身活动版本已变化/);
    const protectedIds = async params => (await today(params)).protectedItems.map(c=>c.id);
    assert.deepEqual(await protectedIds(),[]);
    t.mock.timers.setTime(Date.parse(date+'T05:00:00Z'));
    assert.deepEqual(await protectedIds({timeZone:'UTC'}),[pinned]);
    const split = planToday({...base,now:new Date().toISOString(),candidates:[paperCandidate],
      constraints:{...noLocks,locks:[paper]}, rules:[warmup, ...[[900,901],[920,922]].map(([start,end])=>({kind:'window',weekday:null,start,end}))]});
    assert.deepEqual([split.warmup, split.protectedItems.map(c=>c.id)], [null, [paper]]);
    const tomorrow = await today();
    assert.deepEqual(tomorrow.protectedItems.map(c=>c.id),[paper,pinned]);
    assert.ok(!tomorrow.shortlist.includes(paper));
    const restDay = await save('next-rest',{kind:'rest',date});
    assert.deepEqual(await protectedIds(),[pinned]);
    await assert.rejects(save('warmup-late',warmup,anchor), /热身日期已变化/);
    await save('resume-next-day', null, restDay);
    assert.deepEqual(await protectedIds(),[paper,pinned]);
    await save('warmup-clear',null,anchor);
    assert.deepEqual(await protectedIds(),[pinned]);
    await handle(req('activity.setStudyGoal',{id:goalId,data:{text:'读图'}}));
    const proposed = req('plan.setGoalStatus',{id:goalId,expectedRev:1,status:'paused'},'companion');
    assert.equal((await handle(proposed)).state,'proposed');
    assert.equal((await read(goalId)).value.status,'active');
    await handle.decideProposal({...req(proposed.type,{}),proposalId:proposed.id,selection:true},(_,input)=>input);
    assert.equal((await read(goalId)).value.status,'paused');
    const deriver = modules[1].derivers.get('plan/today');
    const input = {...base,constraints:noLocks,candidates:[make('graph',8,.9,{goalId})]};
    for (const [i,status] of ['active','completed','exited'].entries()) {
      await handle(req('plan.setGoalStatus',{id:goalId,expectedRev:i+2,status}));
      const fromFacts = await gatherSnapshot(db,{learner,purpose:'storage'},ctx=>deriver.gather(ctx,async ({read})=>{
        const [goal,rule] = await Promise.all([goalId,exam.id].map(id=>read.fact(id,{mode:'following'})));
        return {...input,goal:{id:goalId,...goal.value},rules:[rule.value]};
      }));
      assert.deepEqual(fromFacts.plan.effects,[]);
      assert.deepEqual(fromFacts.manifest.inputs.map(w=>w.id).sort(),[goalId,exam.id].sort());
      assert.deepEqual(fromFacts.manifest.inputs.map(w=>w.mode),['following','following']);
      const plan = deriver.derive(fromFacts.plan.data).value;
      assert.equal(plan.activeGoal,status==='active' ? goalId : null);
      assert.equal(plan.shortlist.includes('graph'),status==='active');
    }
    await assert.rejects(()=>handle(req('plan.saveRule',{id:exam.id,expectedRev:exam.rev,data:null})),/revision conflict/);
    await save('clear-exam',null,correctedExam);
    await assert.rejects(()=>read(exam.id));
  }, {postgres: false});
});
