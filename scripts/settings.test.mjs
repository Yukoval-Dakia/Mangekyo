import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpRevision, resolveMcpGrants, routeMatchesInput } from '../runtime/studio/harness.ts';
import { loadSettings, publicSettings, saveSettings } from '../runtime/studio/settings.ts';

let directory = '';
let file = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mangekyo-settings-'));
  file = join(directory, 'provider.json');
  process.env.MANGEKYO_SETTINGS_FILE = file;
  process.env.MANGEKYO_EXA_API_KEY = '';
  process.env.EXA_API_KEY = '';
  process.env.MANGEKYO_LLM_BASE_URL = '';
  process.env.MANGEKYO_LLM_API_KEY = '';
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  delete process.env.MANGEKYO_SETTINGS_FILE;
});

describe('unified settings', () => {
  it('migrates the legacy flat file and keeps keys private', async () => {
    await writeFile(file, JSON.stringify({
      baseUrl: 'https://legacy.example/v1',
      apiKey: 'legacy-secret',
      exaApiKey: 'legacy-exa',
      allowSearch: true,
    }));
    const loaded = await loadSettings();
    expect(loaded.baseUrl).toBe('https://legacy.example/v1');
    expect(loaded.apiKey).toBe('legacy-secret');
    expect(loaded.exaApiKey).toBe('legacy-exa');
    expect(loaded.model).toBe('auto/deepseek-v4.1-flash');
    expect(loaded.reasoningEffort).toBe('high');
    expect(loaded.protocol).toBe('openai');
    expect(loaded.activeProviderId).toBe('default');
    expect(loaded.providers.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'default', label: '默认模型' },
    ]);

    const exposed = publicSettings(loaded);
    expect(JSON.stringify(exposed)).not.toContain('legacy-secret');
    expect(JSON.stringify(exposed)).not.toContain('legacy-exa');
    expect('apiKey' in exposed.providers[0]).toBe(false);
  });

  it('keeps a key when the endpoint is unchanged and clears it when moved', async () => {
    await saveSettings({
      providers: [{
        id: 'one',
        label: 'One',
        baseUrl: 'https://one.example/v1',
        protocol: 'openai',
        model: 'auto/deepseek-v4.1-flash',
        reasoningEffort: 'high',
        apiKey: 'one-secret',
      }],
      activeProviderId: 'one',
      mcpServers: [],
    });

    await saveSettings({
      providers: [{
        id: 'one',
        label: 'One renamed',
        baseUrl: 'https://one.example/v1',
        model: 'auto/deepseek-v4.1-flash',
        reasoningEffort: 'medium',
      }],
    });
    expect((await loadSettings()).apiKey).toBe('one-secret');

    await saveSettings({
      providers: [{
        id: 'one',
        label: 'One moved',
        baseUrl: 'https://two.example/v1',
        model: 'auto/deepseek-v4.1-flash',
      }],
    });
    const moved = await loadSettings();
    expect(moved.baseUrl).toBe('https://two.example/v1');
    expect(moved.apiKey).toBe('');
    expect(moved.providers).toHaveLength(1);
    await saveSettings({ providers: [{id: 'one', apiKey: 'original', model: 'different-model'}] });
    expect((await loadSettings()).reasoningEffort).toBe('default');
    await saveSettings({ providers: [{id: 'one', protocol: 'anthropic'}] });
    expect((await loadSettings()).apiKey).toBe('');
  });

  it('stores independent profiles and never copies secrets between them', async () => {
    await saveSettings({
      providers: [
        { id: 'first', label: 'First', baseUrl: 'https://first.example/v1', apiKey: 'first-secret' },
        { id: 'second', label: 'Second', baseUrl: 'https://second.example/v1' },
      ],
      activeProviderId: 'second',
    });
    let loaded = await loadSettings();
    expect(loaded.activeProviderId).toBe('second');
    expect(loaded.baseUrl).toBe('https://second.example/v1');
    expect(loaded.apiKey).toBe('');
    expect(loaded.providers.find((provider) => provider.id === 'first')?.apiKey).toBe('first-secret');

    await saveSettings({ activeProviderId: 'first' });
    loaded = await loadSettings();
    expect(loaded.baseUrl).toBe('https://first.example/v1');
    expect(loaded.apiKey).toBe('first-secret');
    expect(loaded.providers.find((provider) => provider.id === 'second')?.apiKey).toBe('');

    await saveSettings({
      providers: loaded.providers
        .filter((provider) => provider.id === 'second')
        .map(({ id, label, baseUrl, protocol, model, reasoningEffort }) => ({
          id, label, baseUrl, protocol, model, reasoningEffort,
        })),
      activeProviderId: 'second',
    });
    loaded = await loadSettings();
    expect(loaded.providers.some((provider) => provider.id === 'first')).toBe(false);
    expect(await readFile(file, 'utf8')).not.toContain('first-secret');
  });

  it('resolves routes per task and refuses stale model and tool grants', async () => {
    const baseUrl = 'https://shared.example/v1';
    const server = {id: 'library', url: 'https://mcp.example/tools', allowedTools: ['lookup']};
    const saved = await saveSettings({providers: [
      {id: 'a', baseUrl}, {id: 'b', baseUrl, protocol: 'anthropic', model: 'tutor'},
    ], activeProviderId: 'a', routes: {assessment: 'b'}, mcpServers: [server]});
    const selected = await loadSettings('assessment');
    expect(selected.activeProviderId).toBe('b');
    expect((await loadSettings('companion')).activeProviderId).toBe('a');
    expect(selected.reasoningEffort).toBe('default');
    expect(routeMatchesInput({providerId: 'a', baseUrl, protocol: saved.protocol,
      model: saved.model, reasoningEffort: saved.reasoningEffort}, selected)).toBe(false);
    expect(resolveMcpGrants([server], selected)).toEqual([server]);
    await saveSettings({mcpServers: [{...server, token: 'rotated'}]});
    expect(mcpRevision([server], await loadSettings())).not.toBe(mcpRevision([server], selected));
    await saveSettings({mcpServers: [{...server, allowedTools: []}]});
    const revoked = await loadSettings();
    expect(() => resolveMcpGrants([server], revoked)).toThrow();
  });

  it('supports the legacy flat PUT and explicit key removal', async () => {
    await saveSettings({
      baseUrl: 'https://legacy-put.example/v1',
      apiKey: 'flat-secret',
      exaApiKey: 'flat-exa',
      allowSearch: true,
    });
    let loaded = await loadSettings();
    expect(loaded.apiKey).toBe('flat-secret');
    expect(loaded.exaApiKey).toBe('flat-exa');
    expect(loaded.allowSearch).toBe(true);

    await saveSettings({ apiKey: '' });
    loaded = await loadSettings();
    expect(loaded.apiKey).toBe('');
    expect(loaded.baseUrl).toBe('https://legacy-put.example/v1');
    expect(loaded.exaApiKey).toBe('flat-exa');
  });

  it('validates and persists MCP servers with a tool allowlist', async () => {
    const saved = await saveSettings({
      mcpServers: [{
        id: 'docs',
        label: 'Docs',
        url: 'http://127.0.0.1:8765/mcp',
        token: 'mcp-secret',
        allowedTools: ['search', 'fetch_page', 'search'],
        enabled: true,
      }],
    });
    expect(JSON.stringify(saved)).not.toContain('mcp-secret');
    expect(saved.mcpServers[0].hasToken).toBe(true);
    expect(saved.mcpServers[0].allowedTools).toEqual(['search', 'fetch_page']);

    await saveSettings({
      mcpServers: [{
        id: 'docs',
        label: 'Docs',
        url: 'http://127.0.0.1:8765/mcp',
        allowedTools: ['search'],
        enabled: false,
      }],
    });
    const kept = await loadSettings();
    expect(kept.mcpServers[0].token).toBe('mcp-secret');
    expect(kept.mcpServers[0].enabled).toBe(false);

    await saveSettings({
      mcpServers: [{
        id: 'docs',
        url: 'http://localhost:9000/mcp',
        allowedTools: ['search'],
        enabled: false,
      }],
    });
    expect((await loadSettings()).mcpServers[0].token).toBe('');
  });

  it('rejects non-local HTTP endpoints and malformed settings', async () => {
    await expect(saveSettings({ baseUrl: 'http://remote.example/v1' })).rejects.toThrow(/HTTPS/);
    await expect(
      saveSettings({ mcpServers: [{ id: 'bad', url: 'http://remote.example/mcp' }] }),
    ).rejects.toThrow(/HTTPS/);
    await expect(
      saveSettings({ baseUrl: 'https://user:pass@remote.example/v1' }),
    ).rejects.toThrow(/HTTPS|凭据/);
    await expect(saveSettings({ providers: [] })).rejects.toThrow(/至少保留/);
    await expect(
      saveSettings({ mcpServers: [{ id: 'bad', url: 'https://example.com/mcp', allowedTools: ['bad tool'] }] }),
    ).rejects.toThrow(/工具名称/);
  });

  it('writes atomically and serializes concurrent saves', async () => {
    await saveSettings({ baseUrl: 'https://atomic.example/v1', allowSearch: false });
    expect(await readdir(directory)).toEqual(['provider.json']);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2);

    await Promise.all(
      Array.from({ length: 8 }, (_, index) => saveSettings({ allowSearch: index % 2 === 0 })),
    );
    expect((await loadSettings()).allowSearch).toBe(false);
    expect(await readdir(directory)).toEqual(['provider.json']);
  });

  it('rebuilds a broken file only with a complete replacement', async () => {
    await writeFile(file, '{not json');
    await expect(saveSettings({ allowSearch: true })).rejects.toThrow();
    await saveSettings({
      baseUrl: 'https://recovered.example/v1',
      apiKey: 'new-secret',
      exaApiKey: '',
      allowSearch: true,
    });
    const loaded = await loadSettings();
    expect(loaded.baseUrl).toBe('https://recovered.example/v1');
    expect(loaded.apiKey).toBe('new-secret');
  });
});
