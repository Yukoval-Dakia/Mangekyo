import { afterEach, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

it('confirms graph evolution and textbook revisions with the shared acceptance runner', async () => {
  const postgres = process.env.MANGEKYO_CONTENT_GRAPH_PG === '1';
  const database = process.env.MANGEKYO_TEST_DATABASE_URL;
  if (postgres && !database) throw new Error('Missing PostgreSQL test URL');
  vi.stubEnv('MANGEKYO_CAPTURE_ACCEPTANCE_URL', postgres ? database : undefined);
  await import(new URL('../../capture/samples/capture-acceptance.test.mjs', import.meta.url).href);
}, 45_000);
