import { useEffect, useMemo, useState } from 'react';
import { remember, remembered } from '../api';
import { Icon } from '../icons';
import { answerKey, forgetPackDrafts, recoverDraft } from '../today-draft';
import { Dot, isTechnicalIdentifier } from './shared';

/** 离开未完成练习超过 20 分钟后触发「10 秒无痛续场卡」（0 LLM，<150ms）。 */
export const RESUME_THRESHOLD_MS = 20 * 60_000;

const SESSION_DISMISSED_KEY = 'mangekyo:resume-breadcrumb:dismissed';
const REENTRY_STORAGE_PREFIX = 'mangekyo:reentry:';
const MAX_EXCERPT_CHARS = 24;

export type ResumeBreadcrumbSnapshot = {
  /** 本条续场信号的稳定标识，用于单会话收起与去重。 */
  readonly id: string;
  /** 活动形态（试卷 / 课堂 / 短练 / 通用活动）。 */
  readonly kind?: 'paper' | 'classroom' | 'pack' | 'activity' | string | undefined;
  /** 所属活动标题（人类可读，自动过滤技术 ID）。 */
  readonly activityTitle?: string | undefined;
  /** 当前停留题目或步骤的 ID。 */
  readonly itemId?: string | undefined;
  /** 人类可读停驻位置（如“第 3 题”或步骤标题）。 */
  readonly itemLabel?: string | undefined;
  /** 1-based 题号，缺省 itemLabel 时自动拼为“第 N 题”。 */
  readonly itemIndex?: number | undefined;
  /** 已展提示计数。 */
  readonly openedHints?: number | undefined;
  /** 原位草稿文本摘要。 */
  readonly draftExcerpt?: string | undefined;
  /** 点击「继续这步」时跳转的目标地址。 */
  readonly href?: string | undefined;
  /** 上次停留时间戳（毫秒 epoch 或 ISO 时间字符串）。 */
  readonly lastActionAt: number | string;
  /** 供「盖住重做」清理的本机 localStorage 键列表。 */
  readonly storageKeys?: readonly string[] | undefined;
  /** 若来源为 today-draft 短练，供 forgetPackDrafts 清理的 key。 */
  readonly packDraftKey?: string | undefined;
};

export type ResumeActiveRoom = {
  readonly id: string;
  readonly topic: string;
  readonly activeStepTitle?: string | undefined;
};

export type ResumeBreadcrumbProps = {
  /** 可选：后端或上层直接透传的续场锚点；缺省时自动检查本机 localStorage 既有草稿与续场记录。 */
  readonly reentry?: ResumeBreadcrumbSnapshot | null | undefined;
  readonly activeRoom?: ResumeActiveRoom | null | undefined;
  readonly candidateTitles?: ReadonlyMap<string, string> | undefined;
  readonly nowMs?: number | undefined;
  readonly onNavigate?: ((href: string) => void) | undefined;
  readonly onFocusDraft?: ((snapshot: ResumeBreadcrumbSnapshot) => void) | undefined;
  readonly onCoverRedo?: ((snapshot: ResumeBreadcrumbSnapshot) => void) | undefined;
};

type StoredReentryRecord = {
  binding?: unknown;
  itemId?: unknown;
  lastActionAt?: unknown;
  openedHints?: unknown;
  helpExposure?: unknown;
  draftExcerpt?: unknown;
  scratch?: unknown;
  itemLabel?: unknown;
  label?: unknown;
  itemIndex?: unknown;
  href?: unknown;
  activityTitle?: unknown;
};

type StoredPaperDraft = {
  requestId?: unknown;
  answers?: Record<string, unknown>;
  scratch?: Record<string, unknown>;
  currentItem?: unknown;
  frozenSubmission?: unknown;
  openedHints?: unknown;
  helpExposure?: unknown;
};

function parseTimestampMs(value: number | string | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function isResumeDue(lastActionAt: number | string | undefined, nowMs = Date.now()): boolean {
  const ts = parseTimestampMs(lastActionAt);
  if (ts === null) return false;
  return nowMs - ts >= RESUME_THRESHOLD_MS;
}

function cleanHumanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || isTechnicalIdentifier(trimmed)) return undefined;
  return trimmed;
}

function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return undefined;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  return undefined;
}

function countOpenedHints(raw: unknown, itemId?: string): number | undefined {
  const direct = nonNegativeInt(raw);
  if (direct !== undefined) return direct;
  if (Array.isArray(raw)) return raw.length;
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (itemId && itemId in record) {
      const entry = record[itemId];
      const byItem = nonNegativeInt(entry);
      if (byItem !== undefined) return byItem;
      if (entry && typeof entry === 'object' && 'count' in entry) {
        const count = nonNegativeInt((entry as { count?: unknown }).count);
        if (count !== undefined) return count;
      }
      if (entry) return 1;
    }
    const keys = Object.keys(record).filter((key) => Boolean(record[key]));
    if (keys.length > 0) return keys.length;
  }
  return undefined;
}

function inferItemIndex(itemId: string | undefined, draft?: StoredPaperDraft | null): number | undefined {
  if (!itemId) return undefined;
  const numericMatch = /^(?:q|item|question|step)[-_:]?(\d+)$/i.exec(itemId.trim());
  if (numericMatch?.[1]) {
    const parsed = Number(numericMatch[1]);
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed;
  }
  if (draft?.answers && typeof draft.answers === 'object' && !Array.isArray(draft.answers)) {
    const keys = Object.keys(draft.answers);
    const position = keys.indexOf(itemId);
    if (position >= 0) return position + 1;
  }
  return undefined;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeExcerpt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.trim().replace(/\s+/g, ' ');
  return collapsed.length > 0 ? collapsed : undefined;
}

function clipExcerpt(text: string): string {
  const chars = [...text];
  return chars.length > MAX_EXCERPT_CHARS
    ? `${chars.slice(0, MAX_EXCERPT_CHARS).join('')}…`
    : text;
}

export function formatResumeLine(snapshot: ResumeBreadcrumbSnapshot): string {
  const title = cleanHumanText(snapshot.activityTitle);
  const label = cleanHumanText(snapshot.itemLabel);
  const index = positiveInt(snapshot.itemIndex);

  let anchor: string;
  if (label) {
    if (label.startsWith('上次停在')) {
      anchor = label;
    } else if (/^第\s*\d+\s*[题步节]/.test(label)) {
      anchor = title && !label.includes(title) ? `上次停在「${title}」${label}` : `上次停在${label}`;
    } else if (title && title !== label) {
      anchor = `上次停在「${title}」· ${label}`;
    } else {
      anchor = `上次停在「${label}」`;
    }
  } else if (index !== undefined) {
    anchor = title ? `上次停在「${title}」第 ${index} 题` : `上次停在第 ${index} 题`;
  } else if (title) {
    anchor = `上次停在「${title}」`;
  } else {
    anchor = '上次停在未完成的练习';
  }

  const parts = [anchor];
  const hints = nonNegativeInt(snapshot.openedHints);
  if (hints !== undefined && hints > 0) {
    parts.push(`已展提示 ${hints}`);
  }
  const excerpt = safeExcerpt(snapshot.draftExcerpt);
  if (excerpt) {
    parts.push(`草稿停在“${clipExcerpt(excerpt)}”`);
  }
  return parts.join(' · ');
}

function safeHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return undefined;
  return trimmed;
}

function readCandidateFromReentryKey(
  storageKey: string,
  nowMs: number,
  activeRoom: ResumeActiveRoom | null | undefined,
  candidateTitles: ReadonlyMap<string, string> | undefined,
): { ts: number; snapshot: ResumeBreadcrumbSnapshot } | null {
  const slot = storageKey.slice(REENTRY_STORAGE_PREFIX.length);
  if (!slot) return null;
  const record = parseJson<StoredReentryRecord>(localStorage.getItem(storageKey));
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const ts = parseTimestampMs(
    typeof record.lastActionAt === 'number' || typeof record.lastActionAt === 'string'
      ? record.lastActionAt
      : undefined,
  );
  if (ts === null || nowMs - ts < RESUME_THRESHOLD_MS) return null;

  const itemId = typeof record.itemId === 'string' && record.itemId.trim() ? record.itemId.trim() : undefined;
  const explicitExcerpt = safeExcerpt(record.draftExcerpt) ?? safeExcerpt(record.scratch);
  const explicitLabel = cleanHumanText(record.itemLabel) ?? cleanHumanText(record.label);
  const explicitIndex = positiveInt(record.itemIndex);
  const explicitTitle = cleanHumanText(record.activityTitle);
  const explicitHref = safeHref(record.href);
  const explicitHints = countOpenedHints(record.openedHints ?? record.helpExposure, itemId);

  if (slot.startsWith('paper:')) {
    const paperId = slot.slice('paper:'.length);
    if (!paperId) return null;
    const draftStorageKey = `mangekyo:workbook:paper:${paperId}:draft`;
    const draft = parseJson<StoredPaperDraft>(localStorage.getItem(draftStorageKey));
    if (draft?.frozenSubmission === true) return null;

    const effectiveItemId = itemId ?? (typeof draft?.currentItem === 'string' ? draft.currentItem : undefined);
    const wbv2ScratchKey = effectiveItemId ? `wbv2-scratch:${paperId}:${effectiveItemId}` : null;
    const wbv2Scratch = wbv2ScratchKey ? localStorage.getItem(wbv2ScratchKey) : null;
    const draftScratch =
      effectiveItemId && draft?.scratch && typeof draft.scratch === 'object'
        ? draft.scratch[effectiveItemId]
        : undefined;
    const draftAnswer =
      effectiveItemId && draft?.answers && typeof draft.answers === 'object'
        ? draft.answers[effectiveItemId]
        : undefined;
    const excerpt = explicitExcerpt ?? safeExcerpt(draftScratch) ?? safeExcerpt(wbv2Scratch) ?? safeExcerpt(draftAnswer);
    const hasPaperEvidence = Boolean(draft || excerpt || explicitLabel || explicitIndex !== undefined);
    if (!hasPaperEvidence) return null;

    const storageKeys = [storageKey];
    if (draft) storageKeys.push(draftStorageKey);
    if (wbv2ScratchKey && wbv2Scratch !== null) storageKeys.push(wbv2ScratchKey);

    const itemIndex = explicitIndex ?? inferItemIndex(effectiveItemId, draft);
    const openedHints = explicitHints ?? countOpenedHints(draft?.openedHints ?? draft?.helpExposure, effectiveItemId);
    const activityTitle = explicitTitle ?? cleanHumanText(candidateTitles?.get(paperId));
    const href = explicitHref ?? `/papers/${encodeURIComponent(paperId)}`;

    return {
      ts,
      snapshot: {
        id: `reentry:${slot}`,
        kind: 'paper',
        ...(activityTitle ? { activityTitle } : {}),
        ...(effectiveItemId ? { itemId: effectiveItemId } : {}),
        ...(explicitLabel ? { itemLabel: explicitLabel } : {}),
        ...(itemIndex !== undefined ? { itemIndex } : {}),
        ...(openedHints !== undefined ? { openedHints } : {}),
        ...(excerpt ? { draftExcerpt: excerpt } : {}),
        href,
        lastActionAt: ts,
        storageKeys,
      },
    };
  }

  if (slot.startsWith('pack:')) {
    const packId = slot.slice('pack:'.length);
    const binding = parseJson<unknown>(typeof record.binding === 'string' ? record.binding : null);
    if (!Array.isArray(binding) || typeof binding[0] !== 'string' || !Number.isSafeInteger(binding[1])) {
      return null;
    }
    const boundId = binding[0];
    const boundRev = binding[1] as number;
    const boundReqId = typeof binding[2] === 'string' ? binding[2] : null;
    const recovered = recoverDraft({ id: boundId, rev: boundRev }, boundReqId);
    const scratchKeyName = `today-pack-scratch:${encodeURIComponent(boundId)}@${boundRev}`;
    const packScratch = remembered(scratchKeyName);
    const excerpt = explicitExcerpt ?? safeExcerpt(packScratch);
    if ((!recovered || recovered.pending) && !excerpt) return null;

    const packDraftKey = answerKey({ id: boundId, rev: boundRev });
    const storageKeys = [storageKey];
    if (packScratch !== null) storageKeys.push(`mangekyo:${scratchKeyName}`);
    const activityTitle = explicitTitle ?? cleanHumanText(candidateTitles?.get(packId));
    const href =
      explicitHref ??
      `/today?mode=any&kind=pack&id=${encodeURIComponent(boundId)}&rev=${boundRev}`;

    return {
      ts,
      snapshot: {
        id: `reentry:${slot}`,
        kind: 'pack',
        ...(activityTitle ? { activityTitle } : {}),
        ...(itemId ? { itemId } : {}),
        ...(explicitLabel ? { itemLabel: explicitLabel } : {}),
        ...(explicitIndex !== undefined ? { itemIndex: explicitIndex } : {}),
        ...(explicitHints !== undefined ? { openedHints: explicitHints } : {}),
        ...(excerpt ? { draftExcerpt: excerpt } : {}),
        href,
        lastActionAt: ts,
        storageKeys,
        packDraftKey,
      },
    };
  }

  if (slot.startsWith('classroom:')) {
    const roomId = slot.slice('classroom:'.length);
    if (!roomId) return null;
    const matchesActiveRoom = activeRoom?.id === roomId;
    if (!matchesActiveRoom && !explicitExcerpt && !explicitLabel) return null;
    const activityTitle = explicitTitle ?? (matchesActiveRoom ? cleanHumanText(activeRoom.topic) : undefined);
    const itemLabel = explicitLabel ?? (matchesActiveRoom ? cleanHumanText(activeRoom.activeStepTitle) : undefined);
    const href =
      explicitHref ??
      `/classroom/${encodeURIComponent(roomId)}${itemId ? `#classroom-step-${encodeURIComponent(itemId)}` : ''}`;

    return {
      ts,
      snapshot: {
        id: `reentry:${slot}`,
        kind: 'classroom',
        ...(activityTitle ? { activityTitle } : {}),
        ...(itemId ? { itemId } : {}),
        ...(itemLabel ? { itemLabel } : {}),
        ...(explicitHints !== undefined ? { openedHints: explicitHints } : {}),
        ...(explicitExcerpt ? { draftExcerpt: explicitExcerpt } : {}),
        href,
        lastActionAt: ts,
        storageKeys: [storageKey],
      },
    };
  }

  if (!explicitHref && !explicitExcerpt && !explicitLabel && explicitIndex === undefined) {
    return null;
  }

  return {
    ts,
    snapshot: {
      id: `reentry:${slot}`,
      kind: 'activity',
      ...(explicitTitle ? { activityTitle: explicitTitle } : {}),
      ...(itemId ? { itemId } : {}),
      ...(explicitLabel ? { itemLabel: explicitLabel } : {}),
      ...(explicitIndex !== undefined ? { itemIndex: explicitIndex } : {}),
      ...(explicitHints !== undefined ? { openedHints: explicitHints } : {}),
      ...(explicitExcerpt ? { draftExcerpt: explicitExcerpt } : {}),
      ...(explicitHref ? { href: explicitHref } : {}),
      lastActionAt: ts,
      storageKeys: [storageKey],
    },
  };
}

/** 同步读取本机 localStorage 中所有已满 20 分钟的未完成续场信号，返回最近一次停驻记录（0 LLM / <150ms）。 */
export function readLocalResumeSnapshot(options?: {
  nowMs?: number | undefined;
  activeRoom?: ResumeActiveRoom | null | undefined;
  candidateTitles?: ReadonlyMap<string, string> | undefined;
}): ResumeBreadcrumbSnapshot | null {
  const nowMs = options?.nowMs ?? Date.now();
  try {
    if (typeof localStorage === 'undefined') return null;
    let best: { ts: number; snapshot: ResumeBreadcrumbSnapshot } | null = null;
    for (let i = 0; i < localStorage.length; i += 1) {
      const storageKey = localStorage.key(i);
      if (!storageKey || !storageKey.startsWith(REENTRY_STORAGE_PREFIX)) continue;
      const candidate = readCandidateFromReentryKey(
        storageKey,
        nowMs,
        options?.activeRoom,
        options?.candidateTitles,
      );
      if (candidate && (!best || candidate.ts > best.ts)) {
        best = candidate;
      }
    }
    return best?.snapshot ?? null;
  } catch {
    return null;
  }
}

/** 清除单条本机草稿与续场标记（供「盖住重做」使用）。 */
export function clearResumeSnapshot(snapshot: ResumeBreadcrumbSnapshot): void {
  try {
    if (snapshot.packDraftKey) {
      forgetPackDrafts(snapshot.packDraftKey);
    }
    if (snapshot.storageKeys) {
      for (const key of snapshot.storageKeys) {
        localStorage.removeItem(key);
      }
    }
    if (snapshot.id.startsWith('reentry:')) {
      remember(snapshot.id, null);
    }
  } catch {
    // 浏览器禁用存储时静默降级，仍立即收起当前条幅。
  }
}

function consumeReentryMarkerOnly(snapshot: ResumeBreadcrumbSnapshot): void {
  try {
    if (snapshot.id.startsWith('reentry:')) {
      remember(snapshot.id, null);
    }
  } catch {
    // 忽略存储异常。
  }
}

function readSessionDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SESSION_DISMISSED_KEY);
    const parsed = parseJson<unknown>(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((item): item is string => typeof item === 'string'));
    }
  } catch {
    // sessionStorage 不可用时仅用内存态。
  }
  return new Set();
}

function persistSessionDismissed(id: string): void {
  try {
    const current = readSessionDismissed();
    current.add(id);
    sessionStorage.setItem(SESSION_DISMISSED_KEY, JSON.stringify([...current]));
  } catch {
    // 忽略存储异常。
  }
}

function focusInPageDraft(itemId: string): boolean {
  const details = document.getElementById(`draft-${itemId}`);
  if (details instanceof HTMLDetailsElement) {
    details.open = true;
    details.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const field = details.querySelector<HTMLElement>('textarea, input');
    field?.focus();
    return true;
  }
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(itemId)
      : itemId.replace(/["\\]/g, '\\$&');
  const byAttr = document.querySelector<HTMLElement>(`[data-wbv2-question-id="${escaped}"]`);
  if (byAttr) {
    byAttr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    (byAttr.querySelector<HTMLElement>('textarea, input') ?? byAttr).focus();
    return true;
  }
  return false;
}

export function ResumeBreadcrumb({
  reentry,
  activeRoom,
  candidateTitles,
  nowMs,
  onNavigate,
  onFocusDraft,
  onCoverRedo,
}: ResumeBreadcrumbProps) {
  const [scanTick, setScanTick] = useState(0);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => readSessionDismissed());

  useEffect(() => {
    const rescan = () => {
      if (document.visibilityState === 'visible') {
        setScanTick((tick) => tick + 1);
      }
    };
    window.addEventListener('pageshow', rescan);
    window.addEventListener('storage', rescan);
    document.addEventListener('visibilitychange', rescan);
    return () => {
      window.removeEventListener('pageshow', rescan);
      window.removeEventListener('storage', rescan);
      document.removeEventListener('visibilitychange', rescan);
    };
  }, []);

  const snapshot = useMemo(() => {
    void scanTick;
    const referenceNow = nowMs ?? Date.now();
    if (reentry) {
      return isResumeDue(reentry.lastActionAt, referenceNow) ? reentry : null;
    }
    return readLocalResumeSnapshot({
      nowMs: referenceNow,
      activeRoom,
      candidateTitles,
    });
  }, [reentry, activeRoom, candidateTitles, nowMs, scanTick]);

  if (!snapshot || dismissedIds.has(snapshot.id)) {
    return null;
  }

  const summaryLine = formatResumeLine(snapshot);

  function dismissForSession(id: string) {
    persistSessionDismissed(id);
    setDismissedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function handleContinue() {
    if (!snapshot) return;
    consumeReentryMarkerOnly(snapshot);
    dismissForSession(snapshot.id);
    if (onFocusDraft) {
      onFocusDraft(snapshot);
      return;
    }
    if (snapshot.itemId && focusInPageDraft(snapshot.itemId)) {
      return;
    }
    if (snapshot.href) {
      if (onNavigate) onNavigate(snapshot.href);
      else window.location.assign(snapshot.href);
    }
  }

  function handleCoverRedo() {
    if (!snapshot) return;
    clearResumeSnapshot(snapshot);
    dismissForSession(snapshot.id);
    onCoverRedo?.(snapshot);
  }

  return (
    <aside className="tv2-breadcrumb" aria-label="10 秒无痛续场卡">
      <div className="tv2-breadcrumb-main">
        <Dot tone="amber" />
        <p className="tv2-breadcrumb-text" {...{ elementtiming: 'resume-breadcrumb' }}>
          {summaryLine}
        </p>
      </div>
      <div className="tv2-breadcrumb-actions" role="group" aria-label="续场操作">
        <button
          type="button"
          className="tv2-btn tv2-btn--tonal tv2-btn--sm tv2-breadcrumb-continue"
          onClick={handleContinue}
        >
          继续这步
        </button>
        <button
          type="button"
          className="tv2-btn tv2-btn--ghost tv2-btn--sm"
          onClick={handleCoverRedo}
        >
          盖住重做
        </button>
        <button
          type="button"
          className="tv2-breadcrumb-dismiss"
          aria-label="收起续场条"
          title="本会话收起"
          onClick={() => dismissForSession(snapshot.id)}
        >
          <Icon name="close" />
        </button>
      </div>
    </aside>
  );
}
