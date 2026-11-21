import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { requestJson, waitForSession } from './acceptance-fixtures.mjs';

const base = 'http://127.0.0.1:' + (process.env.MANGEKYO_PORT || 4317) + '/api/sessions';
const args = process.argv.slice(2);
const live = args.length === 1 && args[0] === '--live';
if (!live && (args.length !== 2 || args.some(id => !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)))) {
  throw new Error('传入独立作答、看过例题两份会话 ID 可只读复验。传入 --live 会新建会话并调用所配置的模型。');
}
async function api(path, input) {
  const response = await requestJson(base + path, input && { ...input, requestId: randomUUID() });
  if (!response.ok) throw new Error('教研室 HTTP ' + response.status);
  return response.json();
}
async function completed(pending) {
  const session = await waitForSession(pending, id => api('/' + id), 1500, 20 * 60_000);
  console.log(JSON.stringify(session, null, 2));
  assert.equal(session.status, 'ready', session.error || session.id);
  return session;
}
for (const [index, caseId] of ['independent', 'workedExample'].entries()) {
  const session = live ? await completed(await api('', { caseId })) : await api('/' + args[index]);
  if (!live) console.log(JSON.stringify(session, null, 2));
  assert.equal(session.caseId, caseId);
  const first = session.turns[0];
  const history = first.reads.find(item => item.id === 'work-01');
  const origin = index === 0 ? '学生独立作答、提交后才打开反馈' : '学生在完整例题下填答，没有留下独立列式';
  assert.ok(history?.text.includes(origin) && first.evidenceIds.includes(history.id), '须读取并引用本案对应的原作');
  assert.ok(first.rationale && first.message);
  assert.equal(first.action, index === 0 ? 'transfer_question' : 'diagnostic_question');
  if (index === 1) {
    const result = live ? await completed(await api('/' + session.id + '/answers', {
      parentId: session.currentTurnId,
      answer: '我用的算法就是把两段速度直接加起来除以二，无论骑多久都一样，所以我答 45。',
    })) : session;
    assert.ok(result.turns[1]?.answer, '须有第二轮真实作答');
    assert.equal(result.turns[1].action, 'targeted_explanation');
    assert.notEqual(result.turns[1].message, first.message);
  }
}
console.log('通过：同答 45 的两份历史得到不同教学，追答触发针对性讲解。');
