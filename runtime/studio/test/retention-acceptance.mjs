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
console.log(JSON.stringify({ frozen, reconciled, revoked: 'forecast and reconciliation stale' }, null, 2));
