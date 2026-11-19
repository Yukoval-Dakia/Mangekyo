import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

const base = new URL(process.argv[2] ?? '');
if (base.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(base.hostname))
  throw new Error('请指定本机隔离的学习工作区地址。这项验收会交一份新卷并调用已授权的同伴模型。');
const evidencePath = process.argv[3];
const name = '均速练习 ' + randomUUID().slice(0,8);
const signature = randomUUID().slice(0,8);
const evidence = {name, rounds:[]};
async function api(path, body, method = 'POST') {
  const response = await fetch(new URL('/api/' + path,base), body === undefined ? {} : {
    method, headers:{'content-type':'application/json'}, body:JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok,path + ' ' + response.status + ' ' + JSON.stringify(data));
  return data;
}
async function chat(question) {
  let session = await api('sessions',{caseId:'companion',requestId:randomUUID(),question});
  const row = {session:session.id, question};
  evidence.rounds.push(row);
  const until = Date.now()+900_000;
  while (session.status === 'pending' && Date.now() < until) {
    await delay(1000);
    session = await api('sessions/'+session.id);
  }
  Object.assign(row,{status:session.status, error:session.error, turn:session.turns?.at(-1)});
  assert.equal(session.status,'ready',JSON.stringify(row));
  return row.turn;
}
try {
  const settings = await api('settings');
  const {providers} = await api('workspace/access/providers');
  const selected = providers.find(p => p.id === (settings.routes?.companion || settings.activeProviderId));
  assert.ok(selected?.authorized,'请在本机测试实例的设置中为同伴提供方开放学习工作区。');
  const paper = await api('papers',{requestId:randomUUID(),title:name,questions:[
    {kind:'exact',prompt:'30 与 60 公里/小时各行驶一小时。写出全程均速及依据。',answers:['45'],selfCheck:true},
  ]});
  const graded = await api('papers/'+paper.id+'/attempts',{requestId:randomUUID(),
    answers:{[paper.questions[0].id]:'总路程 30+60=90，总时间 2 小时，所以 90÷2=45。我的草稿签名 '+signature}});
  const id = graded.attempts[0].id;
  const route = 'workspace/access/records/'+id;
  const initial = await api(route);
  await api(route,{enabled:true,expectedRev:initial.rev},'PUT');
  evidence.attempt = {id,signature};
  const observation = await chat('找到「'+name+'」的原始作答，告诉我草稿签名。根据这份列式保存一条关联原答的学情观察。');
  assert.ok(observation.reads.some(r => r.id === id) && observation.message.includes(signature));
  const records = await Promise.all((observation.writes ?? []).map(w => api('workspace/access/records/'+w.id)));
  assert.ok(records.some(r => r.kind === 'observation' && r.related.some(ref => ref.id === id)));
  const work = await chat('围绕「'+name+'」新建一道不等时长的题，保存题面与解答；再写一页我的方法笔记，链接新题。');
  const entries = await Promise.all((work.writes ?? []).map(w => api('workspace/access/records/'+w.id)));
  const question = entries.find(e => e.kind === 'question');
  assert.ok(question?.question);
  assert.ok(entries.some(e => e.kind === 'page' && e.related.some(ref => ref.id === question.id)));
  const current = await api(route);
  await api(route,{enabled:false,expectedRev:current.rev},'PUT');
  const after = await chat('我撤回了「'+name+'」的原作。请找出那次草稿签名，如果无法找到就告诉我。');
  assert.ok(!JSON.stringify(after).includes(signature));
  console.log('已核对跨会话的真实作答、学情观察、题目、教材页与撤权。');
} catch (error) {
  evidence.failure = String(error);
  throw error;
} finally {
  if (evidencePath) await writeFile(evidencePath,JSON.stringify(evidence,null,2)+'\n');
}
