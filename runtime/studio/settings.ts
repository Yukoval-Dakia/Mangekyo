import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { teachingProfile } from '../../executors/teaching/index.ts';

type ProviderSettings = { baseUrl: string; apiKey: string };
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
export async function loadSettings(): Promise<ProviderSettings> {
  try {
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    if (typeof saved.apiKey !== 'string') throw new Error('设置文件格式无效。');
    return { baseUrl: endpoint(saved.baseUrl), apiKey: saved.apiKey };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      baseUrl: endpoint(process.env.MANGEKYO_LLM_BASE_URL || 'http://127.0.0.1:3425/v1'),
      apiKey: process.env.MANGEKYO_LLM_API_KEY || '',
    };
  }
}
export function publicSettings({ baseUrl, apiKey }: ProviderSettings) {
  return { baseUrl, ...teachingProfile, hasKey: Boolean(apiKey) };
}
let updating: Promise<unknown> = Promise.resolve();
export function saveSettings(input: Record<string, unknown>) {
  const update = updating.then(async () => {
    const prior = input.apiKey === undefined ? await loadSettings() : undefined;
    const baseUrl = endpoint(input.baseUrl);
    if ((input.model !== undefined && input.model !== teachingProfile.model) ||
        (input.reasoningEffort !== undefined && input.reasoningEffort !== teachingProfile.reasoningEffort) ||
        (input.reasoning_effort !== undefined && input.reasoning_effort !== teachingProfile.reasoningEffort))
      throw new Error('教学模型固定为 DeepSeek 4.1 Flash，思考强度固定为 high。');
    const apiKey =
      input.apiKey === undefined ? (prior?.baseUrl === baseUrl ? prior.apiKey : '') : input.apiKey;
    if (typeof apiKey !== 'string' || apiKey.length > 8192 || /[\r\n]/.test(apiKey))
      throw new Error('密钥格式无效。');
    const next = { baseUrl, apiKey };
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    const temp = filename + '.' + randomUUID();
    await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    await rename(temp, filename);
    return publicSettings(next);
  });
  updating = update.catch(() => {});
  return update;
}
