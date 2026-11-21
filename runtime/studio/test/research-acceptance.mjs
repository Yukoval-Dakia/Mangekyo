import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { jsonHeaders, requestJson } from './acceptance-fixtures.mjs';

const base = new URL(process.argv[2]);
assert.equal(base.protocol, 'http:');
assert.equal(base.hostname, '127.0.0.1');
assert.equal(process.argv[3], '--isolated', '请使用运行着 Web 和 Worker 的独立空学习库。');
async function api(path, method = 'GET', data, status = 200) {
  const response = await requestJson(new URL('/api/' + path, base), data && { requestId: randomUUID(), ...data }, {
    method, headers: { ...jsonHeaders, connection: 'close' },
  });
  assert.equal(response.status, status, path);
  return response.json();
}

const settings = 'research/settings';
assert.deepEqual(await api(settings), { enabled: false, revision: 0, paidBudget: 0 });
const paper = await api('papers', 'POST', { title: '矩形面积', questions: [
  { kind: 'numeric', prompt: '长 6 厘米、宽 4 厘米，面积是多少平方厘米？', answer: 24, tolerance: 0 },
] }, 201);
const questionId = paper.questions[0].id;
const attempts = 'papers/' + paper.id + '/attempts';
const { attempts: [attempt] } = await api(attempts, 'POST', { answers: { [questionId]: '20' } });
const path = attempts + '/' + attempt.id + '/research';
await api(path + '-permission', 'PUT', { revision: 1, allowed: true });
assert.deepEqual(await api(path), { worksheet: null });
await api(settings, 'PUT', { revision: 0, enabled: true });
let view;
for (let i = 0; i < 30 && !view?.failure; i++) {
  await delay(500);
  view = await api(path);
}
assert.deepEqual(view, { worksheet: null, failure: 'model_unavailable' });
assert.deepEqual(await api(path), view);
await api(path + '/' + paper.id + '/source', 'GET', undefined, 404);
await api(path + '-permission', 'PUT', { revision: 2, allowed: false });
assert.deepEqual(await api(path), { worksheet: null });
console.log(JSON.stringify(view, null, 2));
