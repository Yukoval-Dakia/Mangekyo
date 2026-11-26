export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/** Returns trimmed non-empty string, or undefined. */
export function readTrimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Returns original string when non-blank, otherwise fallback. */
export function readNonEmptyString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

/** Returns string or empty string (preserves whitespace when needed). */
export function readRawString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Picks the first trimmed non-empty string among candidate keys on a record. */
export function pickString(record: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const clean = readTrimmed(record[key]);
    if (clean !== undefined) return clean;
  }
  return undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readNumeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function readSafeInt(value: unknown, min?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined;
  if (min !== undefined && value < min) return undefined;
  return value;
}

export function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function readStringList(value: unknown, dedupe = false): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    const clean = readTrimmed(entry);
    if (clean && (!dedupe || !items.includes(clean))) items.push(clean);
  }
  return items;
}

export function readArray<T>(
  value: unknown,
  mapper: (entry: unknown, index: number) => T | null | undefined,
): T[] {
  if (!Array.isArray(value)) return [];
  const result: T[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const mapped = mapper(value[i], i);
    if (mapped !== null && mapped !== undefined) result.push(mapped);
  }
  return result;
}

export function safeParseJson<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function normalizeConceptTags(tags: readonly string[] | undefined, max = 6): string[] {
  return [...new Set(tags?.map((tag) => tag.trim()).filter(Boolean) ?? [])].slice(0, max);
}

export function readFileAsDataUrl(file: File, errorMessage = '图片预览读取失败'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error(errorMessage));
    };
    reader.onerror = () => reject(reader.error ?? new Error(errorMessage));
    reader.readAsDataURL(file);
  });
}

export type QuickPaperResult =
  | { readonly kind: 'paper'; readonly paperId: string; readonly href?: string }
  | { readonly kind: 'empty'; readonly message: string };

export function parseQuickPaperResponse(
  result: unknown,
  emptyFallback = '该知识点暂时还没有可自测的题目。',
): QuickPaperResult {
  if (!isRecord(result)) throw new Error('抽题响应格式无法识别。');
  if (result.kind === 'empty') {
    const message = pickString(result, 'reason', 'message') ?? emptyFallback;
    return { kind: 'empty', message };
  }
  const nestedId = isRecord(result.paper) ? result.paper.id : undefined;
  const paperId = readTrimmed(result.paperId ?? nestedId ?? result.id);
  if (paperId) {
    const href = readTrimmed(result.href);
    return { kind: 'paper', paperId, ...(href ? { href } : {}) };
  }
  throw new Error('抽题响应未包含试卷标识。');
}

export async function fetchOptionalJson(url: string, signal?: AbortSignal): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !contentType.toLowerCase().includes('json')) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  }
}

export type StructuredBankAnswerRow = {
  readonly slotId: string;
  readonly path: string;
  readonly value: Record<string, unknown>;
};

export function parseStructuredBankAnswerRows(raw: string, emptyAsArray = false): StructuredBankAnswerRow[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return emptyAsArray ? [] : null;
  if (!trimmed.startsWith('[')) return null;
  const parsed = safeParseJson<unknown>(trimmed);
  if (!Array.isArray(parsed)) return null;
  const rows: StructuredBankAnswerRow[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.slotId !== 'string' || typeof entry.path !== 'string' || !isRecord(entry.value)) {
      return null;
    }
    rows.push({ slotId: entry.slotId, path: entry.path, value: entry.value });
  }
  return rows;
}
