import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { studioJsonApi } from './acceptance-fixtures.mjs';

const studio = new URL(process.argv[2]);
assert.match(studio.origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/);
assert.equal(process.argv[3], '--isolated');

const api = studioJsonApi(studio, (response, path, result, status = 200) => {
  assert.equal(response.status, status, path + ' ' + JSON.stringify(result));
});

async function current(key) {
  for (let i = 0; i < 80; i++) {
    const result = await api('retention/' + key);
    if (result.state === 'current') return result;
    assert.equal(result.state, 'pending', JSON.stringify(result));
    await delay(250);
  }
  throw new Error('Retention work did not settle');
}

async function compare(reconciliationKeys) {
  const input = { requestId: randomUUID(), method: 'elapsed-independent-evidence@1', reconciliationKeys };
  const { key } = await api('retention/comparisons', input, 'POST', 202);
  for (let i = 0; i < 80; i++) {
    const result = await api('retention/comparisons/' + key);
    if (result.state === 'complete') {
      assert.deepEqual(await api('retention/comparisons', input, 'POST'), result);
      return result;
    }
    assert.equal(result.state, 'pending');
    await delay(250);
  }
  throw new Error('Retention comparison did not settle');
}

const paper = await api('papers', {
  requestId: randomUUID(), title: '冻结小卷',
  materialId: null,
  questions: [{ kind: 'exact', prompt: '三组各四枚，一共有几枚？', answers: ['12'] }],
}, 'POST', 201);
const { id: itemId } = paper.questions[0];
const path = 'papers/' + paper.id;
const grant = (id, expectedRev, enabled = true) => api(`workspace/access/records/${id}`, { expectedRev, enabled }, 'PUT');
const submit = async answer => {
  const requestId = randomUUID();
  const { attempts } = await api(path + '/attempts', { requestId, answers: { [itemId]: answer } });
  return attempts.find(attempt => attempt.requestId === requestId);
};
const prior = await submit('12');
const flags = { requestId: randomUUID(), itemId, priorAttemptIds: [prior.id],
  through: new Date(Date.now() + 60_000).toISOString() };
await api(path + '/retention', flags, 'POST', 403);
await grant(paper.id, 1);
await grant(prior.id, 1);
const { key } = await api(path + '/retention', flags, 'POST', 202);
const frozen = await current(key);
assert.ok(!(await api('retention/posttests')).items.some(item => item.forecastKey === key));
assert.match((await api('workspace/access/records/' + paper.id)).text, /答案：12/);
await api('retention/' + key + '/posttest', {}, 'POST', 422);
assert.equal(frozen.value.estimate.kind, 'unknown');
assert.deepEqual(frozen.value.method, { id: 'last-independent-result', version: '1' });
assert.equal(frozen.value.input.observations[0].exposure.kind, 'unknown');
assert.equal(frozen.value.input.observedThrough, frozen.basis.gatherTick);
assert.equal(frozen.value.input.target.paper.rev, 2);
await api('retention/' + key + '/reconcile', { attemptId: prior.id }, 'POST', 409);

const later = await submit('11');
await grant(later.id, 1);
const { key: reconciliationKey } = await api('retention/' + key + '/reconcile', { attemptId: later.id }, 'POST', 202);
const reconciled = await current(reconciliationKey);
assert.equal(reconciled.value.forecastId, frozen.derivationId);
assert.equal(reconciled.value.status, 'awaiting-independent');
assert.equal(reconciled.value.observation.result, 'incorrect');
assert.ok(BigInt(reconciled.value.observation.admittedAt) > BigInt(frozen.effectiveTick));
assert.deepEqual(await api('retention/' + key), frozen);

const invalidatedComparison = await compare([reconciliationKey]);
await grant(prior.id, 2, false);
assert.deepEqual(await api('retention/comparisons/' + invalidatedComparison.key),
  { key: invalidatedComparison.key, state: 'stale' });
for (const staleKey of [key, reconciliationKey]) {
  const stale = await api('retention/' + staleKey);
  assert.equal(stale.state, 'stale');
  assert.ok(!('value' in stale) && !('basis' in stale));
}
const sealed = await api('retention/papers', {
  requestId: randomUUID(), title: '受控冻结卷', materialId: null,
  questions: [{ kind: 'exact', prompt: '七组各三枚，一共有几枚？', answers: ['21'], explanation: '乘法参考说明' }],
}, 'POST', 201);
await api('workspace/access/records/' + sealed.id, undefined, 'GET', 404);
await api('papers/' + sealed.id + '/attempts', { requestId: randomUUID(), answers: { [sealed.itemId]: '21' } }, 'POST', 404);

async function controlled(priorAttemptIds, answer, verdict, during, through = flags.through) {
  const { key } = await api('papers/' + sealed.id + '/retention', {
    ...flags, requestId: randomUUID(), itemId: sealed.itemId, priorAttemptIds, through,
  }, 'POST', 202);
  const forecast = await current(key);
  const listed = (await api('retention/posttests')).items;
  assert.deepEqual(listed.find(item => item.forecastKey === key), {
    forecastKey: key, title: '受控冻结卷', through, state: 'ready',
  });
  const startPath = `retention/${key}/posttest`;
  const issued = await api(startPath, {});
  assert.equal(issued.forecastId, forecast.derivationId);
  assert.ok(BigInt(issued.issuedAtTick) > BigInt(forecast.effectiveTick));
  assert.deepEqual(await api(startPath, {}), issued);
  assert.doesNotMatch(JSON.stringify(issued.item), /答案|21|expected|参考说明/);
  const submitPath = `${startPath}/${issued.id}/submission`;
  await api(submitPath, { answer, coverage: 'complete' }, 'POST', 400);
  const concurrent = await during?.();
  const { attemptId, reconciliation } = await api(submitPath, { answer });
  assert.deepEqual((await api('retention/posttests')).items.find(item => item.forecastKey === key), {
    ...listed.find(item => item.forecastKey === key), state: 'submitted', reconciliationKey: reconciliation.key,
  });
  const result = await current(reconciliation.key);
  assert.deepEqual(result.value.observation.exposure, concurrent
    ? { kind: 'unknown', reason: 'incomplete-observation' } : { kind: 'independent' });
  assert.equal(result.value.forecastId, forecast.derivationId);
  assert.equal(result.value.status, verdict);
  assert.ok(BigInt(result.value.observation.admittedAt) > BigInt(issued.issuedAtTick));
  assert.equal((await api(submitPath, { answer })).attemptId, attemptId);
  await api(submitPath, { answer: '99' }, 'POST', 409);
  assert.deepEqual(await api('retention/' + key), forecast);
  return { forecast, issued, attemptId, result, concurrent };
}

const pretest = await controlled([], '21', 'observed');
const posttest = await controlled([pretest.attemptId], '20', 'missed', undefined,
  new Date(Date.now() + 21 * 86_400_000).toISOString());
assert.equal(posttest.forecast.value.estimate.expected, 'correct');
assert.equal(posttest.result.value.observation.result, 'incorrect');
await api('workspace/access/records/' + posttest.attemptId, undefined, 'GET', 404);
const overlap = await controlled([], '21', 'awaiting-independent', () => controlled([], '20', 'observed'));
const schedule = { requestId: randomUUID(), scheduledAt: new Date(Date.now() + 6_000).toISOString() };
await api(`retention/${overlap.result.key}/followup`, schedule, 'POST', 422);
const followupPath = `retention/${pretest.result.key}/followup`;
const { key: followupKey } = await api(followupPath, schedule, 'POST', 202);
const followupEntry = async () => (await api('retention/posttests')).items.find(item => item.forecastKey === followupKey);
const accepted = await followupEntry();
assert.ok(accepted.state === 'preparing' || accepted.state === 'scheduled');
assert.equal(accepted.sourceReconciliationKey, pretest.result.key);
const followup = await current(followupKey);
assert.deepEqual(await api(followupPath, schedule), { key: followupKey, state: 'current' });
assert.deepEqual(followup.value.input.target, pretest.forecast.value.input.target);
assert.deepEqual(followup.value.input.observations, [pretest.result.value.observation]);
assert.equal(followup.value.input.window.scheduledAt, schedule.scheduledAt);
assert.equal(followup.value.estimate.expected, 'correct');
const before = await followupEntry();
assert.equal(before.state, 'scheduled');
assert.equal(before.scheduledAt, schedule.scheduledAt);
assert.equal(before.sourceReconciliationKey, pretest.result.key);
const startPath = `retention/${followupKey}/posttest`;
const early = await api(startPath, {}, 'POST', 409);
assert.doesNotMatch(JSON.stringify({ before, followup, early }), /七组|乘法参考说明|"item"|"answers"/);
await delay(Math.max(0, Date.parse(schedule.scheduledAt) - Date.now()) + 20);
const ready = await followupEntry();
assert.equal(ready.state, 'ready');
assert.equal(ready.sourceReconciliationKey, pretest.result.key);
const laterIssue = await api(startPath, {});
assert.ok(laterIssue.startedAt >= schedule.scheduledAt);
assert.equal(laterIssue.item.prompt, pretest.issued.item.prompt);
const laterSubmission = await api(`${startPath}/${laterIssue.id}/submission`, { answer: '20' });
const laterResult = await current(laterSubmission.reconciliation.key);
assert.equal(laterResult.value.forecastId, followup.derivationId);
assert.equal(laterResult.value.status, 'missed');
assert.equal(laterResult.value.observation.exposure.kind, 'independent');
const submitted = await followupEntry();
assert.equal(submitted.state, 'submitted');
assert.equal(submitted.sourceReconciliationKey, pretest.result.key);
const comparison = await compare([posttest.result.key, overlap.result.key]);
const replay = comparison.value.cases.find(item => item.reconciliationId === posttest.result.derivationId);
assert.equal(comparison.value.kind, 'prospective-replay');
assert.equal(replay.forecastWatermark, posttest.forecast.value.input.observedThrough);
assert.equal(replay.observationWatermark, posttest.result.value.observedThrough);
assert.equal(replay.recorded.status, 'missed');
assert.equal(replay.shadow.status, 'observed');
assert.equal(comparison.value.recorded.coverage, 1);
assert.equal(comparison.value.shadow.coverage, 0);
assert.equal(comparison.value.shadow.missingIndependent, 1);
assert.deepEqual(await api('retention/' + posttest.forecast.key), posttest.forecast);
const settings = await api('research/settings');
if (!settings.enabled) await api('research/settings', {
  requestId: randomUUID(), revision: settings.revision, enabled: true,
}, 'PUT');
const reviewPath = 'retention/' + posttest.result.key + '/research';
assert.deepEqual(await api(reviewPath), { enabled: true, revision: 0, allowed: false, worksheet: null });
const permission = { requestId: randomUUID(), revision: 0, allowed: true };
await api('retention/' + overlap.result.key + '/research', permission, 'PUT', 409);
assert.equal((await api(reviewPath, permission, 'PUT')).allowed, true);
let worksheet;
for (let i = 0; i < 80 && !worksheet; i++) {
  ({ worksheet } = await api(reviewPath));
  if (!worksheet) await delay(250);
}
assert.equal(worksheet?.cost, 0);
assert.equal(worksheet.source.href, '/api/retention/' + posttest.result.key);
assert.deepEqual((await api(reviewPath, permission, 'PUT')).worksheet, worksheet);
assert.deepEqual(await api(reviewPath, { requestId: randomUUID(), revision: 1, allowed: false }, 'PUT'),
  { enabled: true, revision: 2, allowed: false, worksheet: null });
assert.deepEqual(await api('retention/' + posttest.result.key), posttest.result);
console.log(JSON.stringify({ frozen, reconciled, revoked: 'forecast and reconciliation stale', pretest, posttest, overlap,
  followup: { forecast: followup, before, early, ready, issued: laterIssue, submitted, result: laterResult }, worksheet, comparison }, null, 2));
