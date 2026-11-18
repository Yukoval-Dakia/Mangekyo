import { readProviderCompletion } from './provider-stream.ts';
import { requestAnthropicCompletion } from './anthropic-provider.ts';

const providerTimeoutMs = 180_000;

export const teachingProfile = { model: 'auto/deepseek-v4.1-flash', reasoningEffort: 'high' } as const;
// These members of the Magpie route report provider-specific deployment names.
const teachingModelAliases = new Set(['lobster/deepseek-flash', 'loomy/deepseek-v4-flash-1017', 'raccoon/sn-deepseek-v4-1-flash-1017']);
const teachingModelPattern = /(?:^|\/)(?:auto-)?deepseek-v4[.-]1-flash(?:-\d{4}-?\d{2}-?\d{2})?$/i;
const reasoningEffortPattern = /^[a-z][a-z0-9._-]{0,31}$/i;

export type TeachingProvider = {
  baseUrl: string;
  apiKey?: string;
  /** Wire protocol. The default remains OpenAI-compatible chat completions. */
  protocol?: 'openai' | 'anthropic';
  /** A custom route's own model. The default is the fixed DeepSeek profile. */
  model?: string;
  /** Reasoning level passed through to the selected route; 'default' omits it. */
  reasoningEffort?: string;
};

export type TeachingProfile = { model: string; reasoningEffort: string };

export type TeachingErrorCode =
  | 'provider_configuration'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_response'
  | 'provider_incomplete'
  | 'invalid_input'
  | 'invalid_decision'
  | 'evidence_scope'
  | 'evidence_limit';

export class TeachingError extends Error {
  readonly code: TeachingErrorCode;

  constructor(code: TeachingErrorCode, message: string) {
    super(message);
    this.name = 'TeachingError';
    this.code = code;
  }
}

export function providerIdentifier(value: unknown, apiKey: string | undefined): string | undefined {
  if (typeof value === 'string' && /^[a-zA-Z0-9._:/@+~-]{1,256}$/.test(value) && (!apiKey || !value.includes(apiKey))) {
    return value;
  }
  return undefined;
}

export function providerProtocol(provider: TeachingProvider): 'openai' | 'anthropic' {
  if (provider.protocol === undefined) return 'openai';
  if (provider.protocol === 'openai' || provider.protocol === 'anthropic') return provider.protocol;
  throw new TeachingError('provider_configuration', '教学模型协议无效。');
}

/**
 * The fixed DeepSeek profile is used only while the provider keeps its default
 * model. A custom route starts at 'default' so no DeepSeek-specific reasoning
 * field leaks into an unrelated model, unless the caller asks for one.
 */
export function profileFor(provider: TeachingProvider): TeachingProfile {
  const model = provider.model ?? teachingProfile.model;
  if (!providerIdentifier(model, provider.apiKey)) {
    throw new TeachingError('provider_configuration', '教学模型名称无效。');
  }
  const reasoningEffort = provider.reasoningEffort ??
    (model === teachingProfile.model ? teachingProfile.reasoningEffort : 'default');
  if (!reasoningEffortPattern.test(reasoningEffort)) {
    throw new TeachingError('provider_configuration', '教学模型思考强度无效。');
  }
  return { model, reasoningEffort };
}

export function checkProviderOutcome(result: object): void {
  if ('rejectedHttpStatus' in result && typeof result.rejectedHttpStatus === 'number') {
    throw new TeachingError('provider_unavailable', `模型服务拒绝请求（HTTP ${result.rejectedHttpStatus}），请检查端点、模型或额度。`);
  }
  if ('truncated' in result && result.truncated === true) {
    throw new TeachingError('provider_incomplete', '模型达到生成上限，本轮回复未完成。');
  }
}

export function providerEndpoint(provider: TeachingProvider): string {
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw new TeachingError('provider_configuration', '教学模型服务地址无效。');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TeachingError('provider_configuration', '教学模型服务地址无效。');
  }
  const suffix = providerProtocol(provider) === 'anthropic' ? '/messages' : '/chat/completions';
  const path = url.pathname.replace(/\/+$/, '');
  const base = path || (providerProtocol(provider) === 'anthropic' ? '/v1' : '');
  url.pathname = path.endsWith(suffix) ? path : `${base}${suffix}`;
  return url.href;
}

function isDefaultTeachingModel(model: string): boolean {
  return teachingModelAliases.has(model) || teachingModelPattern.test(model);
}

const versionSuffix = /^(?:[-@:.](?:latest|\d{4}-?\d{2}-?\d{2}|\d{8}|v\d+(?:\.\d+)*))$/i;
// A provider can omit its namespace and resolve a floating alias to a snapshot.
// A pinned date and an explicitly reported vendor must match the requested route.
function sameModelFamily(reported: string, requested: string): boolean {
  if (reported === requested) return true;
  const requestedNamespace = requested.slice(0, requested.lastIndexOf('/') + 1);
  const reportedNamespace = reported.slice(0, reported.lastIndexOf('/') + 1);
  if (requestedNamespace && reportedNamespace && reportedNamespace !== requestedNamespace) return false;
  const name = reported.slice(reportedNamespace.length);
  const alias = requested.slice(requestedNamespace.length);
  if (name === alias) return true;
  const family = alias.replace(/-latest$/i, '');
  return !/-\d{4}-?\d{2}-?\d{2}$/i.test(alias) && name.startsWith(family) && versionSuffix.test(name.slice(family.length));
}

export function verifyTeachingModel(model: unknown, apiKey: string | undefined, requestedModel?: string): string {
  const reported = providerIdentifier(model, apiKey);
  const requested = requestedModel === undefined ? undefined : providerIdentifier(requestedModel, apiKey);
  if (requestedModel !== undefined && !requested) {
    throw new TeachingError('provider_configuration', '教学模型名称无效。');
  }
  if (!reported || (requested === undefined || isDefaultTeachingModel(requested)
    ? !isDefaultTeachingModel(reported)
    : !sameModelFamily(reported, requested))) {
    if (requested !== undefined && !isDefaultTeachingModel(requested)) {
      throw new TeachingError('provider_response', `服务返回的模型与请求的 ${requested} 不一致。`);
    }
    throw new TeachingError('provider_response', '服务返回的模型与固定的 DeepSeek 4.1 Flash 不一致。');
  }
  return reported;
}

export async function requestCompletion(
  endpoint: string,
  body: string,
  apiKey: string | undefined,
  clientRequestId: string,
  hooks: Parameters<typeof readProviderCompletion>[1] = {},
  provider?: TeachingProvider,
) {
  if (typeof clientRequestId !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(clientRequestId)) {
    throw new TeachingError('provider_configuration', '教学模型请求缺少有效的跟踪 ID。');
  }
  if (provider && providerProtocol(provider) === 'anthropic') {
    return requestAnthropicCompletion(endpoint, body, apiKey, clientRequestId, hooks);
  }
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
    'x-client-request-id': clientRequestId,
  });
  const signal = AbortSignal.timeout(providerTimeoutMs);
  let response: Response;
  try {
    if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
    response = await fetch(endpoint, { method: 'POST', headers, body, signal, redirect: 'error' });
  } catch {
    if (signal.aborted) throw new TeachingError('provider_timeout', '等待教学模型超时。');
    throw new TeachingError('provider_unavailable', '暂时无法连接教学模型。');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if ([400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status)) {
      return { rejectedHttpStatus: response.status } as const;
    }
    throw new TeachingError('provider_unavailable', `教学模型服务返回 HTTP ${response.status}。`);
  }

  try {
    return await readProviderCompletion(response, hooks);
  } catch (error) {
    if (signal.aborted) throw new TeachingError('provider_timeout', '等待教学模型超时。');
    if (error instanceof TeachingError) throw error;
    throw new TeachingError('provider_response', '教学模型的响应未完整收到或格式无效。');
  }
}
