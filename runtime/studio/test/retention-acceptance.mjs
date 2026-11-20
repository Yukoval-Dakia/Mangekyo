import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const studio = new URL(process.argv[2]);
assert.match(studio.origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/);
assert.equal(process.argv[3], '--isolated');

async function api(path, data, method = data ? 'POST' : 'GET', status = 200) {
  const response = await fetch(new URL('/api/' + path, studio), {
    method, ...(data ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  assert.equal(response.status, status, path + ' ' + JSON.stringify(result));
  return result;
}

async function current(key) {
  for (let i = 0; i < 80; i++) {
    const result = await api('retention/' + key);
    if (result.state === 'current') return result;
    assert.equal(result.state, 'pending', JSON.stringify(result));
    await delay(250);
  }
  throw new Error('Retention work did not settle');
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

await grant(prior.id, 2, false);
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

async function controlled(priorAttemptIds, answer, verdict, during) {
  const { key } = await api('papers/' + sealed.id + '/retention', {
    ...flags, requestId: randomUUID(), itemId: sealed.itemId, priorAttemptIds,
  }, 'POST', 202);
  const forecast = await current(key);
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
const posttest = await controlled([pretest.attemptId], '20', 'missed');
assert.equal(posttest.forecast.value.estimate.expected, 'correct');
assert.equal(posttest.result.value.observation.result, 'incorrect');
await api('workspace/access/records/' + posttest.attemptId, undefined, 'GET', 404);
const overlap = await controlled([], '21', 'awaiting-independent', () => controlled([], '20', 'observed'));
console.log(JSON.stringify({ frozen, reconciled, revoked: 'forecast and reconciliation stale', pretest, posttest, overlap }, null, 2));
