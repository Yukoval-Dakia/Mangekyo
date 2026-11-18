import {readModelRoutes, type ModelRoutes, type ModelTask} from './model-routes.ts';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { teachingProfile } from '../../executors/teaching/provider.ts';

export type ProviderProtocol = 'openai' | 'anthropic';

export type ProviderProfile = {
  id: string;
  label: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  model: string;
  reasoningEffort: string;
  apiKey: string;
};

export type McpServer = {
  id: string;
  label?: string;
  url: string;
  token: string;
  credentialRevision: string;
  allowedTools: string[];
  enabled: boolean;
};

type StoredSettings = {
  routes?: ModelRoutes;
  providers: ProviderProfile[];
  activeProviderId: string;
  mcpServers: McpServer[];
  exaApiKey?: string;
  allowSearch: boolean;
};

export type ProviderSettings = {
  routes?: ModelRoutes;
  baseUrl: string;
  model: string;
  protocol: ProviderProtocol;
  reasoningEffort: string;
  apiKey: string;
  activeProviderId: string;
  providers: ProviderProfile[];
  mcpServers: McpServer[];
  exaApiKey: string;
  allowSearch: boolean;
};

const defaultBaseUrl = 'http://127.0.0.1:3425/v1';
const maximumItems = 100;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const modelIdentifier = /^[A-Za-z0-9._:/@+~-]{1,200}$/;
const effortIdentifier = /^[a-z][a-z0-9._-]{0,31}$/i;
const toolIdentifier = /^[A-Za-z0-9_.:/-]{1,200}$/;

function settingsFile() {
  return process.env.MANGEKYO_SETTINGS_FILE || join(homedir(), '.config', 'mangekyo', 'provider.json');
}

function object(value: unknown, message = '设置文件格式无效。'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function endpoint(value: unknown) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('请输入有效的服务地址。');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('请输入有效的服务地址。');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
  ) {
    throw new Error('服务地址须使用 HTTPS；本机服务也支持 HTTP。地址中不能含凭据、查询或片段。');
  }
  return url.href.replace(/\/+$/, '');
}

function secret(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length > 8192 || /[\r\n\u0000]/.test(value))
    throw new Error(`${label}格式无效。`);
  if (label === 'MCP 令牌' && (value.length > 4096 || /[^!-~]/.test(value))) throw new Error('MCP 令牌格式无效。');
  if (label === 'Exa 密钥' && (value.length > 512 || /[^!-~]/.test(value))) throw new Error('Exa 密钥格式无效。');
  return value;
}

function text(value: unknown, label: string, maximum = 120) {
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/.test(trimmed))
    throw new Error(`${label}格式无效。`);
  return trimmed;
}

function optionalLabel(value: unknown) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined;
  return text(value, '名称');
}

function identifierOf(value: unknown) {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error('配置标识无效。');
  return value;
}

function modelOf(value: unknown) {
  if (typeof value !== 'string' || !modelIdentifier.test(value)) throw new Error('模型名称格式无效。');
  return value;
}

function effortOf(value: unknown) {
  if (typeof value !== 'string' || !effortIdentifier.test(value)) throw new Error('思考强度格式无效。');
  return value;
}

function protocolOf(value: unknown): ProviderProtocol {
  if (value === 'openai' || value === 'anthropic') return value;
  throw new Error('模型协议无效。');
}

function booleanOf(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label}格式无效。`);
  return value;
}

function toolsOf(value: unknown) {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error('MCP 工具清单格式无效。');
  const tools: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !toolIdentifier.test(entry.trim()))
      throw new Error('MCP 工具名称格式无效。');
    const tool = entry.trim();
    if (!tools.includes(tool)) tools.push(tool);
  }
  return tools;
}

function environmentExaApiKey() {
  return process.env.MANGEKYO_EXA_API_KEY || process.env.EXA_API_KEY || '';
}

function defaultStored(): StoredSettings {
  return {
    providers: [{
      id: 'default',
      label: '默认模型',
      baseUrl: endpoint(process.env.MANGEKYO_LLM_BASE_URL || defaultBaseUrl),
      protocol: 'openai',
      model: teachingProfile.model,
      reasoningEffort: teachingProfile.reasoningEffort,
      apiKey: secret(process.env.MANGEKYO_LLM_API_KEY || '', '模型密钥'),
    }],
    activeProviderId: 'default',
    mcpServers: [],
    allowSearch: false,
  };
}

function readProvider(value: unknown, index: number): ProviderProfile {
  const saved = object(value);
  const model = saved.model === undefined ? teachingProfile.model : modelOf(saved.model);
  return {
    id: saved.id === undefined ? 'provider-' + index : identifierOf(saved.id),
    label: saved.label === undefined ? '默认模型' : text(saved.label, '名称'),
    baseUrl: endpoint(saved.baseUrl),
    protocol: saved.protocol === undefined ? 'openai' : protocolOf(saved.protocol),
    model,
    reasoningEffort:
      saved.reasoningEffort === undefined
        ? (model === teachingProfile.model ? teachingProfile.reasoningEffort : 'default')
        : effortOf(saved.reasoningEffort),
    apiKey: saved.apiKey === undefined ? '' : secret(saved.apiKey, '模型密钥'),
  };
}

function readMcpServer(value: unknown, index: number): McpServer {
  const saved = object(value);
  const label = optionalLabel(saved.label);
  return {
    id: saved.id === undefined ? 'mcp-' + index : identifierOf(saved.id),
    ...(label === undefined ? {} : { label }),
    url: endpoint(saved.url),
    token: saved.token === undefined ? '' : secret(saved.token, 'MCP 令牌'),
    credentialRevision: saved.credentialRevision === undefined ? 'initial' : identifierOf(saved.credentialRevision),
    allowedTools: saved.allowedTools === undefined ? [] : toolsOf(saved.allowedTools),
    enabled: saved.enabled === undefined ? true : booleanOf(saved.enabled, 'MCP 开关'),
  };
}

function uniqueIds<T extends { id: string }>(items: readonly T[]): T[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error('配置标识重复。');
    ids.add(item.id);
  }
  return [...items];
}

function normalizeSaved(savedValue: unknown): StoredSettings {
  const saved = object(savedValue);
  const allowSearch = saved.allowSearch === undefined ? false : booleanOf(saved.allowSearch, '搜索开关');
  const exaApiKey = saved.exaApiKey === undefined ? undefined : secret(saved.exaApiKey, 'Exa 密钥');
  if (saved.providers !== undefined) {
    if (!Array.isArray(saved.providers) || saved.providers.length === 0 || saved.providers.length > maximumItems)
      throw new Error('设置文件格式无效。');
    const providers = uniqueIds(saved.providers.map(readProvider));
    const activeProviderId =
      typeof saved.activeProviderId === 'string' && providers.some((provider) => provider.id === saved.activeProviderId)
        ? saved.activeProviderId
        : providers[0]!.id;
    if (saved.mcpServers !== undefined && (!Array.isArray(saved.mcpServers) || saved.mcpServers.length > maximumItems))
      throw new Error('设置文件格式无效。');
    const mcpServers = uniqueIds((saved.mcpServers ?? []).map(readMcpServer));
    return {
      providers,
      activeProviderId,
      ...(saved.routes === undefined ? {} : {routes: readModelRoutes(saved.routes, providers)}),
      mcpServers,
      ...(exaApiKey === undefined ? {} : { exaApiKey }),
      allowSearch,
    };
  }

  const providers = [{
    id: 'default',
    label: '默认模型',
    baseUrl: endpoint(saved.baseUrl),
    protocol: 'openai' as const,
    model: teachingProfile.model,
    reasoningEffort: teachingProfile.reasoningEffort,
    apiKey: saved.apiKey === undefined ? '' : secret(saved.apiKey, '模型密钥'),
  }];
  return {
    providers,
    activeProviderId: 'default',
    mcpServers: [],
    ...(exaApiKey === undefined ? {} : { exaApiKey }),
    allowSearch,
  };
}

async function readStored(): Promise<StoredSettings> {
  try {
    return normalizeSaved(JSON.parse(await readFile(settingsFile(), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return defaultStored();
  }
}

function flatten(stored: StoredSettings, task?: ModelTask): ProviderSettings {
  const profileId = (task && stored.routes?.[task]) || stored.activeProviderId;
  const active =
    stored.providers.find((provider) => provider.id === profileId) ?? stored.providers[0]!;
  return {
    ...(stored.routes ? {routes: stored.routes} : {}),
    baseUrl: active.baseUrl,
    model: active.model,
    protocol: active.protocol,
    reasoningEffort: active.reasoningEffort,
    apiKey: active.apiKey,
    activeProviderId: active.id,
    providers: stored.providers.map((provider) => ({ ...provider })),
    mcpServers: stored.mcpServers.map((server) => ({ ...server, allowedTools: [...server.allowedTools] })),
    exaApiKey: stored.exaApiKey === undefined ? environmentExaApiKey() : stored.exaApiKey,
    allowSearch: stored.allowSearch,
  };
}

export async function loadSettings(task?: ModelTask): Promise<ProviderSettings> {
  return flatten(await readStored(), task);
}

export function publicSettings(settings: ProviderSettings) {
  return {
    ...(settings.routes ? {routes: settings.routes} : {}),
    baseUrl: settings.baseUrl,
    model: settings.model,
    protocol: settings.protocol,
    reasoningEffort: settings.reasoningEffort,
    activeProviderId: settings.activeProviderId,
    providers: settings.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      model: provider.model,
      reasoningEffort: provider.reasoningEffort,
      hasKey: Boolean(provider.apiKey),
    })),
    mcpServers: settings.mcpServers.map((server) => ({
      id: server.id,
      ...(server.label === undefined ? {} : { label: server.label }),
      url: server.url,
      allowedTools: [...server.allowedTools],
      enabled: server.enabled,
      hasToken: Boolean(server.token),
    })),
    hasKey: Boolean(settings.apiKey),
    hasExaKey: Boolean(settings.exaApiKey),
    allowSearch: settings.allowSearch,
  };
}

function mergeProvider(existing: ProviderProfile | undefined, value: unknown): ProviderProfile {
  const input = object(value, '模型配置格式无效。');
  if (existing === undefined && input.baseUrl === undefined) throw new Error('请填写模型服务地址。');
  const baseUrl = input.baseUrl === undefined ? existing!.baseUrl : endpoint(input.baseUrl);
  const protocol = input.protocol === undefined ? (existing?.protocol ?? 'openai') : protocolOf(input.protocol);
  const model = input.model === undefined ? (existing?.model ?? teachingProfile.model) : modelOf(input.model);
  const defaultEffort = model === teachingProfile.model ? teachingProfile.reasoningEffort : 'default';
  const destinationChanged = existing !== undefined && (existing.baseUrl !== baseUrl || existing.protocol !== protocol);
  const label = optionalLabel(input.label);
  return {
    id: existing?.id ?? (input.id === undefined ? randomUUID() : identifierOf(input.id)),
    label: label ?? existing?.label ?? '默认模型',
    baseUrl,
    protocol,
    model,
    reasoningEffort:
      input.reasoningEffort === undefined && input.reasoning_effort === undefined
        ? (existing?.model === model ? existing.reasoningEffort : defaultEffort)
        : effortOf(input.reasoningEffort ?? input.reasoning_effort),
    apiKey:
      input.apiKey === undefined
        ? destinationChanged
          ? ''
          : (existing?.apiKey ?? '')
        : secret(input.apiKey, '模型密钥'),
  };
}

function mergeProviderList(prior: ProviderProfile[], value: unknown): ProviderProfile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems)
    throw new Error('请至少保留一个模型配置。');
  const providers = value.map((entry) => {
    const input = object(entry, '模型配置格式无效。');
    const id = input.id === undefined ? randomUUID() : identifierOf(input.id);
    return mergeProvider(prior.find((provider) => provider.id === id), { ...input, id });
  });
  return uniqueIds(providers);
}

function mergeMcpServer(existing: McpServer | undefined, value: unknown): McpServer {
  const input = object(value, 'MCP 配置格式无效。');
  if (existing === undefined && input.url === undefined) throw new Error('请填写 MCP 服务地址。');
  const url = input.url === undefined ? existing!.url : endpoint(input.url);
  const destinationChanged = existing !== undefined && existing.url !== url;
  const token = input.token === undefined ? (destinationChanged ? '' : existing?.token ?? '') : secret(input.token, 'MCP 令牌');
  const label = input.label === undefined ? existing?.label : optionalLabel(input.label);
  return {
    id: existing?.id ?? (input.id === undefined ? randomUUID() : identifierOf(input.id)),
    ...(label === undefined ? {} : { label }),
    url,
    token,
    credentialRevision: existing && !destinationChanged && token === existing.token ? existing.credentialRevision : randomUUID(),
    allowedTools: input.allowedTools === undefined ? (existing?.allowedTools ?? []) : toolsOf(input.allowedTools),
    enabled: input.enabled === undefined ? (existing?.enabled ?? true) : booleanOf(input.enabled, 'MCP 开关'),
  };
}

function mergeMcpServerList(prior: McpServer[], value: unknown): McpServer[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error('MCP 配置格式无效。');
  const servers = value.map((entry) => {
    const input = object(entry, 'MCP 配置格式无效。');
    const id = input.id === undefined ? randomUUID() : identifierOf(input.id);
    return mergeMcpServer(prior.find((server) => server.id === id), { ...input, id });
  });
  return uniqueIds(servers);
}

function mergeSettings(prior: StoredSettings, input: Record<string, unknown>): StoredSettings {
  let providers = prior.providers.map((provider) => ({ ...provider }));
  let activeProviderId = prior.activeProviderId;
  let mcpServers = prior.mcpServers.map((server) => ({ ...server, allowedTools: [...server.allowedTools] }));
  let exaApiKey = prior.exaApiKey;
  let allowSearch = prior.allowSearch;

  if (input.providers !== undefined) {
    providers = mergeProviderList(prior.providers, input.providers);
  } else if (
    ['baseUrl', 'apiKey', 'model', 'reasoningEffort', 'reasoning_effort', 'protocol'].some(
      (field) => input[field] !== undefined,
    )
  ) {
    const active = providers.findIndex((provider) => provider.id === activeProviderId);
    if (active < 0) throw new Error('当前模型配置不存在。');
    providers[active] = mergeProvider(providers[active], input);
  }

  if (input.activeProviderId !== undefined) {
    const selected = identifierOf(input.activeProviderId);
    if (!providers.some((provider) => provider.id === selected)) throw new Error('所选模型配置不存在。');
    activeProviderId = selected;
  } else if (!providers.some((provider) => provider.id === activeProviderId)) {
    activeProviderId = providers[0]!.id;
  }

  if (input.mcpServers !== undefined) mcpServers = mergeMcpServerList(prior.mcpServers, input.mcpServers);
  if (input.exaApiKey !== undefined) exaApiKey = secret(input.exaApiKey, 'Exa 密钥');
  if (input.allowSearch !== undefined) allowSearch = booleanOf(input.allowSearch, '搜索开关');

  const routes = readModelRoutes(input.routes ?? Object.fromEntries(
    Object.entries(prior.routes ?? {}).filter(([, id]) => providers.some(provider => provider.id === id))
  ), providers);
  return {
    ...(Object.keys(routes).length ? {routes} : {}),
    providers,
    activeProviderId,
    mcpServers,
    ...(exaApiKey === undefined ? {} : { exaApiKey }),
    allowSearch,
  };
}

function completeReplacement(input: Record<string, unknown>) {
  return (
    (Array.isArray(input.providers) && input.providers.length > 0) ||
    (input.baseUrl !== undefined &&
      input.apiKey !== undefined &&
      input.exaApiKey !== undefined &&
      input.allowSearch !== undefined)
  );
}

async function writeStored(settings: StoredSettings) {
  const file = settingsFile();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID();
  try {
    await writeFile(temp, JSON.stringify({ version: 2, ...settings }), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

let updating: Promise<unknown> = Promise.resolve();
export function saveSettings(input: Record<string, unknown>) {
  const update = updating.then(async () => {
    const prior = await readStored().catch((error) => {
      if (!completeReplacement(input)) throw error;
      return defaultStored();
    });
    const next = mergeSettings(prior, input);
    await writeStored(next);
    return publicSettings(flatten(next));
  });
  updating = update.catch(() => {});
  return update;
}
