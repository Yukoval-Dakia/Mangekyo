import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isNotFound, uploadAttachment } from './api.ts';
import { requestId } from '../api.ts';
import type { AttachmentScope, PendingAttachment, ReviewAttachment } from './types.ts';

const ACCEPT = 'image/png,image/jpeg,image/webp';
const MAX_BYTES = 12 * 1024 * 1024;

export type UploadSummary = { uploading: number; failed: number; done: number };
export type PaperUploadLock = {
  uploading: number;
  failed: number;
  locked: boolean;
  blockedItemIds: readonly string[];
};

let localSeq = 0;
const nextLocalId = () => `att-${Date.now().toString(36)}-${(localSeq += 1)}`;

function isSupportedImage(file: File): boolean {
  return file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp';
}

export function summarizeAttachments(entries: readonly PendingAttachment[]): UploadSummary {
  let uploading = 0;
  let failed = 0;
  let done = 0;
  for (const entry of entries) {
    if (entry.state.phase === 'uploading') uploading += 1;
    else if (entry.state.phase === 'error') failed += 1;
    else if (entry.state.phase === 'done') done += 1;
  }
  return { uploading, failed, done };
}

export type PaperAttachmentController = {
  itemsByQuestion: Readonly<Record<string, readonly PendingAttachment[]>>;
  notesByQuestion: Readonly<Record<string, string>>;
  summariesByQuestion: Readonly<Record<string, UploadSummary>>;
  lock: PaperUploadLock;
  addFiles: (itemId: string, files: FileList | null) => void;
  retryUpload: (itemId: string, localId: string) => void;
  removeAttachment: (itemId: string, localId: string) => void;
  toggleScope: (itemId: string, localId: string) => void;
  resetAll: () => void;
};

export function usePaperAttachments(paperId: string): PaperAttachmentController {
  const [itemsByQuestion, setItemsByQuestion] = useState<Record<string, readonly PendingAttachment[]>>({});
  const [notesByQuestion, setNotesByQuestion] = useState<Record<string, string>>({});
  const itemsRef = useRef<Record<string, readonly PendingAttachment[]>>({});
  const controllersRef = useRef(new Map<string, AbortController>());
  const paperIdRef = useRef(paperId);
  paperIdRef.current = paperId;

  const setQuestionItems = useCallback((itemId: string, next: readonly PendingAttachment[]) => {
    itemsRef.current = { ...itemsRef.current, [itemId]: next };
    setItemsByQuestion((previous) => ({ ...previous, [itemId]: next }));
  }, []);

  const patchEntry = useCallback(
    (itemId: string, localId: string, mutate: (entry: PendingAttachment) => PendingAttachment) => {
      const current = itemsRef.current[itemId] ?? [];
      if (!current.some((entry) => entry.localId === localId)) return;
      setQuestionItems(
        itemId,
        current.map((entry) => (entry.localId === localId ? mutate(entry) : entry)),
      );
    },
    [setQuestionItems],
  );

  const runUpload = useCallback(
    (itemId: string, entry: PendingAttachment, scopeOverride?: AttachmentScope) => {
      const activePaperId = paperIdRef.current;
      const targetScope = scopeOverride ?? entry.scope;
      controllersRef.current.get(entry.localId)?.abort();
      const controller = new AbortController();
      controllersRef.current.set(entry.localId, controller);

      patchEntry(itemId, entry.localId, (current) => ({
        ...current,
        scope: targetScope,
        state: { phase: 'uploading', progress: 0 },
      }));

      uploadAttachment(
        activePaperId,
        { file: entry.file, itemId, scope: targetScope, requestId: requestId(), signal: controller.signal },
        (ratio) => {
          if (controller.signal.aborted || paperIdRef.current !== activePaperId) return;
          patchEntry(itemId, entry.localId, (current) =>
            current.state.phase === 'uploading'
              ? { ...current, state: { phase: 'uploading', progress: Math.max(0, Math.min(1, ratio)) } }
              : current,
          );
        },
      )
        .then((receipt) => {
          if (controller.signal.aborted || paperIdRef.current !== activePaperId) return;
          controllersRef.current.delete(entry.localId);
          patchEntry(itemId, entry.localId, (current) => ({
            ...current,
            scope: receipt.scope,
            state: {
              phase: 'done',
              originalId: receipt.originalId,
              rev: receipt.rev,
              url: receipt.url,
              mimeType: receipt.mimeType,
              scope: receipt.scope,
            },
          }));
        })
        .catch((caught: unknown) => {
          if (
            controller.signal.aborted ||
            paperIdRef.current !== activePaperId ||
            (caught instanceof ApiError && caught.code === 'aborted')
          ) {
            return;
          }
          controllersRef.current.delete(entry.localId);
          const message = isNotFound(caught)
            ? '当前后端暂不支持手写图上传，移除后即可正常交卷。'
            : caught instanceof Error
              ? caught.message
              : '上传失败';
          patchEntry(itemId, entry.localId, (current) => ({ ...current, state: { phase: 'error', message } }));
        });
    },
    [patchEntry],
  );

  const addFiles = useCallback(
    (itemId: string, list: FileList | null) => {
      if (!list?.length) return;
      let rejectedNote = '';
      const added: PendingAttachment[] = [];
      for (const file of Array.from(list)) {
        if (!isSupportedImage(file)) {
          rejectedNote = '只支持 PNG / JPEG / WebP 图片。';
          continue;
        }
        if (file.size > MAX_BYTES) {
          rejectedNote = `「${file.name}」超过 12MB，请压缩后再传。`;
          continue;
        }
        added.push({
          localId: nextLocalId(),
          file,
          previewUrl: URL.createObjectURL(file),
          scope: 'inherit',
          state: { phase: 'uploading', progress: 0 },
        });
      }
      setNotesByQuestion((previous) => ({ ...previous, [itemId]: rejectedNote }));
      if (!added.length) return;
      const existing = itemsRef.current[itemId] ?? [];
      setQuestionItems(itemId, [...existing, ...added]);
      for (const entry of added) runUpload(itemId, entry);
    },
    [runUpload, setQuestionItems],
  );

  const retryUpload = useCallback(
    (itemId: string, localId: string) => {
      const target = (itemsRef.current[itemId] ?? []).find((entry) => entry.localId === localId);
      if (!target) return;
      runUpload(itemId, target);
    },
    [runUpload],
  );

  const removeAttachment = useCallback(
    (itemId: string, localId: string) => {
      controllersRef.current.get(localId)?.abort();
      controllersRef.current.delete(localId);
      const current = itemsRef.current[itemId] ?? [];
      const target = current.find((entry) => entry.localId === localId);
      if (target) URL.revokeObjectURL(target.previewUrl);
      setQuestionItems(
        itemId,
        current.filter((entry) => entry.localId !== localId),
      );
    },
    [setQuestionItems],
  );

  const toggleScope = useCallback(
    (itemId: string, localId: string) => {
      const target = (itemsRef.current[itemId] ?? []).find((entry) => entry.localId === localId);
      if (!target) return;
      const nextScope: AttachmentScope = target.scope === 'inherit' ? 'once' : 'inherit';
      if (target.state.phase === 'done' || target.state.phase === 'uploading') {
        runUpload(itemId, target, nextScope);
        return;
      }
      patchEntry(itemId, localId, (current) => ({ ...current, scope: nextScope }));
    },
    [patchEntry, runUpload],
  );

  const resetAll = useCallback(() => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    for (const list of Object.values(itemsRef.current)) {
      for (const entry of list) URL.revokeObjectURL(entry.previewUrl);
    }
    itemsRef.current = {};
    setItemsByQuestion({});
    setNotesByQuestion({});
  }, []);

  useEffect(() => {
    return () => {
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
      for (const list of Object.values(itemsRef.current)) {
        for (const entry of list) URL.revokeObjectURL(entry.previewUrl);
      }
      itemsRef.current = {};
    };
  }, [paperId]);

  const { summariesByQuestion, lock } = useMemo(() => {
    const summaries: Record<string, UploadSummary> = {};
    let uploading = 0;
    let failed = 0;
    const blockedItemIds: string[] = [];
    for (const [itemId, entries] of Object.entries(itemsByQuestion)) {
      const summary = summarizeAttachments(entries);
      summaries[itemId] = summary;
      uploading += summary.uploading;
      failed += summary.failed;
      if (summary.uploading + summary.failed > 0) blockedItemIds.push(itemId);
    }
    return {
      summariesByQuestion: summaries,
      lock: { uploading, failed, locked: uploading + failed > 0, blockedItemIds },
    };
  }, [itemsByQuestion]);

  return {
    itemsByQuestion,
    notesByQuestion,
    summariesByQuestion,
    lock,
    addFiles,
    retryUpload,
    removeAttachment,
    toggleScope,
    resetAll,
  };
}

export function QuestionAttachmentUploader({
  paperId,
  itemId,
  disabled,
  controller,
  onChange,
  register,
}: {
  paperId: string;
  itemId: string;
  disabled?: boolean | undefined;
  controller?: PaperAttachmentController | undefined;
  onChange?: ((itemId: string, attachments: readonly PendingAttachment[], summary: UploadSummary) => void) | undefined;
  register?: ((itemId: string, restore: readonly PendingAttachment[] | null) => readonly PendingAttachment[]) | undefined;
}) {
  const localController = usePaperAttachments(paperId);
  const active = controller ?? localController;
  const [seededItems, setSeededItems] = useState<readonly PendingAttachment[] | null>(() =>
    !controller && register ? register(itemId, null) : null,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  const items = active.itemsByQuestion[itemId] ?? seededItems ?? [];
  const note = active.notesByQuestion[itemId] ?? '';

  useEffect(() => {
    if (controller) return;
    const list = active.itemsByQuestion[itemId];
    if (!list) return;
    setSeededItems(null);
    onChange?.(itemId, list, summarizeAttachments(list));
    register?.(itemId, list);
  }, [controller, active.itemsByQuestion, itemId, onChange, register]);

  const uploading = items.filter((entry) => entry.state.phase === 'uploading').length;
  const failedEntries = items.filter((entry) => entry.state.phase === 'error');
  const firstError = failedEntries[0]?.state.phase === 'error' ? failedEntries[0].state.message : '';

  return (
    <div className="wbv2-attach">
      <div className="wbv2-attach-head">
        <span className="wbv2-attach-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M4 8h3l2-3h6l2 3h3v11H4z" strokeLinejoin="round" />
            <circle cx="12" cy="13" r="3.4" />
          </svg>
          手写过程 / 拍照图
        </span>
        <button type="button" className="wbv2-attach-add" disabled={disabled} onClick={() => inputRef.current?.click()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
          添加图片
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            active.addFiles(itemId, event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
      </div>
      <p className="wbv2-attach-hint">拍下手写步骤或草稿，随本题一起交卷。每张可选「跟随本卷」（之后练习可回看）或「仅本次」。</p>
      {items.length > 0 && (
        <div className="wbv2-thumbs">
          {items.map((entry) => (
            <figure key={entry.localId} className={`wbv2-thumb${entry.state.phase === 'error' ? ' is-error' : ''}`}>
              <img src={entry.previewUrl} alt="手写过程图预览" />
              <button
                type="button"
                className="wbv2-thumb-remove"
                aria-label="移除图片"
                disabled={disabled}
                onClick={() => active.removeAttachment(itemId, entry.localId)}
              >
                ×
              </button>
              <figcaption className="wbv2-thumb-state">
                {entry.state.phase === 'uploading' && (
                  <>
                    <span className="row">上传中 {Math.round(entry.state.progress * 100)}%</span>
                    <span className="bar"><i style={{ width: `${Math.round(entry.state.progress * 100)}%` }} /></span>
                  </>
                )}
                {entry.state.phase === 'error' && (
                  <span className="row">
                    上传失败
                    <button
                      type="button"
                      className="wbv2-scope retry"
                      onClick={() => active.retryUpload(itemId, entry.localId)}
                      disabled={disabled}
                    >
                      重试
                    </button>
                  </span>
                )}
                {entry.state.phase === 'done' && (
                  <span className="row">
                    已上传
                    <button
                      type="button"
                      className="wbv2-scope"
                      disabled={disabled}
                      onClick={() => active.toggleScope(itemId, entry.localId)}
                      title="切换用途"
                    >
                      {entry.scope === 'inherit' ? '跟随本卷' : '仅本次'}
                    </button>
                  </span>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {note && <p className="wbv2-attach-note warn">{note}</p>}
      {uploading > 0 && <p className="wbv2-attach-note info">尚有 {uploading} 张手写过程图正在上传，完成后即可交卷。</p>}
      {failedEntries.length > 0 && (
        <p className="wbv2-attach-note warn">
          有 {failedEntries.length} 张图片上传失败，请重试或移除后再交卷。{firstError ? `（${firstError}）` : ''}
        </p>
      )}
    </div>
  );
}

export function ReviewAttachmentWall({ attachments }: { attachments: readonly ReviewAttachment[] }) {
  const [brokenKeys, setBrokenKeys] = useState<ReadonlySet<string>>(() => new Set());

  if (!attachments.length) return null;
  return (
    <div className="wbv2-review-attach">
      <p className="wbv2-review-attach-title">本题手写过程图</p>
      <div className="grid">
        {attachments.map((attachment, order) => {
          const key = `${attachment.originalId}:${attachment.rev}`;
          const label = `过程图 ${order + 1}`;
          const canShow = attachment.available && Boolean(attachment.url) && !brokenKeys.has(key);
          return canShow ? (
            <figure key={key}>
              <img
                src={attachment.url}
                alt={`手写${label}`}
                loading="lazy"
                onError={() =>
                  setBrokenKeys((previous) => {
                    const next = new Set(previous);
                    next.add(key);
                    return next;
                  })
                }
              />
              <figcaption>{label}</figcaption>
            </figure>
          ) : (
            <figure key={key}>
              <div className="gone">图片权限已撤回或暂不可用</div>
              <figcaption>{label}</figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
