import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpRevision, resolveMcpGrants, routeMatchesInput } from '../runtime/studio/harness.ts';
import { loadSettings, publicSettings, saveSettings } from '../runtime/studio/settings.ts';

let directory = '';
let file = '';

const saveProviders = (providers, values = {}) => saveSettings({providers, ...values});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mangekyo-settings-'));
  file = join(directory, 'provider.json');
  process.env.MANGEKYO_SETTINGS_FILE = file;
  for (const name of ['MANGEKYO_EXA_API_KEY', 'EXA_API_KEY', 'MANGEKYO_LLM_BASE_URL', 'MANGEKYO_LLM_API_KEY']) {
    process.env[name] = '';
  }
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  delete process.env.MANGEKYO_SETTINGS_FILE;
});

describe('unified settings', () => {
  it('migrates legacy settings and keeps keys out of the public response', async () => {
    await writeFile(file, JSON.stringify({
      baseUrl: 'https://legacy.example/v1', apiKey: 'legacy-secret', exaApiKey: 'legacy-exa', allowSearch: true,
    }));
    const loaded = await loadSettings();
    expect(loaded).toMatchObject({activeProviderId: 'default', baseUrl: 'https://legacy.example/v1', apiKey: 'legacy-secret'});
    expect(JSON.stringify(publicSettings(loaded))).not.toMatch(/legacy-secret|legacy-exa/);
  });

  it('keeps a key for the same endpoint and clears it when moved', async () => {
    await saveProviders([{id: 'one', baseUrl: 'https://one.example/v1', apiKey: 'one-secret'}], {activeProviderId: 'one'});
    await saveProviders([{id: 'one', baseUrl: 'https://one.example/v1', label: 'Renamed'}]);
    expect((await loadSettings()).apiKey).toBe('one-secret');
    await saveProviders([{id: 'one', baseUrl: 'https://two.example/v1'}]);
    expect((await loadSettings()).apiKey).toBe('');
  });

  it('resolves task routes and refuses a revoked tool grant', async () => {
    const baseUrl = 'https://shared.example/v1';
    const server = {id: 'library', url: 'https://mcp.example/tools', allowedTools: ['lookup']};
    const saved = await saveSettings({providers: [
      {id: 'a', baseUrl}, {id: 'b', baseUrl, protocol: 'anthropic', model: 'tutor'},
    ], activeProviderId: 'a', routes: {assessment: 'b'}, mcpServers: [server]});
    const selected = await loadSettings('assessment');
    expect(selected.activeProviderId).toBe('b');
    expect(routeMatchesInput({providerId: 'a', baseUrl, protocol: saved.protocol,
      model: saved.model, reasoningEffort: saved.reasoningEffort}, selected)).toBe(false);
    expect(resolveMcpGrants([server], selected)).toEqual([server]);
    await saveSettings({mcpServers: [{...server, token: 'rotated', allowedTools: []}]});
    const revoked = await loadSettings();
    expect(mcpRevision([server], revoked)).not.toBe(mcpRevision([server], selected));
    expect(() => resolveMcpGrants([server], revoked)).toThrow();
  });
});
