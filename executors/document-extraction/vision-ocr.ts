import { extractLocalDocument } from './local.ts';
import {
  normalizeImageForVisionOcr,
  type NormalizedVisionImage,
  type VisionImageNormalizeOptions,
} from './image.ts';

export type VisionOcrErrorCode =
  | 'invalid_config'
  | 'weak_model_rejected'
  | 'image_error'
  | 'network_error'
  | 'http_error'
  | 'timeout'
  | 'invalid_response';

export class VisionOcrError extends Error {
  readonly code: VisionOcrErrorCode;
  constructor(code: VisionOcrErrorCode, message: string) {
    super(message);
    this.name = 'VisionOcrError';
    this.code = code;
  }
}

const weakVisionModelPattern = /(^|[/:_.-])(flash|mini|nano|lite|haiku|small|tiny|fast|quick|cheap|turbo|instant)(?=$|[/:_.-])/i;

export function isWeakVisionModel(model: string): boolean {
  return weakVisionModelPattern.test(model);
}

export type VisionLlmConfig = {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly allowWeakModel?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
};

export function resolveVisionChatCompletionsUrl(baseUrl: string): URL {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new VisionOcrError('invalid_config', '强视觉模型 baseUrl 为空。');
  }
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new VisionOcrError('invalid_config', `强视觉模型 baseUrl 无法解析：${baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new VisionOcrError('invalid_config', `强视觉模型 baseUrl 仅支持 http/https，当前为 ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new VisionOcrError('invalid_config', '强视觉模型 baseUrl 不允许内嵌用户名或密码。');
  }
  const trimmedPath = url.pathname.replace(/\/+$/, '');
  if (trimmedPath.endsWith('/chat/completions')) {
    url.pathname = trimmedPath;
  } else {
    url.pathname = `${trimmedPath}/chat/completions`;
  }
  return url;
}

export function readVisionLlmConfigFromEnv(env?: Record<string, string | undefined>): VisionLlmConfig | null {
  const source = env ?? process.env;
  const baseUrl = source.MANGEKYO_VISION_OCR_BASE_URL?.trim();
  const model = source.MANGEKYO_VISION_OCR_MODEL?.trim();
  if (!baseUrl || !model) return null;
  const apiKey = source.MANGEKYO_VISION_OCR_API_KEY?.trim();
  return { baseUrl, model, ...(apiKey ? { apiKey } : {}) };
}

export type VisionPaperLlmCallInput = {
  readonly bytes: Buffer;
  readonly config: VisionLlmConfig;
  readonly systemPrompt?: string | undefined;
  readonly userPrompt?: string | undefined;
  readonly messages?: readonly unknown[] | undefined;
  readonly imageOptions?: VisionImageNormalizeOptions | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fetch?: typeof fetch | undefined;
};

export type VisionPaperLlmCallResult = {
  readonly rawText: string;
  readonly model: string;
  readonly normalized: NormalizedVisionImage;
  readonly elapsedMs: number;
  readonly usage?:
    | {
        readonly promptTokens?: number;
        readonly completionTokens?: number;
        readonly totalTokens?: number;
      }
    | undefined;
};

const defaultTimeoutMs = 180_000;

const defaultVisionSystemPrompt =
  '你是一位严谨的试卷图像结构化识别引擎。你的任务是逐题还原试卷照片里的全部内容，仅输出一个严格的 JSON 对象，不要输出任何 JSON 以外的文字或 Markdown 围栏。';

const defaultVisionUserPrompt = `请把这张试卷照片结构化识别为严格 JSON。要求：
1. 输出单个 JSON 对象，禁止 Markdown 代码块围栏、禁止任何解释性文字。
2. JSON 结构：
{
  "version": "vision-paper-ocr-v1",
  "paperTitle": string | null,
  "subject": string | null,
  "pageNote": string | null,
  "questions": [
    {
      "number": string,
      "questionType": "single_choice" | "multiple_choice" | "fill_blank" | "short_answer" | "calculation" | "proof" | "code" | "other",
      "stem": string,
      "options": [{ "label": string, "text": string }],
      "studentAnswer": { "status": "present" | "unclear" | "absent", "text": string | null, "note"?: string },
      "redInk": { "verdict": "correct" | "wrong" | "partial" | "none" | "unclear", "marks": string[], "correction": string | null, "score": string | null },
      "unclearSegments": string[]
    }
  ],
  "freeformText": string | null,
  "warnings": string[]
}
3. 所有数学、物理、化学公式一律用精确 LaTeX（行内 $...$，独立公式 $$...$$），Python/代码与流程图逻辑逐字保留（代码块用三重反引号）。
4. 黑色/蓝色手写作答（studentAnswer）与红色批改/订正/分数/对错符号（redInk）必须严格分离，不得混写。
5. 看不清、反光或被遮挡的内容严禁编造，学生作答看不清必须如实标 {"status":"unclear","text":null} 并写入 unclearSegments；红笔看不清把 redInk.verdict 标为 "unclear"。
6. 若为纯讲义/非题目材料，正文放 freeformText，questions 放空数组；两者至少其一非空。`;

function clampNumber(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

type JsonRecord = Record<string, unknown>;

function buildMessages(input: VisionPaperLlmCallInput, dataUrl: string): unknown[] {
  if (input.messages && input.messages.length > 0) return [...input.messages];
  const systemPrompt = input.systemPrompt ?? defaultVisionSystemPrompt;
  const userPrompt = input.userPrompt ?? defaultVisionUserPrompt;
  const messages: JsonRecord[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: userPrompt },
      { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
    ],
  });
  return messages;
}

function extractMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part && typeof part === 'object') {
        const record = part as JsonRecord;
        if (typeof record.text === 'string') parts.push(record.text);
      }
    }
    return parts.join('');
  }
  return '';
}

function pickUsageNumber(record: JsonRecord, key: string) {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseUsage(raw: unknown): VisionPaperLlmCallResult['usage'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as JsonRecord;
  const promptTokens = pickUsageNumber(record, 'prompt_tokens');
  const completionTokens = pickUsageNumber(record, 'completion_tokens');
  const totalTokens = pickUsageNumber(record, 'total_tokens');
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function timeoutMessage(ms: number) {
  return `强视觉模型请求超过 ${Math.round(ms / 1000)} 秒未返回。`;
}

function isAbortLike(error: unknown) {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export async function callVisionPaperOcr(input: VisionPaperLlmCallInput): Promise<VisionPaperLlmCallResult> {
  const config = input.config;
  if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) {
    throw new VisionOcrError('invalid_config', '强视觉模型 baseUrl 为空。');
  }
  if (typeof config.model !== 'string' || !config.model.trim()) {
    throw new VisionOcrError('invalid_config', '强视觉模型 model 为空。');
  }
  const model = config.model.trim();
  if (isWeakVisionModel(model) && config.allowWeakModel !== true) {
    throw new VisionOcrError(
      'weak_model_rejected',
      `模型 ${model} 属于弱视觉模型，不允许用于试卷 OCR；如需强制使用请显式设置 allowWeakModel。`,
    );
  }
  const url = resolveVisionChatCompletionsUrl(config.baseUrl);
  const fetchImpl = input.fetch ?? fetch;
  const timeoutMs = clampNumber(config.timeoutMs, defaultTimeoutMs, 1000, 600_000);

  let normalized: NormalizedVisionImage;
  try {
    normalized = await normalizeImageForVisionOcr(input.bytes, input.imageOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new VisionOcrError('image_error', `图像预处理失败：${message}`);
  }

  const controller = new AbortController();
  const externalSignal = input.signal;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) throw externalSignal.reason ?? new DOMException('Aborted', 'AbortError');
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new VisionOcrError('timeout', timeoutMessage(timeoutMs))), timeoutMs);

  const startedAt = Date.now();
  let response: Response;
  let payload: JsonRecord;
  try {
    const body: JsonRecord = {
      model,
      messages: buildMessages(input, normalized.dataUrl),
      max_tokens: clampNumber(config.maxTokens, 8192, 256, 128_000),
      temperature: clampNumber(config.temperature, 0, 0, 2),
      stream: false,
    };
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new VisionOcrError(
        'http_error',
        `强视觉模型返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`,
      );
    }
    try {
      payload = (await response.json()) as JsonRecord;
    } catch (jsonError) {
      if (externalSignal?.aborted) throw externalSignal.reason ?? jsonError;
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof VisionOcrError ? reason : new VisionOcrError('timeout', timeoutMessage(timeoutMs));
      }
      throw new VisionOcrError('invalid_response', '强视觉模型返回的不是合法 JSON。');
    }
  } catch (error) {
    if (externalSignal?.aborted) throw externalSignal.reason ?? error;
    if (error instanceof VisionOcrError) throw error;
    if (isAbortLike(error) || controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof VisionOcrError ? reason : new VisionOcrError('timeout', timeoutMessage(timeoutMs));
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new VisionOcrError('network_error', `强视觉模型请求失败：${message}`);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
  const elapsedMs = Date.now() - startedAt;
  const choices = payload.choices;
  const first = Array.isArray(choices) && choices.length > 0 ? (choices[0] as JsonRecord) : null;
  const message = first && typeof first === 'object' ? (first.message as JsonRecord | undefined) : undefined;
  const rawText = message ? extractMessageContent(message.content) : '';
  if (!rawText || !rawText.trim()) {
    throw new VisionOcrError('invalid_response', '强视觉模型返回了空的识别内容。');
  }
  const responseModel = typeof payload.model === 'string' && payload.model ? payload.model : model;
  return {
    rawText,
    model: responseModel,
    normalized,
    elapsedMs,
    usage: parseUsage(payload.usage),
  };
}

export type LocalExtractionResult = Awaited<ReturnType<typeof extractLocalDocument>>;

export type PhotoVisionExtractionInput<TParsed = unknown> = {
  readonly bytes: Buffer;
  readonly storedPath: string;
  readonly textLimit: number;
  readonly visionConfig?: VisionLlmConfig | null | undefined;
  readonly systemPrompt?: string | undefined;
  readonly userPrompt?: string | undefined;
  readonly imageOptions?: VisionImageNormalizeOptions | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly fallbackExtractLocal?: typeof extractLocalDocument | undefined;
  readonly parseStructuredOutput?: ((rawText: string) => TParsed) | undefined;
};

export type PhotoVisionExtractionResult<TParsed = unknown> =
  | {
      readonly kind: 'vision_llm';
      readonly rawText: string;
      readonly parsed: TParsed;
      readonly model: string;
      readonly normalized: NormalizedVisionImage;
      readonly elapsedMs: number;
      readonly usage?: VisionPaperLlmCallResult['usage'];
    }
  | {
      readonly kind: 'vision_fallback';
      readonly fallbackReason: string;
      readonly local: LocalExtractionResult;
      readonly normalized: NormalizedVisionImage | null;
    };

function stripCodeFence(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

function extractJsonObject(text: string): unknown {
  const stripped = stripCodeFence(text);
  try {
    return JSON.parse(stripped);
  } catch {
    const first = stripped.indexOf('{');
    const last = stripped.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(stripped.slice(first, last + 1));
    }
    throw new Error('响应中找不到 JSON 对象。');
  }
}

function fallbackReasonOf(error: unknown): string {
  if (error instanceof VisionOcrError) {
    switch (error.code) {
      case 'weak_model_rejected':
      case 'invalid_config':
        return error.message;
      case 'timeout':
        return `强视觉模型请求超时，${error.message}`;
      case 'network_error':
        return `强视觉模型远端不可达，${error.message}`;
      case 'http_error':
        return `强视觉模型服务异常，${error.message}`;
      case 'image_error':
        return `图像预处理失败，${error.message}`;
      case 'invalid_response':
        return `强视觉模型结果无效，${error.message}`;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return `强视觉识别失败：${message}`;
}

export async function extractPhotoWithVisionOrFallback<TParsed = unknown>(
  input: PhotoVisionExtractionInput<TParsed>,
): Promise<PhotoVisionExtractionResult<TParsed>> {
  const localExtract = input.fallbackExtractLocal ?? extractLocalDocument;
  const runLocal = () => localExtract('image', input.storedPath, input.bytes, input.textLimit);

  if (input.signal?.aborted) {
    throw input.signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  if (input.visionConfig == null) {
    return {
      kind: 'vision_fallback',
      fallbackReason: '未配置强视觉模型，已自动回退本地 Apple Vision 识别。',
      local: await runLocal(),
      normalized: null,
    };
  }

  let normalized: NormalizedVisionImage | null = null;
  try {
    const result = await callVisionPaperOcr({
      bytes: input.bytes,
      config: input.visionConfig,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.userPrompt !== undefined ? { userPrompt: input.userPrompt } : {}),
      ...(input.imageOptions !== undefined ? { imageOptions: input.imageOptions } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    });
    normalized = result.normalized;
    let parsed: TParsed;
    if (input.parseStructuredOutput) {
      parsed = input.parseStructuredOutput(result.rawText);
    } else {
      const value = extractJsonObject(result.rawText);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new VisionOcrError('invalid_response', '强视觉模型响应不是 JSON 对象。');
      }
      parsed = value as TParsed;
    }
    return {
      kind: 'vision_llm',
      rawText: result.rawText,
      parsed,
      model: result.model,
      normalized: result.normalized,
      elapsedMs: result.elapsedMs,
      usage: result.usage,
    };
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    const reason = fallbackReasonOf(error);
    return {
      kind: 'vision_fallback',
      fallbackReason: `${reason} 已自动无损回退本地 Apple Vision 识别。`,
      local: await runLocal(),
      normalized,
    };
  }
}
