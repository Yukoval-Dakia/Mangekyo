import { useEffect, useMemo, useState } from 'react';
import { remember, remembered } from '../api';
import { builtinPackPath, findBuiltinPack } from '../builtin-packs';
import { Icon } from '../icons';
import { parseTimestampMs } from '../shared/format-time';
import { isSafeInternalHref, navigateHref, safeInternalHref } from '../shared/safe-navigation';
import { isRecord, readTrimmed, safeParseJson } from '../shared/safe-values';
import { answerKey, forgetPackDrafts, recoverDraft } from '../today-draft';
import { Dot, cleanHumanText } from './shared';

export { isSafeInternalHref };

/** 离开未完成练习超过 20 分钟后触发「10 秒无痛续场卡」（0 LLM，<150ms）。 */
export const RESUME_THRESHOLD_MS = 20 * 60_000;

const SESSION_DISMISSED_KEY = 'mangekyo:resume-breadcrumb:dismissed';
const REENTRY_STORAGE_PREFIX = 'mangekyo:reentry:';
const PAPER_DRAFT_KEY_PATTERN = /^mangekyo:workbook:paper:([^:]+):draft$/;
const MAX_EXCERPT_CHARS = 24;
const UNEXPOSED_HELP_VALUES = new Set(['none', 'independent', 'unexposed', 'unknown', '0', 'false', '']);

export type ResumeBreadcrumbSnapshot = {
  readonly id: string;
  readonly kind?: 'paper' | 'classroom' | 'pack' | 'activity' | string | undefined;
  readonly activityTitle?: string | undefined;
  readonly itemId?: string | undefined;
  readonly itemLabel?: string | undefined;
  readonly itemIndex?: number | undefined;
  readonly openedHints?: number | undefined;
  readonly draftExcerpt?: string | undefined;
  readonly href?: string | undefined;
  readonly lastActionAt: number | string;
  readonly storageKeys?: readonly string[] | undefined;
  readonly packDraftKey?: string | undefined;
};

export type ResumeActiveRoom = {
  readonly id: string;
  readonly topic: string;
  readonly activeStepTitle?: string | undefined;
};

export type ResumeBreadcrumbProps = {
  readonly reentry?: ResumeBreadcrumbSnapshot | null | undefined;
  readonly activeRoom?: ResumeActiveRoom | null | undefined;
  readonly candidateTitles?: ReadonlyMap<string, string> | undefined;
  readonly nowMs?: number | undefined;
  readonly onNavigate?: ((href: string) => void) | undefined;
  readonly onFocusDraft?: ((snapshot: ResumeBreadcrumbSnapshot) => void) | undefined;
  readonly onCoverRedo?: ((snapshot: ResumeBreadcrumbSnapshot) => void) | undefined;
};

type StoredPaperDraft = {
  requestId?: unknown;
  answers?: Record<string, unknown>;
  scratch?: Record<string, unknown>;
  currentItem?: unknown;
  frozenSubmission?: unknown;
  openedHints?: unknown;
  helpExposure?: unknown;
  lastActionAt?: unknown;
  updatedAt?: unknown;
  savedAt?: unknown;
};

type CandidateMatch = { ts: number; snapshot: ResumeBreadcrumbSnapshot };

export function isResumeDue(lastActionAt: number | string | undefined, nowMs = Date.now()): boolean {
  const ts = parseTimestampMs(lastActionAt);
  return ts !== null && nowMs - ts >= RESUME_THRESHOLD_MS;
}

function floorInt(value: unknown, min: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.floor(value) : undefined;
}

function isActiveHintEntry(entry: unknown): boolean {
  if (entry === null || entry === undefined || entry === false || entry === 0) return false;
  if (typeof entry === 'number') return Number.isFinite(entry) && entry > 0;
  if (typeof entry === 'string') return !UNEXPOSED_HELP_VALUES.has(entry.trim().toLowerCase());
  if (Array.isArray(entry)) return entry.some(isActiveHintEntry);
  if (isRecord(entry)) {
    if ('count' in entry) {
      const count = floorInt(entry.count, 0);
      if (count !== undefined) return count > 0;
    }
    if ('level' in entry) return isActiveHintEntry(entry.level);
    if ('helpLevel' in entry) return isActiveHintEntry(entry.helpLevel);
    if ('helpExposure' in entry) return isActiveHintEntry(entry.helpExposure);
    if ('opened' in entry) return entry.opened === true;
    return Object.keys(entry).length > 0;
  }
  return Boolean(entry);
}

function countOpenedHints(raw: unknown, itemId?: string): number | undefined {
  const direct = floorInt(raw, 0);
  if (direct !== undefined) return direct;
  if (typeof raw === 'string') return isActiveHintEntry(raw) ? 1 : 0;
  if (Array.isArray(raw)) return raw.filter(isActiveHintEntry).length;
  if (isRecord(raw)) {
    if (itemId && itemId in raw) {
      const entry = raw[itemId];
      const byItem = floorInt(entry, 0);
      if (byItem !== undefined) return byItem;
      if (isRecord(entry) && 'count' in entry) {
        const count = floorInt(entry.count, 0);
        if (count !== undefined) return count;
      }
      return isActiveHintEntry(entry) ? 1 : 0;
    }
    const keys = Object.keys(raw);
    if (keys.length > 0) return keys.filter((key) => isActiveHintEntry(raw[key])).length;
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
  if (isRecord(draft?.answers)) {
    const position = Object.keys(draft.answers).indexOf(itemId);
    if (position >= 0) return position + 1;
  }
  return undefined;
}

function safeExcerpt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.trim().replace(/\s+/g, ' ');
  return collapsed.length > 0 ? collapsed : undefined;
}

function clipExcerpt(text: string): string {
  const chars = [...text];
  return chars.length > MAX_EXCERPT_CHARS ? `${chars.slice(0, MAX_EXCERPT_CHARS).join('')}…` : text;
}

export function formatResumeLine(snapshot: ResumeBreadcrumbSnapshot): string {
  const title = cleanHumanText(snapshot.activityTitle);
  const label = cleanHumanText(snapshot.itemLabel);
  const index = floorInt(snapshot.itemIndex, 1);

  let anchor: string;
  if (label) {
    if (label.startsWith('上次停在')) anchor = label;
    else if (/^第\s*\d+\s*[题步节]/.test(label)) {
      anchor = title && !label.includes(title) ? `上次停在「${title}」${label}` : `上次停在${label}`;
    } else if (title && title !== label) anchor = `上次停在「${title}」· ${label}`;
    else anchor = `上次停在「${label}」`;
  } else if (index !== undefined) {
    anchor = title ? `上次停在「${title}」第 ${index} 题` : `上次停在第 ${index} 题`;
  } else if (title) {
    anchor = `上次停在「${title}」`;
  } else {
    anchor = '上次停在未完成的练习';
  }

  const parts = [anchor];
  const hints = floorInt(snapshot.openedHints, 0);
  if (hints !== undefined && hints > 0) parts.push(`已展提示 ${hints}`);
  const excerpt = safeExcerpt(snapshot.draftExcerpt);
  if (excerpt) parts.push(`草稿停在“${clipExcerpt(excerpt)}”`);
  return parts.join(' · ');
}

function findFirstExcerptKey(record: unknown): string | undefined {
  if (!isRecord(record)) return undefined;
  return Object.keys(record).find((key) => Boolean(safeExcerpt(record[key])));
}

function extractPaperEvidence(
  paperId: string,
  draft: StoredPaperDraft | null,
  explicitItemId: string | undefined,
  explicitExcerpt: string | undefined,
  inferFallbackItem: boolean,
) {
  const effectiveItemId =
    explicitItemId ??
    readTrimmed(draft?.currentItem) ??
    (inferFallbackItem ? findFirstExcerptKey(draft?.scratch) ?? findFirstExcerptKey(draft?.answers) : undefined);
  const wbv2ScratchKey = effectiveItemId ? `wbv2-scratch:${paperId}:${effectiveItemId}` : null;
  const wbv2Scratch = wbv2ScratchKey ? localStorage.getItem(wbv2ScratchKey) : null;
  const draftScratch = effectiveItemId && isRecord(draft?.scratch) ? draft.scratch[effectiveItemId] : undefined;
  const draftAnswer = effectiveItemId && isRecord(draft?.answers) ? draft.answers[effectiveItemId] : undefined;
  const excerpt = explicitExcerpt ?? safeExcerpt(draftScratch) ?? safeExcerpt(wbv2Scratch) ?? safeExcerpt(draftAnswer);
  return { effectiveItemId, wbv2ScratchKey, wbv2Scratch, excerpt };
}

function readCandidateFromReentryKey(
  storageKey: string,
  nowMs: number,
  activeRoom: ResumeActiveRoom | null | undefined,
  candidateTitles: ReadonlyMap<string, string> | undefined,
): CandidateMatch | null {
  const slot = storageKey.slice(REENTRY_STORAGE_PREFIX.length);
  if (!slot) return null;
  const record = safeParseJson<unknown>(localStorage.getItem(storageKey));
  if (!isRecord(record)) return null;
  const ts = parseTimestampMs(record.lastActionAt);
  if (ts === null || nowMs - ts < RESUME_THRESHOLD_MS) return null;

  const itemId = readTrimmed(record.itemId);
  const explicitExcerpt = safeExcerpt(record.draftExcerpt) ?? safeExcerpt(record.scratch);
  const explicitLabel = cleanHumanText(record.itemLabel) ?? cleanHumanText(record.label);
  const explicitIndex = floorInt(record.itemIndex, 1);
  const explicitTitle = cleanHumanText(record.activityTitle);
  const explicitHref = safeInternalHref(record.href);
  const explicitHints = countOpenedHints(record.openedHints ?? record.helpExposure, itemId);

  if (slot.startsWith('paper:')) {
    const paperId = slot.slice('paper:'.length);
    if (!paperId) return null;
    const draftStorageKey = `mangekyo:workbook:paper:${paperId}:draft`;
    const rawDraft = safeParseJson<unknown>(localStorage.getItem(draftStorageKey));
    const draft = isRecord(rawDraft) ? (rawDraft as StoredPaperDraft) : null;
    if (draft?.frozenSubmission === true) return null;

    const { effectiveItemId, wbv2ScratchKey, wbv2Scratch, excerpt } = extractPaperEvidence(
      paperId,
      draft,
      itemId,
      explicitExcerpt,
      false,
    );
    if (!draft && !excerpt && !explicitLabel && explicitIndex === undefined) return null;

    const storageKeys = [storageKey];
    if (draft) storageKeys.push(draftStorageKey);
    if (wbv2ScratchKey && wbv2Scratch !== null) storageKeys.push(wbv2ScratchKey);

    const itemIndex = explicitIndex ?? inferItemIndex(effectiveItemId, draft);
    const openedHints = explicitHints ?? countOpenedHints(draft?.openedHints ?? draft?.helpExposure, effectiveItemId);
    const activityTitle = explicitTitle ?? cleanHumanText(candidateTitles?.get(paperId));

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
        href: explicitHref ?? `/papers/${encodeURIComponent(paperId)}`,
        lastActionAt: ts,
        storageKeys,
      },
    };
  }

  if (slot.startsWith('pack:')) {
    const packId = slot.slice('pack:'.length);
    const binding = safeParseJson<unknown>(typeof record.binding === 'string' ? record.binding : null);
    if (!Array.isArray(binding) || typeof binding[0] !== 'string' || !Number.isSafeInteger(binding[1])) {
      return null;
    }
    const boundId = binding[0];
    const boundRev = binding[1] as number;
    const recovered = recoverDraft({ id: boundId, rev: boundRev }, typeof binding[2] === 'string' ? binding[2] : null);
    const scratchKeyName = `today-pack-scratch:${encodeURIComponent(boundId)}@${boundRev}`;
    const packScratch = remembered(scratchKeyName);
    const excerpt = explicitExcerpt ?? safeExcerpt(packScratch);
    if ((!recovered || recovered.pending) && !excerpt) return null;

    const storageKeys = [storageKey, ...(packScratch !== null ? [`mangekyo:${scratchKeyName}`] : [])];
    const activityTitle = explicitTitle ?? cleanHumanText(candidateTitles?.get(packId));
    const builtinMatch = findBuiltinPack(boundId, 'practice') ?? findBuiltinPack(boundId);
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
        href: explicitHref ?? (builtinMatch ? builtinPackPath(builtinMatch) : '/today'),
        lastActionAt: ts,
        storageKeys,
        packDraftKey: answerKey({ id: boundId, rev: boundRev }),
      },
    };
  }

  if (slot.startsWith('classroom:')) {
    if (activeRoom === null) return null;
    const roomId = slot.slice('classroom:'.length);
    if (!roomId) return null;
    const matchesActiveRoom = activeRoom?.id === roomId;
    if (activeRoom !== undefined && !matchesActiveRoom) return null;
    if (!matchesActiveRoom && !explicitExcerpt && !explicitLabel) return null;
    const activityTitle = explicitTitle ?? (matchesActiveRoom ? cleanHumanText(activeRoom.topic) : undefined);
    const itemLabel = explicitLabel ?? (matchesActiveRoom ? cleanHumanText(activeRoom.activeStepTitle) : undefined);
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
        href:
          explicitHref ??
          `/classroom/${encodeURIComponent(roomId)}${itemId ? `#classroom-step-${encodeURIComponent(itemId)}` : ''}`,
        lastActionAt: ts,
        storageKeys: [storageKey],
      },
    };
  }

  if (!explicitHref && !explicitExcerpt && !explicitLabel && explicitIndex === undefined) return null;
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

function readCandidateFromPaperDraftKey(
  draftStorageKey: string,
  nowMs: number,
  candidateTitles: ReadonlyMap<string, string> | undefined,
): CandidateMatch | null {
  const paperId = PAPER_DRAFT_KEY_PATTERN.exec(draftStorageKey)?.[1]?.trim();
  if (!paperId) return null;
  const rawDraft = safeParseJson<unknown>(localStorage.getItem(draftStorageKey));
  if (!isRecord(rawDraft) || rawDraft.frozenSubmission === true) return null;
  const draft = rawDraft as StoredPaperDraft;

  const { effectiveItemId, wbv2ScratchKey, wbv2Scratch, excerpt } = extractPaperEvidence(
    paperId,
    draft,
    undefined,
    undefined,
    true,
  );
  if (!effectiveItemId && !excerpt) return null;

  const ts = parseTimestampMs(draft.lastActionAt ?? draft.updatedAt ?? draft.savedAt);
  if (ts === null) {
    // 既有草稿无时间戳且无独立 reentry 键时，诚实补写当前观测起点，等待满 20 分钟后自然触发，绝不伪造已离开时长。
    remember(
      `reentry:paper:${paperId}`,
      JSON.stringify({
        itemId: effectiveItemId,
        ...(excerpt ? { draftExcerpt: excerpt } : {}),
        lastActionAt: nowMs,
      }),
    );
    return null;
  }
  if (nowMs - ts < RESUME_THRESHOLD_MS) return null;

  const storageKeys = [draftStorageKey, ...(wbv2ScratchKey && wbv2Scratch !== null ? [wbv2ScratchKey] : [])];
  const itemIndex = inferItemIndex(effectiveItemId, draft);
  const openedHints = countOpenedHints(draft.openedHints ?? draft.helpExposure, effectiveItemId);
  const activityTitle = cleanHumanText(candidateTitles?.get(paperId));

  return {
    ts,
    snapshot: {
      id: `reentry:paper:${paperId}`,
      kind: 'paper',
      ...(activityTitle ? { activityTitle } : {}),
      ...(effectiveItemId ? { itemId: effectiveItemId } : {}),
      ...(itemIndex !== undefined ? { itemIndex } : {}),
      ...(openedHints !== undefined ? { openedHints } : {}),
      ...(excerpt ? { draftExcerpt: excerpt } : {}),
      href: `/papers/${encodeURIComponent(paperId)}`,
      lastActionAt: ts,
      storageKeys,
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
    let best: CandidateMatch | null = null;
    const seenPaperIds = new Set<string>();
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const storageKey = localStorage.key(i);
      if (storageKey) keys.push(storageKey);
    }
    const pickBetter = (current: CandidateMatch | null, next: CandidateMatch | null): CandidateMatch | null =>
      next && (!current || next.ts > current.ts) ? next : current;
    for (const storageKey of keys) {
      if (!storageKey.startsWith(REENTRY_STORAGE_PREFIX)) continue;
      const slot = storageKey.slice(REENTRY_STORAGE_PREFIX.length);
      if (slot.startsWith('paper:')) {
        const paperId = slot.slice('paper:'.length);
        if (paperId) seenPaperIds.add(paperId);
      }
      best = pickBetter(
        best,
        readCandidateFromReentryKey(storageKey, nowMs, options?.activeRoom, options?.candidateTitles),
      );
    }
    for (const storageKey of keys) {
      const paperId = PAPER_DRAFT_KEY_PATTERN.exec(storageKey)?.[1]?.trim();
      if (!paperId || seenPaperIds.has(paperId)) continue;
      best = pickBetter(best, readCandidateFromPaperDraftKey(storageKey, nowMs, options?.candidateTitles));
    }
    return best?.snapshot ?? null;
  } catch {
    return null;
  }
}

/** 清除单条本机草稿与续场标记（供「盖住重做」使用）。 */
export function clearResumeSnapshot(snapshot: ResumeBreadcrumbSnapshot): void {
  try {
    if (snapshot.packDraftKey) forgetPackDrafts(snapshot.packDraftKey);
    for (const key of snapshot.storageKeys ?? []) localStorage.removeItem(key);
    if (snapshot.id.startsWith('reentry:')) remember(snapshot.id, null);
  } catch {
    // 浏览器禁用存储时静默降级，仍立即收起当前条幅。
  }
}

function readSessionDismissed(): Set<string> {
  try {
    const parsed = safeParseJson<unknown>(sessionStorage.getItem(SESSION_DISMISSED_KEY));
    if (Array.isArray(parsed)) return new Set(parsed.filter((item): item is string => typeof item === 'string'));
  } catch {}
  return new Set();
}

function persistSessionDismissed(id: string): void {
  try {
    const current = readSessionDismissed();
    current.add(id);
    sessionStorage.setItem(SESSION_DISMISSED_KEY, JSON.stringify([...current]));
  } catch {}
}

function focusInPageDraft(itemId: string): boolean {
  const details = document.getElementById(`draft-${itemId}`);
  if (details instanceof HTMLDetailsElement) {
    details.open = true;
    details.scrollIntoView({ behavior: 'smooth', block: 'center' });
    details.querySelector<HTMLElement>('textarea, input')?.focus();
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
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(readSessionDismissed);

  useEffect(() => {
    const rescan = () => {
      if (document.visibilityState === 'visible') setScanTick((tick) => tick + 1);
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
      if (!isResumeDue(reentry.lastActionAt, referenceNow)) return null;
      return { ...reentry, href: safeInternalHref(reentry.href) };
    }
    return readLocalResumeSnapshot({ nowMs: referenceNow, activeRoom, candidateTitles });
  }, [reentry, activeRoom, candidateTitles, nowMs, scanTick]);

  if (!snapshot || dismissedIds.has(snapshot.id)) return null;

  function dismissForSession(id: string) {
    persistSessionDismissed(id);
    setDismissedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }

  function handleContinue() {
    if (!snapshot) return;
    try {
      if (snapshot.id.startsWith('reentry:')) remember(snapshot.id, null);
    } catch {}
    dismissForSession(snapshot.id);
    if (onFocusDraft) {
      onFocusDraft(snapshot);
      return;
    }
    if (snapshot.itemId && focusInPageDraft(snapshot.itemId)) return;
    const targetHref = safeInternalHref(snapshot.href);
    if (targetHref) navigateHref(targetHref, onNavigate);
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
          {formatResumeLine(snapshot)}
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
        <button type="button" className="tv2-btn tv2-btn--ghost tv2-btn--sm" onClick={handleCoverRedo}>
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
