// workbook-v2 API 适配层。JSON 走顶层 api()；附件为 multipart，单独 fetch（surfaces 不受 runtime 禁限）。
import { api, ApiError, requestId } from '../api.ts';
import type {
  AttachmentReceipt,
  AttachmentScope,
  L0Source,
  OwnWordsConceptWitness,
  OwnWordsOpening,
  PreSubmitPitfall,
  PreSubmitRevisionPayload,
  QuestionAttachmentsPayload,
  ReviewAttachment,
  ReviewAttachmentsMap,
  TakeawayReview,
  TakeawaySaveReceipt,
  TakeawayUndoReceipt,
  WorkbookV2Detail,
} from './types.ts';

export { requestId, ApiError };

const enc = encodeURIComponent;

// ---------- 卷面 ----------
export function loadPaper(paperId: string, signal?: AbortSignal) {
  return api<WorkbookV2Detail>(`/papers/${enc(paperId)}`, { ...(signal ? { signal } : {}), cache: 'no-store' });
}

// ---------- 附件（域 1 定稿） ----------
// progress 需要 XHR 才能拿到 upload progress；fetch 无 upload 进度，用 XHR。
export function uploadAttachment(
  paperId: string,
  args: { file: File; itemId?: string; scope?: AttachmentScope; requestId?: string; signal?: AbortSignal },
  onProgress: (ratio: number) => void,
): Promise<AttachmentReceipt> {
  return new Promise((resolve, reject) => {
    if (args.signal?.aborted) {
      reject(new ApiError(0, '上传已取消。', 'aborted'));
      return;
    }
    const form = new FormData();
    form.append('file', args.file, args.file.name);
    if (args.itemId) form.append('itemId', args.itemId);
    if (args.scope) form.append('scope', args.scope);
    if (args.requestId) form.append('requestId', args.requestId);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/papers/${enc(paperId)}/attachments`);
    xhr.responseType = 'json';
    const onAbortSignal = () => xhr.abort();
    args.signal?.addEventListener('abort', onAbortSignal, { once: true });
    const cleanup = () => args.signal?.removeEventListener('abort', onAbortSignal);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      cleanup();
      const body = xhr.response as unknown;
      if ((xhr.status === 201 || xhr.status === 200) && body && typeof body === 'object') {
        const receipt = body as Partial<AttachmentReceipt>;
        if (typeof receipt.originalId === 'string' && typeof receipt.rev === 'number') {
          resolve({
            originalId: receipt.originalId,
            rev: receipt.rev,
            url: typeof receipt.url === 'string' ? receipt.url : '',
            mimeType: typeof receipt.mimeType === 'string' ? receipt.mimeType : args.file.type,
            scope: receipt.scope === 'once' ? 'once' : 'inherit',
          });
          return;
        }
      }
      reject(toApiError(xhr.status, body));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiError(0, '网络异常，未能上传图片。'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new ApiError(0, '上传已取消。', 'aborted'));
    };
    xhr.send(form);
  });
}

function toApiError(status: number, body: unknown): ApiError {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  return new ApiError(
    status,
    typeof record?.error === 'string' ? record.error : undefined,
    typeof record?.code === 'string' ? record.code : undefined,
  );
}

// ---------- 交卷 ----------
export type SubmitAttemptBody = {
  requestId: string;
  answers: Record<string, string | null>;
  questionAttachments?: QuestionAttachmentsPayload;
  confidence?: Record<string, number>;
  paperRev?: number;
  preSubmitRevisions?: readonly PreSubmitRevisionPayload[];
};
export function submitAttempt(paperId: string, body: SubmitAttemptBody) {
  return api<WorkbookV2Detail>(`/papers/${enc(paperId)}/attempts`, { method: 'POST', body });
}

export function loadPreSubmitPitfalls(paperId: string, signal?: AbortSignal) {
  return api<readonly PreSubmitPitfall[]>(`/papers/${enc(paperId)}/pre-submit-pitfalls`, {
    ...(signal ? { signal } : {}),
    cache: 'no-store',
  });
}

// ---------- 能力 22 · 自留口诀 ----------
export function saveTakeaway(
  paperId: string,
  attemptId: string,
  body: { requestId: string; attemptRev: number; itemId: string; text: string; concept?: OwnWordsConceptWitness | string },
) {
  return api<TakeawaySaveReceipt>(
    `/papers/${enc(paperId)}/attempts/${enc(attemptId)}/takeaways`,
    { method: 'POST', body },
  );
}
export function undoTakeaway(paperId: string, undoToken: string) {
  return api<TakeawayUndoReceipt>(`/papers/${enc(paperId)}/takeaways/undo`, {
    method: 'POST',
    body: { undo_token: undoToken },
  });
}

// ---------- 能力 22 · 事前 L0 防剧透 ----------
export function openOwnWords(
  paperId: string,
  body: { paperRev: number; itemId: string } & L0Source,
) {
  return api<OwnWordsOpening>(`/papers/${enc(paperId)}/takeaways/open`, { method: 'POST', body });
}
export function confirmOwnWordsDisplay(
  paperId: string,
  body: { paperRev: number; itemId: string; displayRef: string } & L0Source,
) {
  return api<{ recorded: true; displayRef: string }>(
    `/papers/${enc(paperId)}/takeaways/display`,
    { method: 'POST', body },
  );
}

// ---------- 交卷后口诀对照 ----------
export function loadTakeawayReview(paperId: string, attemptId: string, itemId: string, signal?: AbortSignal) {
  return api<TakeawayReview>(
    `/papers/${enc(paperId)}/attempts/${enc(attemptId)}/takeaways/${enc(itemId)}`,
    { ...(signal ? { signal } : {}), cache: 'no-store' },
  );
}

// 复盘附件（由 attempt.questionAttachments 透传，单独类型守卫）
export function reviewAttachmentsOf(
  attempt: { questionAttachments?: ReviewAttachmentsMap } | null | undefined,
  itemId: string,
): readonly ReviewAttachment[] {
  const map = attempt?.questionAttachments;
  const list = map?.[itemId];
  return Array.isArray(list) ? list : [];
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export type { CompanionCitation } from './types.ts';
