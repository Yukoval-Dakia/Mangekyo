import { requestId } from '../api';
import type { MemoryItem, MemoryItemInput, MemoryOverviewResponse } from './types';

const memoryOverviewPath = '/memory/overview';
const claimsPath = '/memory/claims/';

export async function fetchMemoryOverview(path = memoryOverviewPath): Promise<MemoryOverviewResponse> {
  const response = await fetch(`/api${path}`, { cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(response.status === 404 ? '暂未取得记忆总览。' : '读取记忆总览失败。');
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return normalizeOverview(await response.json());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function countOf(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function textValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function validBasis(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  return [];
}

function validActions(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && !!item.trim());
}

type DirectiveItem = MemoryOverviewResponse['stickyDirectives'][number];
type HypothesisItem = MemoryOverviewResponse['hypotheses'][number];

function normalizeDirective(value: unknown): DirectiveItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = textValue(value.id);
  const kind = textValue(value.kind, 'learning');
  const rev = typeof value.rev === 'number' && Number.isSafeInteger(value.rev) ? value.rev : 0;
  const basis = validBasis(value.basis);
  const actions = validActions(value.actions);
  if (!id) return undefined;
  const text = textValue(value.text, '未提供文字说明。');
  return { id, rev, kind, text, sticky: true, basis, actions };
}

function normalizeHypothesis(value: unknown): HypothesisItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = textValue(value.id);
  const kind = textValue(value.kind, 'learning');
  const rev = typeof value.rev === 'number' && Number.isSafeInteger(value.rev) ? value.rev : 0;
  const basis = validBasis(value.basis);
  const actions = validActions(value.actions);
  if (!id) return undefined;
  const summary = textValue(value.summary, textValue(value.text, '未提供文字说明。'));
  const status = textValue(value.status, 'unknown');
  return { id, rev, kind, summary, status, basis, actions };
}

function present<T>(value: T | undefined): value is T {
  return !!value;
}

export function normalizeOverview(value: unknown): MemoryOverviewResponse {
  if (!isRecord(value)) throw new Error('记忆总览格式无效。');
  const categories = isRecord(value.categories) ? value.categories : {};
  const stickyDirectives = Array.isArray(value.stickyDirectives)
    ? value.stickyDirectives.map(normalizeDirective).filter(present)
    : [];
  const hypotheses = Array.isArray(value.hypotheses)
    ? value.hypotheses.map(normalizeHypothesis).filter(present)
    : [];
  const calibration = isRecord(value.calibration) ? value.calibration : {};
  const recent = Array.isArray(calibration.recent)
    ? calibration.recent
        .map((item) => {
          if (!isRecord(item)) return undefined;
          const key = textValue(item.key);
          const status = textValue(item.status, 'unknown');
          const occurredAt = textValue(item.occurredAt);
          const conceptId = typeof item.conceptId === 'string' ? item.conceptId : null;
          return key ? { key, status, conceptId, occurredAt } : undefined;
        })
        .filter(present)
    : [];
  const total = typeof calibration.totalReconciliations === 'number' && Number.isSafeInteger(calibration.totalReconciliations)
    ? calibration.totalReconciliations
    : recent.length;
  const confirmed = typeof calibration.confirmed === 'number' && Number.isSafeInteger(calibration.confirmed)
    ? calibration.confirmed
    : recent.filter((item) => item.status === 'confirmed').length;
  const missed = typeof calibration.missed === 'number' && Number.isSafeInteger(calibration.missed)
    ? calibration.missed
    : Math.max(0, total - confirmed);
  const status = calibration.status === 'available' ? 'available' : 'unknown';
  return {
    asOf: textValue(value.asOf, new Date().toISOString()),
    categories: {
      preference: countOf(categories.preference),
      claim: countOf(categories.claim),
      state: countOf(categories.state),
      refusal: countOf(categories.refusal),
    },
    stickyDirectives,
    hypotheses,
    calibration: { status, totalReconciliations: total, confirmed, missed, recent },
  };
}

async function postMemory(path: string, body: Record<string, unknown>) {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error(response.status === 404 ? '当前记忆管理服务暂不可用。' : '记忆保存失败。');
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return response.json().catch(() => null);
}

function defaultUpdateItem(input: MemoryItemInput) {
  const { item, text } = input;
  if (!text?.trim()) throw new Error('请先填写修改内容。');
  if (!input.accessEpoch) throw new Error('暂缺少版本见证，无法安全修改。');
  return postMemory(`${claimsPath}${encodeURIComponent(item.id)}`, {
    requestId: requestId(),
    action: 'correct',
    rev: item.rev,
    accessEpoch: input.accessEpoch,
    text: text.trim(),
  });
}

function defaultWithdrawItem(input: MemoryItemInput) {
  const { item } = input;
  if (!input.undoToken) throw new Error('暂缺少撤回凭据，无法安全撤回。');
  return postMemory(`${claimsPath}${encodeURIComponent(item.id)}/undo`, { undo_token: input.undoToken });
}

export const memoryOverviewDefaults = {
  fetchOverview: fetchMemoryOverview,
  updateItem: defaultUpdateItem,
  withdrawItem: defaultWithdrawItem,
};
