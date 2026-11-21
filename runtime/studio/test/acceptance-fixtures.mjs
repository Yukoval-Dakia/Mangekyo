import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export const jsonHeaders = { 'content-type': 'application/json' };

export function requestJson(url, data, { method = data ? 'POST' : 'GET', headers = data ? jsonHeaders : undefined } = {}) {
  return fetch(url, { method, headers, body: data ? JSON.stringify(data) : undefined });
}

function assertJsonOk(response, path, result) {
  assert.ok(response.ok, path + ' ' + response.status + ' ' + JSON.stringify(result));
}

export function studioJsonApi(base, check = assertJsonOk) {
  return async (path, data, method, status) => {
    const response = await requestJson(new URL('/api/' + path, base), data, { method });
    const result = await response.json();
    check(response, path, result, status);
    return result;
  };
}

export async function waitForSession(session, read, interval, timeout) {
  const deadline = Date.now() + timeout;
  while (session.status === 'pending' && Date.now() < deadline) {
    await delay(interval);
    session = await read(session.id);
  }
  return session;
}
