import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { teachingProfile } from '../../executors/teaching/index.ts';

type ProviderSettings = {
  baseUrl: string;
  apiKey: string;
  exaApiKey: string;
  allowSearch: boolean;
};
const filename =
  process.env.MANGEKYO_SETTINGS_FILE || join(homedir(), '.config', 'mangekyo', 'provider.json');
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
function key(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value))
    throw new Error(`${label}格式无效。`);
  return value;
}
function environmentExaApiKey() {
  return process.env.MANGEKYO_EXA_API_KEY || process.env.EXA_API_KEY || '';
}
export async function loadSettings(): Promise<ProviderSettings> {
  try {
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved))
      throw new Error('设置文件格式无效。');
    const allowSearch = saved.allowSearch ?? false;
    if (typeof allowSearch !== 'boolean') throw new Error('设置文件格式无效。');
    return {
      baseUrl: endpoint(saved.baseUrl),
      apiKey: key(saved.apiKey, '模型密钥'),
      exaApiKey:
        saved.exaApiKey === undefined ? environmentExaApiKey() : key(saved.exaApiKey, 'Exa 密钥'),
      allowSearch,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      baseUrl: endpoint(process.env.MANGEKYO_LLM_BASE_URL || 'http://127.0.0.1:3425/v1'),
      apiKey: process.env.MANGEKYO_LLM_API_KEY || '',
      exaApiKey: environmentExaApiKey(),
      allowSearch: false,
    };
  }
}
export function publicSettings({ baseUrl, apiKey, exaApiKey, allowSearch }: ProviderSettings) {
  return {
    baseUrl,
    ...teachingProfile,
    hasKey: Boolean(apiKey),
    hasExaKey: Boolean(exaApiKey),
    allowSearch,
  };
}
let updating: Promise<unknown> = Promise.resolve();
export function saveSettings(input: Record<string, unknown>) {
  const update = updating.then(async () => {
    const prior = await loadSettings().catch((error) => {
      const complete =
        input.baseUrl !== undefined &&
        input.apiKey !== undefined &&
        input.exaApiKey !== undefined &&
        input.allowSearch !== undefined;
      if (!complete) throw error;
      return undefined;
    });
    const baseUrl = input.baseUrl === undefined ? prior!.baseUrl : endpoint(input.baseUrl);
    if ((input.model !== undefined && input.model !== teachingProfile.model) ||
        (input.reasoningEffort !== undefined && input.reasoningEffort !== teachingProfile.reasoningEffort) ||
        (input.reasoning_effort !== undefined && input.reasoning_effort !== teachingProfile.reasoningEffort))
      throw new Error('教学模型固定为 DeepSeek 4.1 Flash，思考强度固定为 high。');
    const apiKey = input.apiKey === undefined ? (prior?.baseUrl === baseUrl ? prior.apiKey : '') : key(input.apiKey, '模型密钥');
    const exaApiKey =
      input.exaApiKey === undefined ? prior!.exaApiKey : key(input.exaApiKey, 'Exa 密钥');
    const allowSearch = input.allowSearch === undefined ? prior!.allowSearch : input.allowSearch;
    if (typeof allowSearch !== 'boolean') throw new Error('搜索开关格式无效。');
    const next = { baseUrl, apiKey, exaApiKey, allowSearch };
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    const temp = filename + '.' + randomUUID();
    try {
      await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await rename(temp, filename);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
    return publicSettings(next);
  });
  updating = update.catch(() => {});
  return update;
}
