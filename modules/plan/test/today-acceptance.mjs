import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gatherSnapshot } from '../../../kernel/src/derivations/gather.ts';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createCommandReadContext } from '../../../kernel/src/commands/reads.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { openOrganizer } from '../../../runtime/studio/organizer.ts';
import { studioLearner } from '../../../runtime/studio/identity.ts';
import { loadStudioTestModule } from '../../../runtime/studio/test/modules.ts';
import {
  applyCandidateInformation, planToday, projectFreshMaterialCandidates, projectPendingCorrectionCandidates, sessionRule,
} from '../today.ts';
import { checkPack } from '../offline-pack.ts';

const base = {now:'2026-11-18T11:00:00Z', timeZone:'Asia/Tokyo', constraints:{budget_min:20,locks:['fixed'],deadlines:[]}};
const noLocks = {...base.constraints, locks:[]};
const make = (id, minutes, information, props={})=>({id, title:id, topic:id, kind:'review', minutes, information, durationBasis:'冻结课堂估时',
  input:'write', open:{kind:'activity',id,rev:1}, reason:'读图独立检验', evidence:['fixture/'+id], delayImpact:'推迟独立检验', ...props});
const fixed = make('fixed',4,0);
const candidates = [fixed,make('convert',8,1),make('graph',8,.9),make('units',8,.4)];
const school = {kind:'schoolwork',topic:'convert',date:'2026-11-19',minutes:12};
const ids = plan=>plan.items.map(i=>i.candidate.id);

const pendingSource = (paperId, overrides={}) => ({
  paperId, paperRev:1, attemptId:paperId+'-attempt', attemptRev:1, title:'函数小测',
  submittedAt:'2026-11-18T09:00:00Z',
  items:[{itemId:'q1',outcome:'incorrect',source:'attempt',corrected:false,evidenceRef:'ev/q1'}],
  ...overrides,
});

test('已提交试卷的待订正题项自动流向今天并尊重主权与闭环退场',()=>{
  const source = pendingSource('paper-1',{items:[
    {itemId:'q1',outcome:'incorrect',source:'attempt',corrected:false,evidenceRef:'ev/q1'},
    {itemId:'q2',outcome:'partial',source:'rubric',corrected:false,evidenceRef:'ev/q2r'},
    {itemId:'q3',outcome:'incorrect',source:'attempt',corrected:true,evidenceRef:'ev/q3'},
  ]});
  const [correction] = projectPendingCorrectionCandidates([source]);
  assert.equal(correction.id,'correction:paper-1@1');
  assert.equal(correction.title,'函数小测 · 错题订正');
  assert.deepEqual([correction.kind,correction.minutes,correction.open],['review',6,{kind:'activity',id:'paper-1',rev:1}]);
  assert.equal(correction.reason,'上次作答有 1 道错题与 1 道部分正确待订正。');
  assert.deepEqual(correction.pendingCorrection,{incorrectCount:1,partialCount:1,itemIds:['q1','q2'],attemptId:'paper-1-attempt',attemptRev:1});
  assert.ok(correction.evidence.includes('paper-1-attempt@1') && correction.evidence.includes('ev/q2r'));
  // 同一 itemId 多来源合并：attempt 的 incorrect 不被 rubric 的 partial 软化。
  const merged = projectPendingCorrectionCandidates([pendingSource('paper-m',{items:[
    {itemId:'q1',outcome:'partial',source:'rubric',corrected:false,evidenceRef:'ev/q1r'},
    {itemId:'q1',outcome:'incorrect',source:'attempt',corrected:false,evidenceRef:'ev/q1a'},
  ]})])[0];
  assert.deepEqual([merged.pendingCorrection.incorrectCount,merged.pendingCorrection.partialCount],[1,0]);
  assert.ok(merged.evidence.includes('ev/q1a') && merged.evidence.includes('ev/q1r'));
  // 同卷多次提交按最新 submittedAt 去重，不触发重复身份；旧 attempt 不另出候选。
  const dup = projectPendingCorrectionCandidates([
    pendingSource('paper-d',{attemptId:'old-attempt',submittedAt:'2026-11-17T09:00:00Z'}),
    pendingSource('paper-d',{attemptId:'new-attempt',attemptRev:2,submittedAt:'2026-11-18T09:00:00Z'}),
  ]);
  assert.equal(dup.length,1);
  assert.equal(dup[0].pendingCorrection.attemptId,'new-attempt');
  const plan = planToday({...base,constraints:noLocks,candidates:[...dup,make('stale-paper',8,1)]});
  assert.equal(ids(plan)[0],'correction:paper-d@1');
  assert.match(plan.items[0].why.join(' '),/未订正/);
  // 订正加权稳居静态示例包之上；全部订正后自动退场并诚实降级。
  const withPack = planToday({...base,constraints:noLocks,candidates:projectPendingCorrectionCandidates([source])});
  assert.equal(ids(withPack)[0],'correction:paper-1@1');
  const cleared = projectPendingCorrectionCandidates([pendingSource('paper-1',{
    items:[{itemId:'q1',outcome:'incorrect',source:'attempt',corrected:true,evidenceRef:'ev/q1'}]})]);
  assert.equal(cleared.length,0);
  const fallback = planToday({...base,constraints:noLocks,candidates:cleared});
  assert.ok(ids(fallback).every(id=>id.startsWith('pack/')));
  // 主权：defer/rest 生效，订正候选不越权。
  const deferred = planToday({...base,constraints:noLocks,candidates:dup,
    rules:[{kind:'defer',activityId:'correction:paper-d@1',until:'2026-11-20'}]});
  assert.ok(!ids(deferred).includes('correction:paper-d@1'));
  const rested = planToday({...base,constraints:noLocks,candidates:dup,rules:[{kind:'rest',date:'2026-11-18'}]});
  assert.equal(ids(rested).length,0);
  // 6 题以上大错题集估时封顶 15 分钟，适配默认预算未知(15 分钟)而不回落示例包。
  const big = projectPendingCorrectionCandidates([pendingSource('paper-6',{items:Array.from({length:6},(_,i)=>({
    itemId:'q'+(i+1),outcome:'incorrect',source:'attempt',corrected:false,evidenceRef:'ev/q'+(i+1)}))})]);
  assert.deepEqual([big[0].minutes,ids(planToday({...base,constraints:{...noLocks,budget_min:null},candidates:big}))[0]],[15,'correction:paper-6@1']);
  // 非法输入与非法摘要被拒绝。
  assert.throws(()=>projectPendingCorrectionCandidates([pendingSource('bad',{paperRev:0})]),/超出范围/);
  assert.throws(()=>projectPendingCorrectionCandidates([pendingSource('bad',{items:[{itemId:'q',outcome:'correct',source:'attempt',corrected:false,evidenceRef:'e'}]})]),/结果无效/);
  assert.throws(()=>planToday({...base,candidates:[make('x',5,0,{pendingCorrection:{incorrectCount:0,partialCount:0,itemIds:['q'],attemptId:'a',attemptRev:1}})]}),/订正汇总为空/);
  assert.throws(()=>planToday({...base,candidates:[make('x',5,0,{pendingCorrection:{incorrectCount:2,partialCount:0,itemIds:['q1','q1'],attemptId:'a',attemptRev:1}})]}),/汇总不一致/);
  assert.throws(()=>planToday({...base,candidates:[make('x',5,0,{pendingCorrection:{incorrectCount:1,partialCount:0,itemIds:['q1','q2'],attemptId:'a',attemptRev:1}})]}),/汇总不一致/);
});

test('新交入真实材料自动浮现今天、低于待订正高于示例包并尊重退场与主权',()=>{
  const fresh = projectFreshMaterialCandidates([
    {id:'mat-plain',rev:1,title:'高二物理电磁感应卷',savedAt:'2026-11-18T10:00:00Z',hasDerivedActivity:false,questionCount:8},
    {id:'mat-red',rev:2,title:'高二数学期中错题卷',savedAt:'2026-11-18T09:00:00Z',hasDerivedActivity:false,questionCount:10,redPenErrorCount:2},
    {id:'mat-red',rev:1,title:'旧版',savedAt:'2026-11-18T08:00:00Z',hasDerivedActivity:false},
    {id:'mat-derived',rev:1,title:'已衍生练习卷',savedAt:'2026-11-18T10:30:00Z',hasDerivedActivity:true},
    {id:'mat-stale',rev:1,title:'超窗旧材料',savedAt:'2026-11-03T10:59:59Z',hasDerivedActivity:false},
    {id:'mat-future',rev:1,title:'未来时间材料',savedAt:'2026-11-18T12:00:00Z',hasDerivedActivity:false},
  ], base.now);
  assert.deepEqual(fresh.map(c=>c.id),['material:mat-plain@1','material:mat-red@2']);
  const [plain, red] = fresh;
  assert.deepEqual([plain.title,plain.open,plain.minutes,plain.evidence],
    ['梳理刚交入的《高二物理电磁感应卷》',{kind:'material',id:'mat-plain',rev:1},8,['material:mat-plain@1']]);
  assert.deepEqual([red.title,red.open,red.minutes],
    ['复盘刚拍《高二数学期中错题卷》里的 2 道错题',{kind:'material',id:'mat-red',rev:2},8]);
  // 预算未知(默认 15 分钟)下真实新材料取代静态示例包，且带红笔错题优先于普通新材料。
  const defaultToday = planToday({...base,constraints:{...noLocks,budget_min:null},candidates:fresh});
  assert.deepEqual(ids(defaultToday),['material:mat-red@2']);
  assert.ok(defaultToday.items.every(i=>!i.candidate.id.startsWith('pack/')));
  assert.match(defaultToday.items[0].why.join(' '),/错题标记/);
  // 优先级严格：pendingCorrection > freshMaterial(红笔) > freshMaterial(普通) > pack/*。
  const [correction] = projectPendingCorrectionCandidates([pendingSource('paper-c')]);
  const ranked = planToday({...base,constraints:{...noLocks,budget_min:30},candidates:[correction,...fresh]});
  assert.deepEqual(ids(ranked),['correction:paper-c@1','material:mat-red@2','material:mat-plain@1']);
  // 全部衍生后自动退场回落示例包；defer/replace/rest 主权完整生效。
  const retired = projectFreshMaterialCandidates([
    {id:'mat-plain',rev:1,title:'高二物理电磁感应卷',savedAt:'2026-11-18T10:00:00Z',hasDerivedActivity:true},
  ], base.now);
  assert.equal(retired.length,0);
  assert.ok(ids(planToday({...base,constraints:noLocks,candidates:retired})).every(id=>id.startsWith('pack/')));
  assert.ok(!ids(planToday({...base,constraints:noLocks,candidates:fresh,
    rules:[{kind:'defer',activityId:'material:mat-red@2',until:'2026-11-20'}]})).includes('material:mat-red@2'));
  assert.deepEqual(ids(planToday({...base,constraints:noLocks,candidates:fresh,
    rules:[{kind:'replace',activityId:'material:mat-red@2',replacementId:'material:mat-plain@1',date:'2026-11-18'}]})),
    ['material:mat-plain@1']);
  assert.equal(ids(planToday({...base,constraints:noLocks,candidates:fresh,rules:[{kind:'rest',date:'2026-11-18'}]})).length,0);
  // 非法输入与非法摘要被拒绝。
  assert.throws(()=>projectFreshMaterialCandidates([{id:'m',rev:0,title:'x',savedAt:base.now,hasDerivedActivity:false}],base.now),/超出范围/);
  assert.throws(()=>projectFreshMaterialCandidates([{id:'m',rev:1,title:'x',savedAt:base.now,hasDerivedActivity:'no'}],base.now),/衍生状态无效/);
  assert.throws(()=>planToday({...base,candidates:[make('x',5,0,{freshMaterial:{savedAt:'bad'}})]}),/需要带时区的时间/);
});

test('固定周三晚，明日作业取消时仅重排未开始项；跨日、长假和三战役',()=>{
  assert.equal(planToday({...base,constraints:{...noLocks,budget_min:0},candidates:[]}).items.length,0);
  const before = planToday({...base,candidates,rules:[school]});
  const after = planToday({...base,candidates});
  const screened = planToday({...base,candidates:applyCandidateInformation(candidates, [], [{ref:'convert'}, {ref:'fixed'}])});
  for (const [plan, expected] of [[before, ['graph','units']], [after, ['convert','graph']], [screened, ['graph','units']]])
    assert.deepEqual(ids(plan),expected);
  assert.deepEqual([before.protectedItems,before.totalMinutes,before.tradeoffs[0].activityId],[after.protectedItems,20,'convert']);
  const draft = make('draft',4,0,{state:'in-progress',date:before.day,draftRef:'draft@5'});
  const next = {...base,now:'2026-11-18T15:01:00Z',constraints:noLocks};
  const session = sessionRule(base.now,base.timeZone,3,'tired');
  assert.equal(session.expiresAt,'2026-11-18T15:00:00.000Z');
  const one = planToday({...next,candidates:applyCandidateInformation(candidates, [], [{ref:'pack/reading'}]),mode:'one-hand'});
  assert.ok(!one.shortlist.includes('pack/reading'));
  const long = {...next,candidates:[make('forty-four',44,1),make('forty-five',45,1),make('hour',60,1,{input:'voice'})],
    constraints:{...noLocks,budget_min:60},duration:'45min+'};
  for (const [mode,expected] of [['any',['forty-five','hour']],['voice',['hour']],['one-hand',[]]])
    assert.deepEqual(planToday({...long,mode}).shortlist,expected);
  const examScope = {kind:'exam',date:'2026-11-25',scope:['weak','formula'],weights:[{topic:'weak',weight:50},{topic:'formula',weight:50}]};
  const examCandidates = [make('weak',4,.2,{kind:'probe',retention:.2,examPrep:{kind:'archetype',coveredQuestionCount:12}}),
    make('uncertain',6,1,{kind:'probe'}),make('stable',3,1,{retention:.9}),make('card',3,0,{topic:'formula',examPrep:{kind:'first-aid'}})];
  const campaignInput = {...base,candidates:examCandidates,rules:[examScope],constraints:{...noLocks,budget_min:9}};
  const sprint = planToday(campaignInput);
  assert.deepEqual(ids(sprint),['weak','card']);
  assert.match(sprint.items[0].why.join(' '),/12 道原卷题/);
  assert.deepEqual(ids(planToday({...campaignInput,rules:[examScope,{kind:'campaign',campaign:'steady'}]})),
    ['stable','uncertain']);
  const forecast = {exam:examScope,frozenAt:base.now,low:70,high:85,maximum:100,assessment:{id:'assess',rev:2},
    calibration:{id:'calibrate',rev:1},methodVersion:'calibrated@1',absoluteError:8};
  const recovery = {...next,now:'2026-11-26T11:00:00Z',rules:[examScope],frozenExamForecast:forecast,lastOpenedAt:'2026-10-26T11:00:00Z',
    candidates:[make('probe',4,1,{kind:'probe'}),make('long-review',11,1,{kind:'recovery'}),make('review',6,0,{kind:'recovery'}),make('second',5,0,{kind:'recovery'})]};
  const examScore = {submission:{id:'submitted',rev:1},forecastAssessment:forecast.assessment,
    submittedAt:'2026-11-25T11:00:00Z',score:{earned:65,maximum:100}};
  const scoredPlan = change => planToday({...recovery,examScore:{...examScore,...change}});
  const afterExam = scoredPlan({});
  assert.ok(!afterExam.shortlist.includes('probe') && !afterExam.shortlist.includes('long-review'));
  assert.deepEqual([afterExam.items.length,afterExam.scoreReview.status],[1,'below-expected-range']);
  assert.equal(scoredPlan({score:{earned:75,maximum:100}}).scoreReview.status,'within-expected-range');
  assert.equal(scoredPlan({forecastAssessment:{...forecast.assessment,rev:1}}).scoreReview.kind,'unknown');
  const returnInput = {...campaignInput,...next,lastOpenedAt:'2026-10-27T11:00:00Z'};
  const returning = planToday(returnInput);
  assert.deepEqual(ids(returning),['uncertain','weak']);
  assert.deepEqual(returning.overview,{retained:['stable'],faded:['weak'],unknown:['uncertain','formula']});
  const protectedReturn = planToday({...returnInput,candidates:[...returnInput.candidates,draft,fixed],
    constraints:base.constraints,rules:[...returnInput.rules,session]});
  assert.deepEqual([ids(protectedReturn),protectedReturn.protectedItems,protectedReturn.budgetMinutes],[[],[draft,fixed],20]);
  const localRules = [school,{kind:'defer',activityId:'graph',until:'2026-11-20'},{kind:'replace',activityId:'convert',replacementId:'units',date:before.day}];
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
    assert.match(cold.budgetBasis,/未知/);
    assert.deepEqual([cold.assumedMinutes,cold.items.length],[15,2]);
    const oneHand = await today({mode:'one-hand'});
    const fixedPack = oneHand.items[0].candidate;
    assert.deepEqual([oneHand.budgetMinutes,oneHand.totalMinutes,fixedPack.input],[3,3,'tap']);
    const save = (requestId,data,prior) => organizer.rule({requestId:'today-'+requestId,data,id:prior?.id,expectedRev:prior?.rev ?? null});
    const packLock = await save('filter-lock',{kind:'lock',date:oneHand.day,activityId:fixedPack.id});
    const fifteen = await today({mode:'one-hand',duration:'15min'});
    const longer = await today({duration:'45min+'});
    assert.equal(fifteen.budgetMinutes,15); assert.ok(fifteen.items.every(i=>i.candidate.input==='tap'));
    assert.deepEqual([longer.assumedMinutes,longer.items,longer.protectedItems],[45,[],[fixedPack]]);
    await assert.rejects(()=>today({duration:'bad'}),{status:400});
    const handle = createCommandHandler(db,{modules,hooks});
    let n = 10;
    const req = (type,input,actor='learner')=>({learner,type,input,actor,purpose:'storage',id:String(++n).padStart(26,'0')});
    const read = (id,purpose='storage')=>db.snapshot({learner},tx=>createCommandReadContext(tx,purpose).fact(id,{mode:'following'}));
    await save('clear-filter-lock',null,packLock);
    const [paper, pinned] = await Promise.all(['接着练','本人锁定'].map((title,i)=>handle(req('activity.saveWorkbookPaper',
      {id:String(20+i).padStart(26,'0'),data:{title,materialId:null,savedAt:new Date().toISOString(),
        questions:[{id:'q1',kind:'numeric',prompt:'2 + 3 = ?',answer:5,tolerance:0,unit:null,explanation:null}]}}))
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
      assert.deepEqual([view.returning,view.campaign,view.schoolMinutes,view.protectedItems.filter(c=>c.state!=='completed').map(c=>c.id),
        view.totalMinutes + view.schoolMinutes <= view.budgetMinutes,view.items.length],[true,'sprint',7,[pinned],true,1]);
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
        assert.deepEqual(saved.value,{...checked[0].record,submittedAt:new Date().toISOString(),offlinePack:{id,rev,choice:0,result:checked[0].result}});
      }
    }
    const resumed = await returning();
    assert.deepEqual(ids(resumed),[paper]);
    assert.equal(resumed.protectedItems.filter(c=>c.state==='completed').length,2);
    const rest = await save('rest',{kind:'rest',date:oneHand.day});
    const rested = await returning();
    assert.deepEqual([ids(rested),rested.protectedItems,rested.conflicts.length],[[],resumed.protectedItems,1]);
    for (const [name, receipt] of [['rest', rest], ['homework', homework], ['lock', lock]])
      await save('clear-' + name, null, receipt);
    for (const [date,campaign,expected] of [['26','recovery',['pack/reflection']],['28','steady',[paper,pinned]]]) {
      t.mock.timers.setTime(Date.parse('2026-11-'+date+'T05:00:00Z'));
      const view = await today();
      assert.deepEqual([view.campaign,ids(view).sort()],[campaign,expected.sort()]);
      if (campaign==='recovery') assert.equal(view.scoreReview.kind,'unknown');
    }
    const date = '2026-11-29';
    const paperCandidate = resumed.items[0].candidate;
    const warmup = {kind:'lock',date,activityId:paper,warmup:{timeZone:base.timeZone,open:paperCandidate.open}};
    await save('next-ordinary-lock',{kind:'lock',date,activityId:pinned});
    const anchor = await save('next-warmup',warmup);
    await assert.rejects(save('warmup-stale',{...warmup,warmup:{...warmup.warmup,open:{...paperCandidate.open,rev:2}}},anchor), /热身活动版本已变化/);
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
    assert.deepEqual([(await handle(proposed)).state,(await read(goalId)).value.status],['proposed','active']);
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
      assert.deepEqual([fromFacts.plan.effects,fromFacts.manifest.inputs.map(w=>w.id).sort(),fromFacts.manifest.inputs.map(w=>w.mode)],
        [[],[goalId,exam.id].sort(),['following','following']]);
      const plan = deriver.derive(fromFacts.plan.data).value;
      assert.deepEqual([plan.activeGoal,plan.shortlist.includes('graph')],[status==='active' ? goalId : null,status==='active']);
    }
    // 目标状态机：exited 是终态，不能复活后重新驱动自动备课；同状态幂等。
    assert.equal((await read(goalId)).value.status, 'exited');
    for (const status of ['active', 'paused', 'completed'])
      await assert.rejects(() => handle(req('plan.setGoalStatus', { id: goalId, expectedRev: 5, status })), /状态不支持/);
    await handle(req('plan.setGoalStatus', { id: goalId, expectedRev: 5, status: 'exited' }));
    const goalId2 = '00000000000000000000000003';
    await assert.rejects(() => handle(req('activity.setStudyGoal', { id: goalId2, data: { text: '绕过', status: 'paused' } })), /进行中/);
    await handle(req('activity.setStudyGoal', { id: goalId2, data: { text: '读写' } }));
    await handle(req('plan.setGoalStatus', { id: goalId2, expectedRev: 1, status: 'paused' }));
    await handle(req('plan.setGoalStatus', { id: goalId2, expectedRev: 2, status: 'completed' }));
    await assert.rejects(() => handle(req('plan.setGoalStatus', { id: goalId2, expectedRev: 3, status: 'active' })), /状态不支持/);
    await handle(req('plan.setGoalStatus', { id: goalId2, expectedRev: 3, status: 'exited' }));
    assert.equal((await read(goalId2)).value.status, 'exited');
    await assert.rejects(()=>handle(req('plan.saveRule',{id:exam.id,expectedRev:exam.rev,data:null})),/revision conflict/);
    await save('clear-exam',null,correctedExam);
    await assert.rejects(()=>read(exam.id));
    // 改进包 C 实库验收：已提交微卷的未订正错题/部分正确自动流向今天。
    const correctionPaper = await handle(req('activity.saveWorkbookPaper',
      {id:String(30).padStart(26,'0'),data:{title:'实库订正卷',materialId:null,savedAt:new Date().toISOString(),
        questions:[{id:'q1',kind:'numeric',prompt:'1 + 1 = ?',answer:2,tolerance:0,unit:null,explanation:null}]}}))
      .then(receipt => receipt.wrote[0].id+'@1');
    const attemptReceipt = await handle(req('activity.submitWorkbookAttempt',
      {id:String(31).padStart(26,'0'),data:{paperId:correctionPaper.split('@')[0],requestId:'pg-attempt-1',
        submittedAt:new Date().toISOString(),answers:{q1:'9'}}}));
    const attempt = attemptReceipt.wrote[0];
    const pendingView = projectPendingCorrectionCandidates([{
      paperId:correctionPaper.split('@')[0],paperRev:1,attemptId:attempt.id,attemptRev:attempt.rev,
      title:'实库订正卷',submittedAt:new Date().toISOString(),
      items:[{itemId:'q1',outcome:'incorrect',source:'attempt',corrected:false,evidenceRef:attempt.id+'@'+attempt.rev}],
    }]);
    assert.equal(pendingView.length,1);
    const pendingToday = planToday({...base,now:new Date().toISOString(),constraints:noLocks,candidates:pendingView});
    assert.equal(ids(pendingToday)[0],'correction:'+correctionPaper);
    assert.match(pendingToday.items[0].why.join(' '),/未订正/);
    // 订正闭环事实写入后，投影退场并诚实降级。
    await handle(req('activity.recordWorkbookCorrection',
      {id:String(32).padStart(26,'0'),data:{paperId:correctionPaper.split('@')[0],
        attempt:{id:attempt.id,rev:attempt.rev},itemId:'q1'}}));
    const clearedView = projectPendingCorrectionCandidates([{
      paperId:correctionPaper.split('@')[0],paperRev:1,attemptId:attempt.id,attemptRev:attempt.rev,
      title:'实库订正卷',submittedAt:new Date().toISOString(),
      items:[{itemId:'q1',outcome:'incorrect',source:'attempt',corrected:true,evidenceRef:attempt.id+'@'+attempt.rev}],
    }]);
    assert.equal(clearedView.length,0);
  }, {postgres: Boolean(testDatabaseUrl)});
});
