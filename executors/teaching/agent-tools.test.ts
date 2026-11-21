import {expect, it, vi} from 'vitest';
import {createStudyTools, readPythonEnvelope} from './agent-tools.ts';
import {createLearningTurn} from './learning-turn.ts';
import {studyToolDiscovery} from './study-tool-discovery.ts';
import {studyToolResults} from './study-tool-results.ts';
import {watchFetch} from './test/chat.ts';
import {hasDockerImage} from './test/docker.ts';

it('exposes scratch tools and offers keyless Exa only with search permission', () => {
  const scratch = ['python', 'read_file', 'write_file'];
  for (const credentials of [{}, {exaApiKey: 'secret'}]) {
    expect([...createStudyTools(credentials).names]).toEqual(scratch);
    expect([...createStudyTools({...credentials, allowSearch: true}).names]).toEqual([...scratch, 'exa_search']);
  }
});

it('round-trips flat scratch files and replaces content within quota', async () => {
  const tools = createStudyTools();
  const name = 'notes.txt';
  for (const [content, receipt] of [['第一版', 'wrote notes.txt (9 bytes)'], ['', 'wrote notes.txt (0 bytes, replaced)']] as const) {
    expect(await tools.execute('write_file', {name, content})).toBe(receipt);
    expect(await tools.execute('read_file', {name})).toBe(content);
  }
  expect(await tools.execute('read_file', {name: 'missing.txt'})).toMatchObject({ok:false, code:'not_found', field:'name'});
});

it('rejects paths, non-text content, oversized files and quota overflow', async () => {
  const tools = createStudyTools();
  const invalid = async (name: string, content?: unknown) => expect(await tools.execute(
    content === undefined ? 'read_file' : 'write_file', content === undefined ? {name} : {name, content},
  )).toMatchObject({ok:false, code:'invalid_args'});
  for (const name of ['../x', 'a/b', '.', '..', '.hidden', 'a b', 'x'.repeat(65)]) {
    await invalid(name); await invalid(name, 'x');
  }
  await invalid('a.txt', 1); await invalid('a.txt', 'x\0');
  expect(await tools.execute('write_file', {name: 'big.txt', content: 'x'.repeat(16_385)}))
    .toMatchObject({ok:false, code:'budget_or_limit', field:'content'});
  for (const name of ['a', 'b', 'c', 'd']) {
    expect(await tools.execute('write_file', {name, content: 'x'.repeat(16_384)})).toContain('wrote');
  }
  expect(await tools.execute('write_file', {name: 'e', content: 'x'}))
    .toMatchObject({ok:false, code:'budget_or_limit', field:'content'});
});

it('returns bounded errors for unknown tools, bad arguments and unavailable Exa', async () => {
  const tools = createStudyTools();
  const send = watchFetch();
  expect(await tools.execute('nope', {})).toMatchObject({ok:false, code:'tool_unavailable'});
  expect(JSON.stringify(await tools.execute('x'.repeat(100_000), {})).length).toBeLessThan(700);
  expect(await tools.execute('python', {code: ''})).toMatchObject({ok:false, code:'invalid_args'});
  expect(await tools.execute('python', {code: 'x'.repeat(20_001)})).toMatchObject({ok:false, code:'budget_or_limit'});
  expect(await tools.execute('exa_search', {query: 'wind'})).toMatchObject({ok:false, code:'tool_unavailable'});
  expect(send).not.toHaveBeenCalled();
});

it('calls the fixed Exa endpoint with bounded request fields and hides the key', async () => {
  const send = watchFetch().mockResolvedValue(Response.json({results: [
    {title: 'Sea breeze', url: 'https://example.test/sea', highlights: ['land warms faster', 'air flows seaward']},
    {title: 'Land breeze', url: 'https://example.test/land', highlights: ['night reversal']},
  ]}));
  const tools = createStudyTools({exaApiKey: 'secret-key', allowSearch: true});
  const output = await tools.execute('exa_search', {query: '  sea breeze  '});
  expect(send).toHaveBeenCalledTimes(1);
  const [url] = send.mock.calls[0]!; const init = send.mock.calls[0]![1]!;
  expect(url).toBe('https://api.exa.ai/search');
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({'content-type': 'application/json', 'x-api-key': 'secret-key'});
  expect(JSON.parse(String(init.body))).toEqual({query: 'sea breeze', type: 'auto', numResults: 3,
    contents: {highlights: true}});
  expect(output).toContain('1. Sea breeze');
  expect(output).toContain('https://example.test/sea');
  expect(output).toContain('land warms faster');
  expect(output).not.toContain('secret-key');
});

it('reports Exa HTTP failures without echoing credentials', async () => {
  watchFetch().mockResolvedValue(Response.json({error: 'unauthorized'}, {status: 401}));
  const tools = createStudyTools({exaApiKey: 'secret-key', allowSearch: true});
  const output = await tools.execute('exa_search', {query: 'wind'});
  expect(output).toMatchObject({ok:false, code:'execution_failed', message:expect.stringContaining('401')});
  expect(JSON.stringify(output)).not.toContain('secret-key');
});

it.skipIf(!hasDockerImage('python:3.12-alpine', {timeout: 3_000}))(
  'runs genuine Python with the scratch workspace shared over stdin', async () => {
    const tools = createStudyTools();
    await tools.execute('write_file', {name: 'data.txt', content: 'sea breeze\n'});
    const output = await tools.execute('python', {
      code: 'from pathlib import Path\nprint(Path("data.txt").read_text().upper())\nPath("result.txt").write_text("42")',
    });
    expect(output).toContain('SEA BREEZE');
    expect(output).toContain('files: data.txt, result.txt');
    expect(await tools.execute('read_file', {name: 'result.txt'})).toBe('42');
  });

it('handles non-JSON large tool outputs, extra open_tool_result args, empty Exa body, and deterministic MCP discovery', async () => {
  const results = studyToolResults();
  const archived = results.publishLearning('run_calculation', 1, 'plain '.repeat(500), []);
  expect(JSON.parse(archived.content)).toMatchObject({ ok: true, archived: true, handle: expect.stringMatching(/^@calc_/) });
  expect(JSON.parse(results.publishLearning('read_context', 2, 'null'.padEnd(2100, ' '), []).content)).toMatchObject({ ok: true, archived: true });
  const emptyDef = (name: string) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });
  const turn = createLearningTurn({ definitions: Object.fromEntries(['search_learning', 'open_learning', 'read_context', 'save_page', 'save_question', 'save_edge', 'manage_activity'].map(toolName => [toolName, emptyDef(toolName)])) as never,
    execute: vi.fn(), writeKeys: () => [], preparePython: vi.fn(), authorizeHandles: async () => ({ ok: true }), writes: () => [] }, results, vi.fn(), 'm');
  const { handle } = JSON.parse(archived.content);
  const badOpen = await turn.execute('open_tool_result', { handle, offset: 10 }, 3, Promise.resolve());
  expect(JSON.parse(badOpen!.content)).toMatchObject({ ok: false, code: 'invalid_args', next: { tool: 'find_tools', args: { query: 'open_tool_result' } } });
  watchFetch().mockResolvedValueOnce(new Response('', { headers: { 'content-type': 'application/json' } }));
  expect(await createStudyTools({ allowSearch: true }).execute('exa_search', { query: 'test' })).toMatchObject({ ok: false, code: 'execution_failed' });
  watchFetch().mockResolvedValueOnce(new Response('data: {"id":1,"result":{"content":[{"type":"text","text":"hit"}]}}\ndata: [DONE]\n', { headers: { 'content-type': 'text/event-stream' } }));
  expect(await createStudyTools({ allowSearch: true }).execute('exa_search', { query: 'test' })).toBe('hit');
  const envelopePayload = JSON.stringify({ status: 'ok', stdout: 'seen __MANGEKYO_RESULT__ inside output', stderr: '', files: {}, images: {} });
  expect(readPythonEnvelope(`\n__MANGEKYO_RESULT__${envelopePayload}\n`)).toMatchObject({ status: 'ok', stdout: 'seen __MANGEKYO_RESULT__ inside output' });
  const remote = (name: string) => ({ server: { id: 's', url: 'https://s.test/mcp', allowedTools: [name] }, tool: { name, description: 'desc ' + name, inputSchema: { type: 'object' } }, stateful: false });
  const discovery = studyToolDiscovery(new Map([['mcp_z_000000000001', remote('zeta')], ['mcp_a_000000000002', remote('alpha')]]));
  discovery.find('zeta');
  discovery.find('alpha');
  expect(discovery.takeDefinitions().map(def => def.function.name)).toEqual(['mcp_a_000000000002', 'mcp_z_000000000001']);
});
