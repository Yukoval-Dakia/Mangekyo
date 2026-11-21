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
  const next = {...base,now:'2026-11-18T15:01:00Z',constraints:{budget_min:20,locks:[],deadlines:[]}};
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
  const exam = {kind:'exam',date:'2026-11-25',scope:['graph'],weights:[{topic:'graph',weight:80}]};
  for (const [day,campaign] of [['17','steady'],['18','sprint'],['26','recovery']]) {
    const p = planToday({...next,now:'2026-11-'+day+'T11:00:00Z',rules:[exam],candidates});
    assert.equal(p.campaign,campaign);
    if (campaign==='recovery') assert.ok(p.items.every(i=>i.candidate.kind==='recovery'));
  }
  const examScope = {...exam,scope:['graph','formula'],weights:[{topic:'graph',weight:50},{topic:'formula',weight:50}]};
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
  const returning = planToday({...next,lastOpenedAt:'2026-10-27T11:00:00Z',candidates:[
    make('weak',4,.2,{kind:'probe',retention:.2}),make('uncertain',6,1,{kind:'probe'}),make('stable',6,0,{retention:.9})]});
  assert.deepEqual(ids(returning),['uncertain','weak']);
  assert.deepEqual(returning.overview,{retained:['stable'],faded:['weak'],unknown:['uncertain']});
  const localRules = [...[school],{kind:'defer',activityId:'graph',until:'2026-11-20'},
    {kind:'replace',activityId:'convert',replacementId:'units',date:before.day}];
  assert.deepEqual(ids(planToday({...base,candidates,rules:localRules})),['units']);
  assert.deepEqual(ids(planToday({...base,candidates,rules:[{kind:'rest',date:before.day}]})),[]);
  assert.deepEqual(planToday({...base,candidates,rules:[{kind:'rest',date:before.day}]}).protectedItems,[fixed]);
  assert.equal(planToday({...base,candidates,rules:[{kind:'rest',date:before.day}]}).conflicts.length,1);
});

test('空库使用内置包，真实内核回执、本人确认、旧版本冲突及记录重读',async()=>{
  const learner = '00000000000000000000000001', goalId = '00000000000000000000000002', ruleId = '00000000000000000000000003';
  await withLearnerDatabase(learner, async db => {
    const modules = await Promise.all(['..','../../activity'].map(p=>loadModuleDirectory(fileURLToPath(new URL(p+'/',import.meta.url)))));
    await db.query('INSERT INTO learners(id) VALUES($1)',[studioLearner]);
    const organizer = openOrganizer(db,modules[1],modules[0],{onFactsChanged:async()=>{}});
    const today = params => organizer.today(new URLSearchParams(params));
    const oneHand = await today({mode:'one-hand'});
    const fixedPack = oneHand.items[0].candidate;
    assert.equal(oneHand.budgetMinutes,3);
    assert.equal(fixedPack.input,'tap');
    await organizer.rule({requestId:'filter-lock',expectedRev:null,data:{kind:'lock',date:oneHand.day,activityId:fixedPack.id}});
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
    const deriver = modules[0].derivers.get('plan/today');
    const input = {...base,constraints:{budget_min:20,locks:[],deadlines:[]},candidates:[]};
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
