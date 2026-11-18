import assert from 'node:assert/strict';
import test from 'node:test';

const domain = await import('@mangekyo/kernel');

test('domain package has no database execution entrypoint', async () => {
  assert.equal('createPgDb' in domain, false);
  assert.equal('createPgliteDb' in domain, false);
  await assert.rejects(
    import('@mangekyo/kernel/db'),
    (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  );
});
