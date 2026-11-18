import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const url = new URL(process.argv[2] ?? '');
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
  throw Error('请指定本机测试实例地址。这项验收会创建材料、笔记、计划和两份作答记录。');
const route = path => new URL('/api/' + path, url);
async function api(path, data) {
  const response = await fetch(route(path), data && {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const value = await response.json();
  assert.ok(response.ok, path + ' ' + response.status + ' ' + JSON.stringify(value));
  return value;
}
const importKey = randomUUID();
const materialText = '海边观测日记\n' + '晴天天气记录。'.repeat(600) + '\n最末一页：夜间陆地降温较快。';
const form = new FormData();
form.set('requestId', importKey);
form.set('title', '海边观测日记');
form.set('file', new File([materialText], 'coast.md', {type:'text/markdown'}));
const ingest = await fetch(route('intake'), {method:'POST', body:form});
assert.equal(ingest.status, 201);
const material = await ingest.json();
assert.equal(material.fullText, materialText);
assert.equal((await api('materials/' + material.id + '/reading')).text, materialText);
assert.equal(await (await fetch(route('materials/'+material.id+'/original'))).text(), materialText);
const edit = {text:materialText+'\n校对了风向。', requestId:randomUUID(), expectedRev:material.revision};
assert.equal((await api('materials/'+material.id+'/correction', edit)).revision, material.revision+1);
assert.equal((await api('materials/'+material.id+'/correction', edit)).revision, material.revision+1);
const outdated = await fetch(route('materials/'+material.id+'/correction'), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...edit,requestId:randomUUID(),text:'旧页面更正'})});
assert.equal(outdated.status, 409);

const draft = { title:'海岸温差', materialId:material.id, requestId:randomUUID(), questions:[
  {kind:'numeric',prompt:'21 和 17 摄氏度相差多少？',answer:4,tolerance:0.1,unit:'℃'},
  {kind:'exact',prompt:'白天近地面从海洋吹向陆地的风叫什么？',answers:['海风','海洋风']},
  {kind:'exact',prompt:'解释白天海风的形成。',answers:['陆地升温更快'],selfCheck:true}
]};
const [paper,duplicate] = await Promise.all([api('papers',draft),api('papers',draft)]);
assert.equal(paper.id, duplicate.id);
const path = 'papers/'+paper.id;
const sheet = await api(path+'/print');
assert.equal(sheet.questions.length,3);
for (const q of sheet.questions) assert.ok(!('answer' in q || 'answers' in q || 'explanation' in q));
const ids = paper.questions.map(q => q.id);
function submission(values) {return {requestId:randomUUID(), answers:Object.fromEntries(ids.map((id,i)=>[id,values[i]]))};}
const wrong = submission(['3','海洋风','海上和陆地升温速度不同']);
const [graded,retry] = await Promise.all([api(path+'/attempts',wrong),api(path+'/attempts',wrong)]);
assert.equal(retry.attempts.length,1);
assert.deepEqual(graded.attempts[0].feedback.map(f=>f.result), ['incorrect','correct','self-check']);
assert.equal(graded.attempts[0].total,2);
assert.equal((await api('review')).filter(i=>i.paperId===paper.id).length,1);
const corrected = await api(path+'/attempts',submission(['4.05',null,null]));
assert.equal(corrected.attempts.length,2);
assert.equal(corrected.attempts[0].feedback[1].expected,null);
assert.equal(corrected.attempts[0].feedback[1].explanation,null);
assert.equal((await api('review')).filter(i=>i.paperId===paper.id).length,0);

const note = await api('organizer/notes',{requestId:randomUUID(),title:'夜间观测',markdown:'陆地很快变凉。',materialId:material.id});
const next = await api('organizer/notes',{requestId:randomUUID(),id:note.id,expectedRev:note.rev,title:'夜间观测',markdown:'比较海陆温差。',materialId:material.id});
await api('organizer/notes',{requestId:randomUUID(),id:note.id,expectedRev:next.rev,restoreRev:note.rev});
const task = await api('organizer/tasks',{title:'重做海岸温差',date:'2026-11-20',requestId:randomUUID()});
const done = await api('organizer/tasks',{id:task.id,expectedRev:task.rev,done:true,requestId:randomUUID()});
await api('organizer/tasks',{id:task.id,expectedRev:done.rev,done:false,requestId:randomUUID()});
const result = await api('organizer');
const restored = result.notes.find(n=>n.id===note.id);
assert.equal(restored.versions.length,3);
assert.equal(restored.markdown,'陆地很快变凉。');
assert.equal(restored.source.id,material.id);
assert.equal(result.tasks.find(t=>t.id===task.id).done,false);
console.log('已验证原件和全文、更正冲突、并发重试、打印卷面、错题重做、笔记版本和学习计划。');
