import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { api, ApiError, deletedSubmission, remember, remembered, requestId, submissionId } from '../api';
import {
  bindDeletionWatermark,
  latestKey,
  synchronizeDeletion,
  verifyGenerationReceipt,
} from '../deletion-watermark';
import { Icon } from '../icons';
import type { IntakeMetadata } from '../intake';
import { enqueue } from '../offline-queue';
import { materialPath, type Material, type Workspace } from '../workspace';
import {
  BreathDot,
  Chip,
  formatFeedTime,
  formatFileSize,
  handleSpaNavigation,
  isTechnicalIdentifier,
  MediaPlaceholder,
} from './shared';
import './today-v2.css';

export type IntakeStatus = 'organizing' | 'indexed' | 'needs-confirm' | 'saved';
export type IntakePurpose = 'save-only' | 'learning';

export type IntakeFeedEntry = {
  id: string;
  title: string;
  mediaType?: string;
  thumbnailUrl?: string;
  pageCount?: number;
  status: IntakeStatus;
  savedAt?: string;
  preview?: string;
  href?: string;
  sizeBytes?: number;
  purpose?: IntakePurpose;
  revision?: number;
  canRetryVision?: boolean;
  questionCount?: number;
};

export type IntakeSurfaceProps = {
  onNavigate?: (href: string) => void;
  onMaterialSaved?: () => void;
  feed?: readonly IntakeFeedEntry[];
  defaultPurpose?: IntakePurpose;
  onPurposeChange?: (purpose: IntakePurpose) => void;
  maxHistory?: number;
};

const INTAKE_LIMIT_BYTES = 25 * 1024 * 1024;
const INTAKE_MAX_PAGES = 6;
const INTAKE_MULTI_PAGE_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_ORGANIZING_POLL_ATTEMPTS = 60;
const ACCEPTED_FILE_TYPES =
  '.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.avif,.tif,.tiff,.txt,.md,.markdown';
const VISION_OCR_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/tiff',
  'image/webp',
]);
const LINK_PATTERN = /^https?:\/\/\S+$/i;
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|webp|heic|heif|avif|tiff?)$/i;
const PURPOSE_STORAGE_KEY = 'today-v2:intake-default-purpose';

function isPhotoFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXTENSION_PATTERN.test(file.name);
}

type PendingPage = {
  readonly file: File;
  readonly previewUrl: string;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('无法读取图片预览。'));
    reader.readAsDataURL(file);
  });
}

function statusFromMetadata(metadata: IntakeMetadata): IntakeStatus {
  const extractionStatus = metadata.extraction?.status;
  if (extractionStatus === 'pending') return 'organizing';
  if (extractionStatus === 'partial' || extractionStatus === 'failed') return 'needs-confirm';
  if (metadata.backgroundResearch === 'private') return 'saved';
  if (extractionStatus === 'ok' || extractionStatus === 'corrected') return 'indexed';
  return 'saved';
}

function entryFromMetadata(
  metadata: IntakeMetadata,
  fallback: { savedAt?: string | undefined; localPreviewUrl?: string | undefined } = {},
): IntakeFeedEntry {
  const mediaType = metadata.original?.mediaType;
  const isImage = typeof mediaType === 'string' && mediaType.startsWith('image/');
  const previewText =
    typeof metadata.text === 'string' && metadata.text.trim().length > 0 && !isTechnicalIdentifier(metadata.text)
      ? metadata.text.trim()
      : undefined;
  const sizeBytes = metadata.original?.size;
  const thumbnailUrl = isImage
    ? fallback.localPreviewUrl ?? `/api/materials/${encodeURIComponent(metadata.id)}/original`
    : undefined;
  const purpose: IntakePurpose = metadata.backgroundResearch === 'private' ? 'save-only' : 'learning';
  const questionCount = metadata.questionCards?.length ?? metadata.extraction?.drafts?.questions.length ?? 0;
  const pageCount =
    typeof metadata.pageCount === 'number' && metadata.pageCount > 1
      ? metadata.pageCount
      : metadata.originals && metadata.originals.length > 1
        ? metadata.originals.length
        : undefined;

  return {
    id: metadata.id,
    title: metadata.title || metadata.original?.name || '未命名材料',
    status: statusFromMetadata(metadata),
    href: materialPath(metadata.id),
    purpose,
    revision: metadata.revision,
    canRetryVision: metadata.canRetryVision === true,
    questionCount,
    ...(pageCount ? { pageCount } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(fallback.savedAt ? { savedAt: fallback.savedAt } : {}),
    ...(previewText ? { preview: previewText } : {}),
    ...(typeof sizeBytes === 'number' && sizeBytes > 0 ? { sizeBytes } : {}),
  };
}

function feedFromWorkspace(materials: readonly Material[]): IntakeFeedEntry[] {
  return materials.map((material) => {
    const trimmedTitle = material.title?.trim() || '未命名材料';
    const trimmedText = material.text?.trim() || '';
    const isLink = LINK_PATTERN.test(trimmedTitle) || LINK_PATTERN.test(trimmedText);
    const safePreview =
      trimmedText && trimmedText !== trimmedTitle && !isTechnicalIdentifier(trimmedText)
        ? trimmedText
        : undefined;
    return {
      id: material.id,
      title: trimmedTitle,
      mediaType: isLink ? 'text/uri-list' : 'text/plain',
      status: 'saved',
      purpose: 'save-only',
      href: materialPath(material.id),
      ...(safePreview ? { preview: safePreview } : {}),
    };
  });
}

function mediaKindLabel(mediaType: string | undefined, isLink: boolean): string {
  if (isLink) return '公开链接';
  if (!mediaType) return '材料';
  if (mediaType === 'application/pdf') return 'PDF';
  if (mediaType.startsWith('image/')) return '图片';
  if (mediaType === 'text/markdown') return 'Markdown';
  if (mediaType.startsWith('text/')) return '文字';
  return '文件';
}

function renderStatusChip(status: IntakeStatus) {
  switch (status) {
    case 'organizing':
      return (
        <Chip>
          <BreathDot />
          整理中
        </Chip>
      );
    case 'indexed':
      return <Chip tone="forest">已入库</Chip>;
    case 'needs-confirm':
      return <Chip tone="amber">需确认</Chip>;
    case 'saved':
      return <Chip tone="neutral">仅保存</Chip>;
  }
}

function FeedRow({
  entry,
  onNavigate,
  onRetryVision,
  retrying,
  retryError,
}: {
  entry: IntakeFeedEntry;
  onNavigate?: ((href: string) => void) | undefined;
  onRetryVision: (entry: IntakeFeedEntry) => void;
  retrying: boolean;
  retryError?: string | undefined;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const isLink =
    entry.mediaType === 'text/uri-list' ||
    LINK_PATTERN.test(entry.title.trim()) ||
    (typeof entry.preview === 'string' && LINK_PATTERN.test(entry.preview.trim()));
  const thumbSrc =
    !thumbFailed && entry.thumbnailUrl
      ? entry.thumbnailUrl
      : !thumbFailed && entry.mediaType?.startsWith('image/') && entry.id.length > 0
        ? `/api/materials/${encodeURIComponent(entry.id)}/original`
        : undefined;

  const href = entry.href ?? materialPath(entry.id);
  const timeText = formatFeedTime(entry.savedAt);
  const sizeText = formatFileSize(entry.sizeBytes);
  const metaParts = [
    timeText,
    mediaKindLabel(entry.mediaType, isLink),
    sizeText,
    entry.pageCount ? `共 ${entry.pageCount} 页` : undefined,
  ].filter(Boolean);
  const cleanPreview =
    entry.preview && !isTechnicalIdentifier(entry.preview) ? entry.preview.slice(0, 110) : '';

  return (
    <article className="tv2-feed-item">
      <a
        className="tv2-feed-link"
      href={href}
      onClick={(event) => handleSpaNavigation(event, href, onNavigate)}
      >
        <span className={'tv2-thumb' + (thumbSrc ? ' tv2-thumb--photo' : '')} aria-hidden="true">
          {thumbSrc ? (
            <img src={thumbSrc} alt="" loading="lazy" onError={() => setThumbFailed(true)} />
          ) : (
            <MediaPlaceholder
              {...(entry.mediaType ? { mediaType: entry.mediaType } : {})}
              isLink={isLink}
            />
          )}
        </span>

        <span className="tv2-feed-copy">
          <strong>{entry.title}</strong>
          {metaParts.length > 0 && <small className="tv2-feed-meta">{metaParts.join(' · ')}</small>}
          {cleanPreview && <small className="tv2-feed-preview">{cleanPreview}</small>}
        </span>

        <span className="tv2-feed-end">
          {renderStatusChip(entry.status)}
          <span className="tv2-feed-chevron" aria-hidden="true">
            <Icon name="chevron" />
          </span>
        </span>
      </a>
      {entry.questionCount !== undefined && entry.questionCount > 0 && (
        <a
          className="tv2-feed-question-link"
          href={href}
          onClick={(event) => handleSpaNavigation(event, href, onNavigate)}
        >
          已识别 {entry.questionCount} 题 · 核对题目 / 生成微卷
        </a>
      )}
      {entry.canRetryVision && (
        <button
          type="button"
          className="tv2-btn tv2-btn--tonal tv2-feed-retry"
          disabled={retrying}
          onClick={() => onRetryVision(entry)}
        >
          {retrying ? '正在重新识别…' : '重新用视觉模型识别'}
        </button>
      )}
      {retryError && <p className="tv2-error" role="alert">{retryError}</p>}
    </article>
  );
}

function readStoredPurpose(): IntakePurpose {
  const saved = remembered(PURPOSE_STORAGE_KEY);
  return saved === 'save-only' ? 'save-only' : 'learning';
}

export function IntakeSurface({
  onNavigate,
  onMaterialSaved,
  feed,
  defaultPurpose,
  onPurposeChange,
  maxHistory = 20,
}: IntakeSurfaceProps) {
  const [text, setText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [localPurpose, setLocalPurpose] = useState<IntakePurpose>(() =>
    defaultPurpose ?? readStoredPurpose(),
  );
  const [materials, setMaterials] = useState<IntakeFeedEntry[] | null>(
    feed ? feed.slice(0, maxHistory) : null,
  );
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryErrors, setRetryErrors] = useState<Readonly<Record<string, string>>>({});
  const [pendingPages, setPendingPages] = useState<readonly PendingPage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const purpose: IntakePurpose = defaultPurpose ?? localPurpose;

  useEffect(() => {
    if (defaultPurpose) setLocalPurpose(defaultPurpose);
  }, [defaultPurpose]);

  useEffect(() => {
    if (feed) return;
    const refresh = () => setReloadTick((count) => count + 1);
    const onStorage = (event: StorageEvent) => {
      if (event.key === latestKey) refresh();
    };
    window.addEventListener(latestKey, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(latestKey, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, [feed]);

  useEffect(() => {
    if (feed) {
      setMaterials(feed.slice(0, maxHistory));
      return;
    }
    const controller = new AbortController();
    void api<Workspace>('/workspace', { signal: controller.signal })
      .then(async (workspace) => {
        if (controller.signal.aborted) return;
        const displayEntries = feedFromWorkspace(workspace?.materials ?? []).slice(0, maxHistory);
        setMaterials(displayEntries);

        const enrichTargets = displayEntries.slice(0, Math.min(displayEntries.length, 12));
        const plainIds = readPlainMaterialIds();
        const rawById = new Map((workspace?.materials ?? []).map((item) => [item.id, item]));
        const candidates = enrichTargets.filter((entry) => {
          if (entry.mediaType === 'text/uri-list' || plainIds.has(entry.id)) return false;
          const raw = rawById.get(entry.id);
          const rawTitle = raw?.title?.trim() ?? '';
          const rawText = raw?.text?.trim() ?? '';
          const looksLikeShortPlainNote =
            rawTitle.length > 0 && rawTitle === rawText && !/\.[a-z0-9]{2,5}$/i.test(rawTitle);
          return !looksLikeShortPlainNote;
        });
        if (candidates.length === 0) return;
        const enriched = await Promise.all(
          candidates.map(async (entry) => {
            try {
              const response = await fetch(
                `/api/materials/${encodeURIComponent(entry.id)}`,
                { signal: controller.signal },
              );
              if (response.status === 404) {
                markPlainMaterialId(entry.id);
                return null;
              }
              if (!response.ok) return null;
              const metadata = (await response.json()) as IntakeMetadata;
              if (!metadata?.id || !metadata.original) return null;
              return entryFromMetadata(metadata);
            } catch {
              return null;
            }
          }),
        );
        if (controller.signal.aborted) return;
        const byId = new Map<string, IntakeFeedEntry>();
        for (const item of enriched) {
          if (item) byId.set(item.id, item);
        }
        if (byId.size > 0) {
          setMaterials((current) =>
            (current ?? displayEntries).map((item) => {
              const enriched = byId.get(item.id);
              return enriched ? { ...item, ...enriched } : item;
            }),
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setMaterials([]);
      });
    return () => controller.abort();
  }, [feed, maxHistory, reloadTick]);

  const organizingIdsKey =
    !feed && materials
      ? materials
          .filter((entry) => entry.status === 'organizing')
          .map((entry) => entry.id)
          .join(',')
      : '';

  useEffect(() => {
    if (!organizingIdsKey) return;
    const ids = organizingIdsKey.split(',').filter(Boolean);
    if (ids.length === 0) return;
    const controller = new AbortController();
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      attempts += 1;
      if (attempts > MAX_ORGANIZING_POLL_ATTEMPTS) {
        window.clearInterval(timer);
        return;
      }
      void Promise.all(
        ids.map(async (id) => {
          try {
            const response = await fetch(`/api/materials/${encodeURIComponent(id)}`, {
              signal: controller.signal,
            });
            if (!response.ok) return null;
            const metadata = (await response.json()) as IntakeMetadata;
            if (!metadata?.id || !metadata.original) return null;
            return entryFromMetadata(metadata);
          } catch {
            return null;
          }
        }),
      ).then((updated) => {
        if (controller.signal.aborted) return;
        const byId = new Map<string, IntakeFeedEntry>();
        for (const item of updated) {
          if (item) byId.set(item.id, item);
        }
        if (byId.size > 0) {
          setMaterials((current) =>
            current ? current.map((item) => byId.get(item.id) ?? item) : current,
          );
        }
      });
    }, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [organizingIdsKey]);

  function updatePurpose(next: IntakePurpose) {
    if (next === purpose) return;
    setLocalPurpose(next);
    remember(PURPOSE_STORAGE_KEY, next);
    onPurposeChange?.(next);
    setNotice(
      next === 'save-only'
        ? '已切换为「仅保存」：新交入原件仅自己可见，随时可改。'
        : '已确认默认策略「学习使用」：新交入材料允许抽取与整理，单份随时可改回仅保存。',
    );
  }

  async function submitFile(file: File) {
    if (busy) return;
    if (file.size === 0) {
      setError('这个文件是空的，请换一份。');
      return;
    }
    if (file.size > INTAKE_LIMIT_BYTES) {
      setError('文件超过 25 MB，请换一份。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    const request = submissionId();
    try {
      if (!navigator.onLine) {
        await enqueue({ kind: 'file', id: request, title: '', file });
        setNotice(`「${file.name}」已离线排队，连网后按当前设置自动交入。`);
        return;
      }
      const watermark = bindDeletionWatermark(request);
      await synchronizeDeletion();
      const form = new FormData();
      form.set(
        'extraction',
        purpose === 'learning' && VISION_OCR_MEDIA_TYPES.has(file.type)
          ? 'vision_llm'
          : 'local',
      );
      form.set('requestId', request);
      form.set('deletionWatermark', watermark);
      form.set('title', '');
      form.set('file', file);
      const response = await fetch('/api/intake', { method: 'POST', body: form });
      verifyGenerationReceipt(response, watermark);
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        if (response.status === 410 || failure?.code === 'deletion_watermark_stale') {
          throw new ApiError(response.status, '删除状态已变化，请重新选择文件再交入。', failure?.code);
        }
        throw new ApiError(
          response.status,
          typeof failure?.error === 'string' ? failure.error : '交入未确认，请再试一次。',
          typeof failure?.code === 'string' ? failure.code : undefined,
        );
      }
      let metadata = (await response.json()) as IntakeMetadata;
      if (!metadata?.id) throw new Error('交入回执不完整。');

      if (purpose === 'learning' && metadata.backgroundResearch === 'private') {
        try {
          metadata = await api<IntakeMetadata>(
            `/materials/${encodeURIComponent(metadata.id)}/research-permission`,
            { method: 'PUT', body: { expectedRev: metadata.revision, enabled: true } },
          );
        } catch {
          // Keep the actual backend state ('private') honestly if permission update did not settle.
        }
      }

      const nextEntry = entryFromMetadata(metadata, {
        savedAt: '刚刚',
      });
      setMaterials((current) => {
        const deduped = (current ?? []).filter((item) => item.id !== nextEntry.id);
        return [nextEntry, ...deduped].slice(0, maxHistory);
      });
      onMaterialSaved?.();
      const policySuffix =
        nextEntry.status === 'organizing'
          ? '正在后台整理中。'
          : nextEntry.status === 'saved'
            ? '已按仅保存收进私人目录。'
            : '已收进材料库。';
      setNotice(`「${nextEntry.title}」已交入，${policySuffix}`);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.message
          ? failure.message
          : '交入结果尚未确认，请核对下方历史或重试。',
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitText() {
    const trimmed = text.trim();
    if (busy || !trimmed) return;
    if (trimmed.length > 4000) {
      setError('一句话材料最多 4000 字，请精简或改用文件交入。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    const isLink = LINK_PATTERN.test(trimmed);
    const title = isLink ? trimmed.slice(0, 240) : trimmed.slice(0, 60);
    const request = submissionId();
    try {
      if (!navigator.onLine) {
        await enqueue({ kind: 'material', id: request, title, text: trimmed });
        setText('');
        setNotice('已离线排队，连网后自动保存。');
        return;
      }
      const result = await api<{ id?: string }>('/materials', {
        method: 'POST',
        body: { requestId: request, title, text: trimmed },
      });
      setText('');
      const createdId = result?.id;
      if (createdId) markPlainMaterialId(createdId);
      const entryId = createdId ?? request;
      const nextEntry: IntakeFeedEntry = {
        id: entryId,
        title,
        mediaType: isLink ? 'text/uri-list' : 'text/plain',
        status: 'saved',
        purpose: 'save-only',
        savedAt: '刚刚',
        ...(trimmed !== title ? { preview: trimmed } : {}),
        ...(createdId ? { href: materialPath(createdId) } : {}),
      };
      setMaterials((current) => [nextEntry, ...(current ?? [])].slice(0, maxHistory));
      onMaterialSaved?.();
      setNotice(
        isLink
          ? '公开链接已按「仅保存」记下，不会抓取外部预览。'
          : '已按「仅保存」记下这句话，随时可以在材料详情调整用途。',
      );
    } catch (failure) {
      if (deletedSubmission(failure)) {
        setError('删除状态已变化，请再提交一次。');
      } else {
        setError(
          failure instanceof ApiError && failure.message
            ? failure.message
            : '没有记下，文字还在，请再试一次。',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function retryVision(entry: IntakeFeedEntry) {
    if (retryingId !== null) return;
    setRetryingId(entry.id);
    setRetryErrors(current => ({ ...current, [entry.id]: '' }));
    try {
      let revision = entry.revision;
      if (revision === undefined) {
        const metadata = await api<IntakeMetadata>(`/materials/${encodeURIComponent(entry.id)}`);
        revision = metadata.revision;
      }
      const metadata = await api<IntakeMetadata>(`/materials/${encodeURIComponent(entry.id)}/retry-vision`, {
        method: 'POST',
        body: { requestId: requestId(), expectedRev: revision },
      });
      const updated = entryFromMetadata(metadata, { savedAt: entry.savedAt, localPreviewUrl: entry.thumbnailUrl });
      setMaterials(current => current?.map(item => item.id === entry.id ? { ...item, ...updated } : item) ?? current);
      setNotice(`「${updated.title}」已重新进入视觉识别队列。`);
    } catch (failure) {
      const message = failure instanceof ApiError && failure.status === 409
        ? '这份材料已更新或当前状态不能重识别，正在回到最新状态。'
        : '视觉重识别暂时没有排队，请稍后重试。';
      setRetryErrors(current => ({ ...current, [entry.id]: message }));
      if (failure instanceof ApiError && failure.status === 409) {
        try {
          const metadata = await api<IntakeMetadata>(`/materials/${encodeURIComponent(entry.id)}`);
          const updated = entryFromMetadata(metadata, { savedAt: entry.savedAt, localPreviewUrl: entry.thumbnailUrl });
          setMaterials(current => current?.map(item => item.id === entry.id ? { ...item, ...updated } : item) ?? current);
        } catch {
          // Keep the inline conflict message if a refresh also fails.
        }
      }
    } finally {
      setRetryingId(null);
    }
  }

  function addPendingPages(files: readonly File[]) {
    setError('');
    setNotice('');
    const images = files.filter(isPhotoFile);
    const rejected = files.length - images.length;
    if (rejected > 0) {
      setError(`已忽略 ${rejected} 份非图片文件；多页合并仅支持照片，PDF 或文本请单独交入。`);
    }
    if (images.length === 0) return;
    const usable = images.filter(item => item.size > 0 && item.size <= INTAKE_LIMIT_BYTES);
    if (usable.length < images.length) {
      setError('单张照片需在 25 MB 以内，已先收下合规的照片。');
    }
    if (usable.length === 0) return;
    void Promise.all(
      usable.map(async (file) => ({
        file,
        previewUrl: await readFileAsDataUrl(file).catch(() => ''),
      })),
    ).then((loaded) => {
      setPendingPages((current) => {
        const space = INTAKE_MAX_PAGES - current.length;
        if (space <= 0) {
          setError(`一份试卷最多合并 ${INTAKE_MAX_PAGES} 页照片。`);
          return current;
        }
        if (loaded.length > space) {
          setError(`最多再补 ${space} 页，已先收前 ${space} 张；其余照片请另开一份。`);
        }
        return [...current, ...loaded.slice(0, space)];
      });
    });
  }

  function movePendingPage(index: number, offset: -1 | 1) {
    setPendingPages(current => {
      const target = index + offset;
      if (index < 0 || target < 0 || index >= current.length || target >= current.length) return current;
      const next = current.slice();
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return next;
    });
  }

  function removePendingPage(index: number) {
    setPendingPages(current => current.filter((_, position) => position !== index));
  }

  async function submitPendingPages() {
    if (busy || pendingPages.length === 0) return;
    const files = pendingPages.map(item => item.file);
    const total = files.reduce((sum, item) => sum + item.size, 0);
    if (files.some(item => !isPhotoFile(item))) {
      setError('多页合并仅支持照片。');
      return;
    }
    if (files.length > INTAKE_MAX_PAGES) {
      setError(`一份试卷最多合并 ${INTAKE_MAX_PAGES} 页照片。`);
      return;
    }
    if (total > INTAKE_MULTI_PAGE_TOTAL_BYTES) {
      setError('多页合并总大小超过 60 MB，请先压缩或分批交入。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    const request = submissionId();
    try {
      if (!navigator.onLine) {
        setError('多页合并需要联网，请在连接后重试。');
        return;
      }
      const watermark = bindDeletionWatermark(request);
      await synchronizeDeletion();
      const form = new FormData();
      form.set('extraction', files.length > 1 || purpose === 'learning' ? 'vision_llm' : 'local');
      form.set('requestId', request);
      form.set('deletionWatermark', watermark);
      form.set('title', '');
      for (const file of files) form.append('files', file);
      const response = await fetch('/api/intake', { method: 'POST', body: form });
      verifyGenerationReceipt(response, watermark);
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        if (response.status === 410 || failure?.code === 'deletion_watermark_stale') {
          throw new ApiError(response.status, '删除状态已变化，请重新选择文件再交入。', failure?.code);
        }
        throw new ApiError(
          response.status,
          typeof failure?.error === 'string' ? failure.error : '交入未确认，请再试一次。',
          typeof failure?.code === 'string' ? failure.code : undefined,
        );
      }
      let metadata = (await response.json()) as IntakeMetadata;
      if (!metadata?.id) throw new Error('交入回执不完整。');
      if (purpose === 'learning' && metadata.backgroundResearch === 'private') {
        try {
          metadata = await api<IntakeMetadata>(
            `/materials/${encodeURIComponent(metadata.id)}/research-permission`,
            { method: 'PUT', body: { expectedRev: metadata.revision, enabled: true } },
          );
        } catch {
          // Keep the actual backend state honestly if the permission update did not settle.
        }
      }
      const nextEntry = entryFromMetadata(metadata, { savedAt: '刚刚' });
      setMaterials((current) => {
        const deduped = (current ?? []).filter((item) => item.id !== nextEntry.id);
        return [nextEntry, ...deduped].slice(0, maxHistory);
      });
      onMaterialSaved?.();
      setPendingPages([]);
      setNotice(
        nextEntry.status === 'organizing'
          ? `「${nextEntry.title}」共 ${files.length} 页已交入，正在后台逐页识别。`
          : `「${nextEntry.title}」共 ${files.length} 页已收进材料库。`,
      );
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.message
          ? failure.message
          : '交入结果尚未确认，请核对下方历史或重试。',
      );
    } finally {
      setBusy(false);
    }
  }

  function handleDroppedFiles(files: readonly File[]) {
    const images = files.filter(isPhotoFile);
    if (files.length === 0) return;
    if (images.length === 0 && files.length === 1) {
      void submitFile(files[0]!);
      return;
    }
    if (images.length > 0) {
      addPendingPages(files);
      return;
    }
    setError('一次多份材料时，仅照片可合并为一卷；PDF 或文本请单独交入。');
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    handleDroppedFiles(files);
  }

  function handleFilePick(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    handleDroppedFiles(files);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = event.clipboardData?.files?.[0];
    if (file) {
      event.preventDefault();
      void submitFile(file);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && text.trim().length > 0) {
      event.preventDefault();
      void submitText();
    }
  }

  const trimmedText = text.trim();
  const hasText = trimmedText.length > 0;
  const isLinkInput = LINK_PATTERN.test(trimmedText);
  const submitLabel = isLinkInput ? '保存链接' : '记下这句话';

  return (
    <section className="tv2" aria-label="交入">
      <header className="tv2-bar">
        <div className="tv2-bar-title">
          <h1>交入</h1>
          <span className="tv2-muted">不用选学科，也不用填表，拍卷、PDF、链接或一句话直接放进来</span>
        </div>
      </header>

      <div
        className={'tv2-drop' + (dragOver ? ' tv2-drop--over' : '')}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        aria-label="交入投递区"
      >
        <textarea
          value={text}
          disabled={busy}
          rows={3}
          placeholder="拍卷选图、传 PDF、粘贴公开链接，或随手写一句话 — 支持拖拽文件与直接粘贴截图"
          aria-label="交入内容"
          onChange={(event) => {
            setText(event.target.value);
            setError('');
          }}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
        />

        <div className="tv2-drop-foot">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_FILE_TYPES}
            multiple
            hidden
            onChange={handleFilePick}
          />
          <button
            type="button"
            className="tv2-btn tv2-btn--tonal"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="plus" />
            <span>拍卷 / 选图 / 传 PDF</span>
          </button>
          {hasText && (
            <button
              type="button"
              className="tv2-btn tv2-btn--primary"
              disabled={busy}
              onClick={() => void submitText()}
            >
              {busy ? '正在保存…' : submitLabel}
            </button>
          )}
          <span className="tv2-drop-formats">PNG / JPEG / WebP / PDF / 文本 · ≤ 25 MB</span>
        </div>

        {pendingPages.length > 0 && (
          <div className="tv2-pages" aria-label="多页试卷待交入队列">
            <div className="tv2-pages-head">
              <strong>多页试卷 · 共 {pendingPages.length} 页</strong>
              <span className="tv2-muted">按页序合并为一份试卷；顺序即第 1..{pendingPages.length} 页</span>
            </div>
            <ul className="tv2-pages-list">
              {pendingPages.map((item, index) => (
                <li key={`${item.file.name}-${index}`} className="tv2-pages-item">
                  <span className="tv2-pages-thumb" aria-hidden="true">
                    {item.previewUrl ? (
                      <img src={item.previewUrl} alt="" />
                    ) : (
                      <span className="tv2-pages-thumb-empty">P{index + 1}</span>
                    )}
                  </span>
                  <span className="tv2-pages-copy">
                    <strong>P{index + 1} · {item.file.name}</strong>
                    <small className="tv2-muted">{formatFileSize(item.file.size) ?? `${item.file.size} B`}</small>
                  </span>
                  <span className="tv2-pages-tools">
                    <button
                      type="button"
                      disabled={busy || index === 0}
                      aria-label={`上移第 ${index + 1} 页`}
                      onClick={() => movePendingPage(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={busy || index === pendingPages.length - 1}
                      aria-label={`下移第 ${index + 1} 页`}
                      onClick={() => movePendingPage(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`移除第 ${index + 1} 页`}
                      onClick={() => removePendingPage(index)}
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="tv2-pages-foot">
              {pendingPages.length < INTAKE_MAX_PAGES && (
                <button
                  type="button"
                  className="tv2-btn tv2-btn--tonal"
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  + 继续加页（当前 {pendingPages.length}/{INTAKE_MAX_PAGES} 页）
                </button>
              )}
              <button
                type="button"
                className="tv2-btn tv2-btn--primary"
                disabled={busy || pendingPages.length === 0}
                onClick={() => void submitPendingPages()}
              >
                {busy ? '正在交入…' : `合并交入这 ${pendingPages.length} 页试卷`}
              </button>
              <button
                type="button"
                className="tv2-btn tv2-btn--ghost"
                disabled={busy}
                onClick={() => setPendingPages([])}
              >
                清空
              </button>
            </div>
          </div>
        )}

        <div className="tv2-privacy-bar" role="region" aria-label="隐私与默认用途">
          <div className="tv2-privacy-copy">
            <span className="tv2-privacy-title">
              <Icon name="lock" />
              <strong>{purpose === 'save-only' ? '默认：仅保存' : '已确认默认：学习使用'}</strong>
            </span>
            <span className="tv2-privacy">
              {purpose === 'save-only'
                ? pendingPages.length > 1
                  ? '多页拍照将自动视觉识题便于核对，默认仅保存不开放教学，随时可改。'
                  : '原件收进私人目录，不进入抽取、题库或后台整理；公开链接不抓取预览，随时可改。'
                : '新交入文件允许抽取文字并参与整理，单份原件随时可在详情改回仅保存。'}
            </span>
          </div>
          <div className="tv2-seg tv2-seg--compact" role="group" aria-label="切换默认用途">
            <button
              type="button"
              className="tv2-seg-btn"
              aria-pressed={purpose === 'save-only'}
              disabled={busy}
              onClick={() => updatePurpose('save-only')}
            >
              仅保存
            </button>
            <button
              type="button"
              className="tv2-seg-btn"
              aria-pressed={purpose === 'learning'}
              disabled={busy}
              onClick={() => updatePurpose('learning')}
            >
              学习使用
            </button>
          </div>
        </div>

        {error && (
          <p className="tv2-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="tv2-notice" role="status">
            {notice}
          </p>
        )}
      </div>

      <section className="tv2-section" aria-label="交入历史">
        <div className="tv2-section-head">
          <h3>最近交入</h3>
          {materials !== null && materials.length > 0 && (
            <span className="tv2-muted">{materials.length} 份</span>
          )}
        </div>

        {materials === null ? (
          <div className="tv2-loading-shell" role="status">
            <BreathDot />
            <span>正在读取交入历史…</span>
          </div>
        ) : materials.length === 0 ? (
          <div className="tv2-empty-feed">
            <p className="tv2-muted">还没有交入记录，第一份照片、PDF、链接或一句话放进来后会出现在这里。</p>
          </div>
        ) : (
          <div className="tv2-feed">
            {materials.map((entry) => (
              <FeedRow
                key={entry.id}
                entry={entry}
                onNavigate={onNavigate}
                onRetryVision={(item) => void retryVision(item)}
                retrying={retryingId === entry.id}
                retryError={retryErrors[entry.id] || undefined}
              />
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

export default IntakeSurface;
const PLAIN_MATERIAL_IDS_KEY = 'today-v2:plain-material-ids';

function readPlainMaterialIds(): Set<string> {
  try {
    const raw = JSON.parse(remembered(PLAIN_MATERIAL_IDS_KEY) ?? '[]');
    return Array.isArray(raw) ? new Set(raw.filter((item): item is string => typeof item === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function markPlainMaterialId(id: string) {
  const current = readPlainMaterialIds();
  if (current.has(id)) return;
  const next = [id, ...current].slice(0, 120);
  remember(PLAIN_MATERIAL_IDS_KEY, JSON.stringify(next));
}
