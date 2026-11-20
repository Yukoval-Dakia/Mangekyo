import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { createStudyTools } from './agent-tools.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

it('exposes scratch tools and offers keyless Exa only with search permission', () => {
  expect([...createStudyTools().names]).toEqual(['python', 'read_file', 'write_file']);
  expect([...createStudyTools({ exaApiKey: 'secret' }).names])
    .toEqual(['python', 'read_file', 'write_file']);
  expect([...createStudyTools({ allowSearch: true }).names])
    .toEqual(['python', 'read_file', 'write_file', 'exa_search']);
  expect([...createStudyTools({ exaApiKey: 'secret', allowSearch: true }).names])
    .toEqual(['python', 'read_file', 'write_file', 'exa_search']);
});

it('round-trips flat scratch files and replaces content within quota', async () => {
  const tools = createStudyTools();
  expect(await tools.execute('write_file', { name: 'notes.txt', content: '第一版' }))
    .toBe('wrote notes.txt (9 bytes)');
  expect(await tools.execute('read_file', { name: 'notes.txt' })).toBe('第一版');
  expect(await tools.execute('write_file', { name: 'notes.txt', content: '' }))
    .toBe('wrote notes.txt (0 bytes, replaced)');
  expect(await tools.execute('read_file', { name: 'notes.txt' })).toBe('');
  expect(await tools.execute('read_file', { name: 'missing.txt' }))
    .toMatchObject({ok:false, code:'not_found', field:'name'});
});

it('rejects paths, non-text content, oversized files and quota overflow', async () => {
  const tools = createStudyTools();
  for (const name of ['../x', 'a/b', '.', '..', '.hidden', 'a b', 'x'.repeat(65)]) {
    expect(await tools.execute('read_file', { name })).toMatchObject({ok:false, code:'invalid_args'});
    expect(await tools.execute('write_file', { name, content: 'x' })).toMatchObject({ok:false, code:'invalid_args'});
  }
  expect(await tools.execute('write_file', { name: 'a.txt', content: 1 })).toMatchObject({ok:false, code:'invalid_args'});
  expect(await tools.execute('write_file', { name: 'a.txt', content: 'x\u0000' })).toMatchObject({ok:false, code:'invalid_args'});
  expect(await tools.execute('write_file', { name: 'big.txt', content: 'x'.repeat(16_385) }))
    .toMatchObject({ok:false, code:'budget_or_limit', field:'content'});

  for (const name of ['a', 'b', 'c', 'd']) {
    expect(await tools.execute('write_file', { name, content: 'x'.repeat(16_384) }))
      .toContain('wrote');
  }
  expect(await tools.execute('write_file', { name: 'e', content: 'x' }))
    .toMatchObject({ok:false, code:'budget_or_limit', field:'content'});
});

it('returns bounded errors for unknown tools, bad arguments and unavailable Exa', async () => {
  const tools = createStudyTools();
  const send = vi.spyOn(globalThis, 'fetch');
  expect(await tools.execute('nope', {})).toMatchObject({ok:false, code:'tool_unavailable'});
  expect(JSON.stringify(await tools.execute('x'.repeat(100_000), {})).length).toBeLessThan(700);
  expect(await tools.execute('python', { code: '' })).toMatchObject({ok:false, code:'invalid_args'});
  expect(await tools.execute('python', { code: 'x'.repeat(20_001) })).toMatchObject({ok:false, code:'budget_or_limit'});
  expect(await tools.execute('exa_search', { query: 'wind' })).toMatchObject({ok:false, code:'tool_unavailable'});
  expect(send).not.toHaveBeenCalled();
});

it('calls the fixed Exa endpoint with bounded request fields and hides the key', async () => {
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
    results: [
      { title: 'Sea breeze', url: 'https://example.test/sea', highlights: ['land warms faster', 'air flows seaward'] },
      { title: 'Land breeze', url: 'https://example.test/land', highlights: ['night reversal'] },
    ],
  }));
  const tools = createStudyTools({ exaApiKey: 'secret-key', allowSearch: true });
  const output = await tools.execute('exa_search', { query: '  sea breeze  ' });

  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toBe('https://api.exa.ai/search');
  const init = send.mock.calls[0]![1]!;
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'x-api-key': 'secret-key' });
  expect(JSON.parse(String(init.body))).toEqual({
    query: 'sea breeze',
    type: 'auto',
    numResults: 3,
    contents: { highlights: true },
  });
  expect(output).toContain('1. Sea breeze');
  expect(output).toContain('https://example.test/sea');
  expect(output).toContain('land warms faster');
  expect(output).not.toContain('secret-key');
});

it('reports Exa HTTP failures without echoing credentials', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'unauthorized' }, { status: 401 }));
  const tools = createStudyTools({ exaApiKey: 'secret-key', allowSearch: true });
  const output = await tools.execute('exa_search', { query: 'wind' });
  expect(output).toMatchObject({ok:false, code:'execution_failed', message:expect.stringContaining('401')});
  expect(JSON.stringify(output)).not.toContain('secret-key');
});

function dockerReady(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', 'python:3.12-alpine'], {
      stdio: 'ignore',
      timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
}

it.skipIf(!dockerReady())('runs genuine Python with the scratch workspace shared over stdin', async () => {
  const tools = createStudyTools();
  await tools.execute('write_file', { name: 'data.txt', content: 'sea breeze\n' });
  const output = await tools.execute('python', {
    code: 'from pathlib import Path\nprint(Path("data.txt").read_text().upper())\nPath("result.txt").write_text("42")',
  });
  expect(output).toContain('SEA BREEZE');
  expect(output).toContain('files: data.txt, result.txt');
  expect(await tools.execute('read_file', { name: 'result.txt' })).toBe('42');
});
