import {ApiError, requestId} from './api';
import {synchronizeDeletion, validWatermark, verifyGenerationReceipt} from './deletion-watermark';

export const returnPurposes = {
  storage: '仅保存原件',
  learning: '用于学习',
  teaching: '用于教学',
  'background-research': '用于后台研究',
};
export type ReturnPurpose = keyof typeof returnPurposes;
export type Upload = {issuanceId: string; page: number; retryId?: string; purpose: ReturnPurpose; file: File};
type Binding = {requestId: string; deletionWatermark: string};
export type UploadIntent = Binding & {key: string};
export type ReturnReceipt = {
  intent: 'paper-return'; id: string; revision: number; title: string; source: {id: string; rev: number};
  issuanceId: string; page: number; original: 0; runId: string; rev: number; independence: 'unknown'; created: boolean;
};

async function fingerprint(bytes: Uint8Array<ArrayBuffer>) {
  // A plain HTTP LAN surface lacks SubtleCrypto. This local lookup never substitutes for the host's byte check.
  if (!crypto.subtle) {
    let hash = 2166136261;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
    return bytes.length + '-' + (hash >>> 0).toString(16);
  }
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}

export async function bindUpload(upload: Upload): Promise<UploadIntent> {
  const {issuanceId, page, retryId, purpose, file} = upload;
  const identity = [issuanceId, page, retryId ?? null, purpose, file.name, file.type, await fingerprint(new Uint8Array(await file.arrayBuffer()))];
  const key = 'mangekyo:paper-return:' + await fingerprint(new TextEncoder().encode(JSON.stringify(identity)));
  // Only an opaque fingerprint and the retry binding survive a reload. The learner selects the file again.
  async function bind() {
    const existing = localStorage.getItem(key);
    if (existing !== null) {
      const value: Binding = JSON.parse(existing);
      if (!value?.requestId || !validWatermark(value.deletionWatermark)) throw new Error('原上传请求无法核对。');
      return {key, requestId:value.requestId, deletionWatermark:value.deletionWatermark};
    }
    const deletionWatermark = await synchronizeDeletion();
    const binding = {requestId:requestId(), deletionWatermark};
    localStorage.setItem(key, JSON.stringify(binding));
    return {key, ...binding};
  }
  return navigator.locks ? navigator.locks.request(key, bind) : bind();
}

export function forgetUpload(intent: UploadIntent) {
  const current = localStorage.getItem(intent.key);
  if (current && JSON.parse(current)?.requestId === intent.requestId) localStorage.removeItem(intent.key);
}

export async function submitUpload(upload: Upload, intent: UploadIntent): Promise<ReturnReceipt> {
  const form = new FormData();
  form.set('intent', 'paper-return');
  form.set('file', upload.file);
  form.set('issuanceId', upload.issuanceId);
  form.set('page', String(upload.page));
  form.set('purpose', upload.purpose);
  if (upload.retryId) form.set('retryId', upload.retryId);
  form.set('requestId', intent.requestId);
  form.set('deletionWatermark', intent.deletionWatermark);
  const response = await fetch('/api/intake', {method:'POST', body:form});
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new ApiError(response.status, typeof error?.error === 'string' ? error.error : undefined,
      typeof error?.code === 'string' ? error.code : undefined);
  }
  verifyGenerationReceipt(response, intent.deletionWatermark);
  const receipt: ReturnReceipt = await response.json();
  if (response.status !== 201 || receipt?.intent !== 'paper-return' || receipt.issuanceId !== upload.issuanceId ||
      receipt.page !== upload.page || receipt.original !== 0 || receipt.independence !== 'unknown' ||
      typeof receipt.id !== 'string' || !receipt.id || receipt.source?.id !== receipt.id ||
      !Number.isSafeInteger(receipt.source.rev) || receipt.source.rev < 1 ||
      !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 ||
      typeof receipt.runId !== 'string' || !receipt.runId || (upload.retryId && receipt.runId !== upload.retryId) ||
      !Number.isSafeInteger(receipt.rev) || receipt.rev < 1 || typeof receipt.created !== 'boolean' || typeof receipt.title !== 'string') {
    throw new Error('回执与本次上传不符，请用原请求核对。');
  }
  return receipt;
}
