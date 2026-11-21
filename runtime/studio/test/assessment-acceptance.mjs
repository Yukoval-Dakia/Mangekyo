import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { studioJsonApi } from './acceptance-fixtures.mjs';

const studio = new URL(process.argv[2] ?? 'http://127.0.0.1:4317');
if (studio.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(studio.hostname) || process.argv[3] !== '--live') {
  throw new Error('请指定本机 Studio 地址并加 --live。这项验收会新建一份试卷、提交作答，并调用当前模型。');
}
const api = studioJsonApi(studio);

const settings = await api('settings');
const providerId = settings.routes?.assessment ?? settings.activeProviderId;
const provider = settings.providers.find(profile => profile.id === providerId);
assert.ok(provider);
const route = {providerId, protocol: provider.protocol, model: provider.model,
  baseUrl: provider.baseUrl, reasoningEffort: provider.reasoningEffort};
const paper = await api('papers', {
  requestId: randomUUID(), title: '矩形的面积与周长', materialId: null,
  questions: [{kind: 'rubric', prompt: '矩形长 293 厘米，宽 137 厘米。算出面积和周长。',
    rubric: '用 Python 独立核对面积和周长。面积正确得 2 分，周长正确得 1 分。总分 3 分。只对一项为部分正确。'}],
});
const question = paper.questions[0];
assert.ok(!('rubric' in question));
const path = 'papers/' + paper.id;
const answer = '面积为 40141 平方厘米，周长为 440 厘米。';
const {attempts: [attempt]} = await api(path + '/attempts', {requestId: randomUUID(), answers: {[question.id]: answer}});
assert.equal(attempt.feedback[0].result, 'pending');
const target = path + '/attempts/' + attempt.id + '/assessments';
const consent = {requestId: randomUUID(), questionId: question.id, providerBaseUrl: provider.baseUrl, route, consent: 'send-question-answer-rubric'};
const graded = await api(target, consent);
const assessment = graded.attempts[0].assessments[0];
assert.equal(assessment.requestedModel, provider.model);
assert.equal(assessment.providerId, providerId);
assert.equal(assessment.providerProtocol, provider.protocol);
assert.equal(assessment.verdict, 'partial');
assert.deepEqual(assessment.score, {earned: 2, maximum: 3});
assert.ok(assessment.evidence.length && assessment.evidence.every(quote => answer.includes(quote)));
assert.ok(assessment.trace.some(trace => trace.includes('Python') && trace.includes('860')));
assert.deepEqual((await api(target, consent)).attempts[0].assessments, [assessment]);
assert.deepEqual((await api(path)).attempts[0].assessments, [assessment]);
assert.ok((await api('review')).some(entry => entry.paperId === paper.id));
console.log(JSON.stringify({url: new URL('/papers/' + paper.id, studio), assessment}, null, 2));
