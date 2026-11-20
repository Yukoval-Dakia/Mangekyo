import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { it } from 'vitest';

it('previews and adopts individual textbook block changes through the shared acceptance runner', async () => {
  const require = createRequire(new URL('../../../runtime/studio/package.json', import.meta.url));
  const runner = fileURLToPath(new URL('../../capture/samples/capture-acceptance.test.mjs', import.meta.url));
  await promisify(execFile)(process.execPath, [require.resolve('tsx/cli'), runner], {
    env: { ...process.env, MANGEKYO_CAPTURE_ACCEPTANCE_URL: '' },
    timeout: 20_000,
  });
}, 25_000);
