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
  readonly finishReason?: string | null | undefined;
  readonly usage?:
    | {
        readonly promptTokens?: number;
        readonly completionTokens?: number;
        readonly totalTokens?: number;
      }
    | undefined;
};

const defaultTimeoutMs = 90_000;
const defaultMaxTokens = 16_384;
const maxRetryTokens = 32_768;
const minRetryBudgetMs = 20_000;

const defaultVisionSystemPrompt =
  '你是严谨的试卷结构化OCR引擎。只输出单个合法JSON对象，禁止Markdown围栏与多余文字；直接忠实转写，不要冗长思考。';

const defaultVisionUserPrompt = `请按双栏顺序完整识别这张试卷照片，直接输出严格 JSON：
1. 仔细扫描整张图片（注意双栏排版：先左栏从上到下，再右栏从上到下；左栏末题的选项可能跨到右栏顶部），完整输出所有可见题目，不遗漏也不编造被裁切的题。
2. 印刷题干与选项中的公式用精确 LaTeX（行内 $...$，独立公式 $$...$$）；代码与流程图逻辑用三重反引号逐字保留。
3. 严格分离学生黑笔/铅笔作答（studentAnswer）与红笔批改/订正（redInk），不得混写。
4. 反光、遮挡或潦草看不清处严禁猜测，学生作答标 {"status":"unclear","text":null} 并写入 unclearSegments；红笔看不清把 redInk.verdict 标为 "unclear"。
5. 若为纯讲义/非题目材料，正文放 freeformText，questions 放空数组；两者至少其一非空。
JSON 结构：{"version":"vision-paper-ocr-v1","paperTitle":string|null,"subject":string|null,"pageNote":string|null,"questions":[{"number":string,"questionType":"single_choice"|"multiple_choice"|"fill_blank"|"short_answer"|"calculation"|"proof"|"code"|"other","stem":string,"options":[{"label":string,"text":string}],"studentAnswer":{"status":"present"|"unclear"|"absent","text":string|null,"note"?:string},"redInk":{"verdict":"correct"|"wrong"|"partial"|"none"|"unclear","marks":string[],"correction":string|null,"score":string|null},"unclearSegments":string[]}],"freeformText":string|null,"warnings":string[]}`;

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
      max_tokens: clampNumber(config.maxTokens, defaultMaxTokens, 256, 128_000),
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
  const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason : null;
  return {
    rawText,
    model: responseModel,
    normalized,
    elapsedMs,
    finishReason,
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

function stripLeadingFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)(?:\r?\n?```)?$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/**
 * When a vision model hits `finish_reason === 'length'` mid-JSON inside `"questions": [...]`,
 * recover all fully closed question objects emitted before truncation so we keep crisp LaTeX
 * output with an honest warning instead of throwing everything away into garbled fallback.
 */
export function repairTruncatedQuestionsJson(rawText: string): string | null {
  const source = stripLeadingFence(rawText);
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const objStart = source.indexOf('{', searchFrom);
    if (objStart < 0) return null;

    let inString = false;
    let escaped = false;
    let depth = 0;
    let questionsKeyStart = -1;
    let questionsArrayStart = -1;
    let expectingColon = false;
    let expectingArray = false;
    let stringStart = -1;
    let scanEnd = source.length;

    for (let i = objStart; i < source.length; i += 1) {
      const ch = source[i]!;
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') {
          inString = false;
          if (depth === 1 && stringStart >= 0) {
            const key = source.slice(stringStart + 1, i);
            if (key === 'questions') {
              questionsKeyStart = stringStart;
              expectingColon = true;
            }
          }
          stringStart = -1;
        }
        continue;
      }
      if (expectingColon) {
        if (ch === ':') { expectingColon = false; expectingArray = true; continue; }
        if (/\s/.test(ch)) continue;
        expectingColon = false;
        questionsKeyStart = -1;
      }
      if (expectingArray) {
        if (ch === '[') { questionsArrayStart = i; depth += 1; break; }
        if (/\s/.test(ch)) continue;
        expectingArray = false;
        questionsKeyStart = -1;
      }
      if (ch === '"') {
        inString = true;
        stringStart = i;
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth <= 0) { scanEnd = i + 1; break; }
      }
    }

    if (questionsArrayStart < 0 || questionsKeyStart < 0) {
      searchFrom = Math.max(scanEnd, objStart + 1);
      continue;
    }

    const recoveredQuestions: unknown[] = [];
    inString = false;
    escaped = false;
    let itemDepth = 0;
    let itemStart = -1;

    for (let i = questionsArrayStart + 1; i < source.length; i += 1) {
      const ch = source[i]!;
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') {
        if (itemDepth === 0) itemStart = i;
        itemDepth += 1;
        continue;
      }
      if (ch === '}') {
        if (itemDepth === 0) break;
        itemDepth -= 1;
        if (itemDepth === 0 && itemStart >= 0) {
          try {
            const parsedItem: unknown = JSON.parse(source.slice(itemStart, i + 1));
            if (parsedItem && typeof parsedItem === 'object' && !Array.isArray(parsedItem)) {
              recoveredQuestions.push(parsedItem);
            }
          } catch {
            // Ignore malformed element.
          }
          itemStart = -1;
        }
        continue;
      }
      if (ch === ']' && itemDepth === 0) break;
    }

    if (recoveredQuestions.length === 0) {
      searchFrom = Math.max(scanEnd, objStart + 1);
      continue;
    }

    let prefix: JsonRecord = {};
    const rawPrefix = source.slice(objStart, questionsKeyStart).replace(/,\s*$/, '').trim();
    if (rawPrefix.startsWith('{')) {
      try {
        const parsedPrefix: unknown = JSON.parse(`${rawPrefix}}`);
        if (parsedPrefix && typeof parsedPrefix === 'object' && !Array.isArray(parsedPrefix)) {
          prefix = parsedPrefix as JsonRecord;
        }
      } catch {
        prefix = {};
      }
    }

    return JSON.stringify({
      version: typeof prefix.version === 'string' ? prefix.version : 'vision-paper-ocr-v1',
      paperTitle: typeof prefix.paperTitle === 'string' ? prefix.paperTitle : null,
      subject: typeof prefix.subject === 'string' ? prefix.subject : null,
      pageNote: typeof prefix.pageNote === 'string' ? prefix.pageNote : null,
      questions: recoveredQuestions,
      freeformText: null,
      warnings: [`视觉模型输出达到长度上限，已保留前 ${recoveredQuestions.length} 道完整识别的题目，尾部内容请核对原件。`],
    });
  }

  return null;
}

function parseVisionOutput<TParsed>(
  rawText: string,
  parseStructuredOutput: ((rawText: string) => TParsed) | undefined,
): TParsed {
  if (parseStructuredOutput) {
    return parseStructuredOutput(rawText);
  }
  const value = extractJsonObject(rawText);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VisionOcrError('invalid_response', '强视觉模型响应不是 JSON 对象。');
  }
  return value as TParsed;
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
    const budgetMs = clampNumber(input.visionConfig.timeoutMs, defaultTimeoutMs, 1000, 600_000);
    const initialMaxTokens = clampNumber(input.visionConfig.maxTokens, defaultMaxTokens, 256, 128_000);
    const invoke = (config: VisionLlmConfig) => callVisionPaperOcr({
      bytes: input.bytes,
      config,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.userPrompt !== undefined ? { userPrompt: input.userPrompt } : {}),
      ...(input.imageOptions !== undefined ? { imageOptions: input.imageOptions } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    });

    const firstResult = await invoke({ ...input.visionConfig, maxTokens: initialMaxTokens, timeoutMs: budgetMs });
    let result = firstResult;
    normalized = firstResult.normalized;
    let totalElapsedMs = firstResult.elapsedMs;

    const trySalvage = (candidate: VisionPaperLlmCallResult): TParsed | null => {
      if (candidate.finishReason !== 'length') return null;
      const repaired = repairTruncatedQuestionsJson(candidate.rawText);
      if (repaired === null) return null;
      try {
        return parseVisionOutput(repaired, input.parseStructuredOutput);
      } catch {
        return null;
      }
    };

    let parsed: TParsed;
    try {
      parsed = parseVisionOutput(firstResult.rawText, input.parseStructuredOutput);
    } catch (firstParseError) {
      if (input.signal?.aborted) throw input.signal.reason ?? firstParseError;
      const truncatedByLength = firstResult.finishReason === 'length';
      const remainingMs = budgetMs - totalElapsedMs;
      if (truncatedByLength && initialMaxTokens < maxRetryTokens && remainingMs >= minRetryBudgetMs) {
        const retryMaxTokens = Math.min(maxRetryTokens, initialMaxTokens * 2);
        let retryResult: VisionPaperLlmCallResult | null = null;
        try {
          retryResult = await invoke({
            ...input.visionConfig,
            maxTokens: retryMaxTokens,
            timeoutMs: remainingMs,
          });
          totalElapsedMs += retryResult.elapsedMs;
          parsed = parseVisionOutput(retryResult.rawText, input.parseStructuredOutput);
          result = retryResult;
          normalized = retryResult.normalized;
        } catch (retryError) {
          if (input.signal?.aborted) throw input.signal.reason ?? retryError;
          const retrySalvaged = retryResult ? trySalvage(retryResult) : null;
          if (retrySalvaged !== null && retryResult) {
            parsed = retrySalvaged;
            result = retryResult;
            normalized = retryResult.normalized;
          } else {
            const firstSalvaged = trySalvage(firstResult);
            if (firstSalvaged === null) throw retryError;
            parsed = firstSalvaged;
          }
        }
      } else if (truncatedByLength) {
        const firstSalvaged = trySalvage(firstResult);
        if (firstSalvaged === null) throw firstParseError;
        parsed = firstSalvaged;
      } else {
        throw firstParseError;
      }
    }
    return {
      kind: 'vision_llm',
      rawText: result.rawText,
      parsed,
      model: result.model,
      normalized: result.normalized,
      elapsedMs: totalElapsedMs,
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
