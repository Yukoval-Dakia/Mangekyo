import { useState, type MouseEvent, type ReactNode } from 'react';
import { handleInternalLinkClick } from '../shared/safe-navigation';

export type ChipTone = 'default' | 'forest' | 'amber' | 'neutral';

export function Chip({ tone = 'default', children }: { tone?: ChipTone; children: ReactNode }) {
  const modifier = tone === 'default' ? '' : ` tv2-chip--${tone}`;
  return <span className={'tv2-chip' + modifier}>{children}</span>;
}

export function BreathDot() {
  return <span className="tv2-dot tv2-dot--breath" aria-hidden="true" />;
}

export function Dot({ tone = 'forest' }: { tone?: 'forest' | 'amber' }) {
  return <span className={'tv2-dot' + (tone === 'amber' ? ' tv2-dot--amber' : '')} aria-hidden="true" />;
}

export function InlineToggle({
  open,
  onToggle,
  closed,
  opened,
}: {
  open: boolean;
  onToggle: () => void;
  closed: string;
  opened: string;
}) {
  return (
    <button type="button" className="tv2-details-toggle" aria-expanded={open} onClick={onToggle}>
      <span>{open ? opened : closed}</span>
      <svg
        className={'tv2-chevron' + (open ? ' tv2-chevron--open' : '')}
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}

export function useToggle(initial = false): [boolean, () => void] {
  const [open, setOpen] = useState(initial);
  return [open, () => setOpen((current) => !current)];
}

export function handleSpaNavigation(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onNavigate?: (target: string) => void,
) {
  handleInternalLinkClick(event, href, onNavigate, false);
}

const ULID_PATTERN = /\b[0-9A-HJKMNP-TV-Z]{26}\b/;
const TECHNICAL_TOKEN_PATTERN =
  /^(?:[a-z0-9_-]+\/[a-z0-9_.-]+(?:@\d+)?|[a-z0-9_-]+:[a-z0-9_.-]+(?:@\d+)?|[0-9A-HJKMNP-TV-Z]{26}(?:@\d+)?|[a-zA-Z0-9_-]+@\d+|(?:activityId|methodVersion|accessEpoch|rev|blockId|questionId|expectedRev|requestId)[:=]?.*)$/;

export function isTechnicalIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (ULID_PATTERN.test(trimmed)) return true;
  if (TECHNICAL_TOKEN_PATTERN.test(trimmed)) return true;
  return /\b(?:activityId|methodVersion|accessEpoch|expectedRev|requestId)\b/i.test(trimmed);
}

export function cleanHumanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || isTechnicalIdentifier(trimmed)) return undefined;
  return trimmed;
}

export function filterHumanEvidence(evidence: readonly string[]): {
  readable: string[];
  hiddenRecordCount: number;
} {
  const readable: string[] = [];
  let hiddenRecordCount = 0;
  for (const item of evidence) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (isTechnicalIdentifier(trimmed)) {
      hiddenRecordCount += 1;
    } else if (!readable.includes(trimmed)) {
      readable.push(trimmed);
    }
  }
  return { readable, hiddenRecordCount };
}

export function humanizeConstraint(
  constraint: string,
  titleByActivityId: ReadonlyMap<string, string>,
): string | null {
  const trimmed = constraint.trim();
  if (!trimmed) return null;
  const mapped = titleByActivityId.get(trimmed);
  if (mapped) return `「${mapped}」`;
  if (isTechnicalIdentifier(trimmed)) return '一项已锁定的活动';
  return trimmed;
}

export function formatFeedTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed;
  }
  const now = new Date();
  const diffMs = now.getTime() - parsed.getTime();
  if (diffMs >= 0 && diffMs < 60_000) return '刚刚';
  const sameDay =
    now.getFullYear() === parsed.getFullYear() &&
    now.getMonth() === parsed.getMonth() &&
    now.getDate() === parsed.getDate();
  const hhmm = parsed.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay) return `今天 ${hhmm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    yesterday.getFullYear() === parsed.getFullYear() &&
    yesterday.getMonth() === parsed.getMonth() &&
    yesterday.getDate() === parsed.getDate();
  if (isYesterday) return `昨天 ${hhmm}`;
  const sameYear = now.getFullYear() === parsed.getFullYear();
  return sameYear
    ? `${parsed.getMonth() + 1}月${parsed.getDate()}日 ${hhmm}`
    : `${parsed.getFullYear()}年${parsed.getMonth() + 1}月${parsed.getDate()}日`;
}

export function kindGlyph(mediaType: string | undefined, kind?: string): string {
  if (kind === 'link') return '链';
  if (kind === 'crop') return '题';
  if (!mediaType) return kind === 'paper' ? '卷' : '文';
  if (mediaType === 'application/pdf') return 'PDF';
  if (mediaType === 'text/markdown') return 'Md';
  if (mediaType.startsWith('image/')) return '图';
  if (mediaType.startsWith('text/')) return '文';
  return '件';
}

export function formatFileSize(bytes: number | undefined): string | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MediaPlaceholder({
  mediaType,
  isLink,
}: {
  mediaType?: string;
  isLink?: boolean;
}) {
  if (isLink) {
    return (
      <span className="tv2-thumb-glyph" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        <span>链接</span>
      </span>
    );
  }
  if (mediaType === 'application/pdf') {
    return (
      <span className="tv2-thumb-glyph" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 15h6" />
        </svg>
        <span>PDF</span>
      </span>
    );
  }
  if (mediaType?.startsWith('image/')) {
    return (
      <span className="tv2-thumb-glyph" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="m21 16-5-5-8 8" />
        </svg>
        <span>图片</span>
      </span>
    );
  }
  const label = mediaType === 'text/markdown' ? 'MD' : '文本';
  return (
    <span className="tv2-thumb-glyph" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 3h9l4 4v14H6z" />
        <path d="M14 3v5h5" />
        <path d="M9 12h6M9 16h4" />
      </svg>
      <span>{label}</span>
    </span>
  );
}
