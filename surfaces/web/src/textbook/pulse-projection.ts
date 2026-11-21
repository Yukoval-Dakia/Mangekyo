import { sourceRefV1 } from '../../../../modules/activity/source-values';
import { api } from '../api';
import type { Page } from './contract';

export const pulseLabels = {steady: '稳住', decaying: '临近遗忘', fragile: '近错待固', unknown: '暂无独立记录'};
export type PulseConcept = {
  conceptId: string;
  state: keyof typeof pulseLabels;
  history?: {kind: 'recent-error' | 'prior-stable'; href: string};
  candidate?: {key: string; issue: (requestId: string) => Promise<{id: string}>};
};
export type PulseRows = Map<string, PulseConcept[]>;
export type PulseReader = (signal: AbortSignal) => Promise<PulseRows>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function fixedHistory(anchor: unknown): PulseConcept['history'] {
  const data = object(anchor);
  if (!data || (data.kind !== 'recent-error' && data.kind !== 'prior-stable') ||
      typeof data.href !== 'string' || !data.href.startsWith('/materials/records/')) return;
  try {
    const url = new URL(data.href, location.origin);
    const ref = sourceRefV1(JSON.parse(url.searchParams.get('ref') ?? 'null'));
    if (url.origin === location.origin && ref && (ref.anchor.kind === 'question' || ref.anchor.kind === 'answer-slot') &&
        url.pathname === '/materials/records/' + ref.fact.id)
      return {kind: data.kind, href: url.pathname + url.search + url.hash};
  } catch { /* The host did not supply a reopenable fixed reference. */ }
  return undefined;
}

// Only a batch attached to this authorized current page can supply block identities.
export function pulseRows(page: Page, batch: unknown): PulseRows {
  const result: PulseRows = new Map();
  const value = object(batch);
  if (page.archived || typeof page.accessEpoch !== 'string' || !page.purpose?.some(p => p === 'teaching' || p === 'all') ||
      typeof value?.asOf !== 'string' || !Number.isFinite(Date.parse(value.asOf)) || !Array.isArray(value.blocks)) return result;
  const knownBlocks = new Set(page.blocks.map(block => block.id));
  for (const entry of value.blocks) {
    const block = object(entry), witness = object(block?.page);
    if (!block || witness?.id !== page.id || witness.rev !== page.rev || witness.accessEpoch !== page.accessEpoch ||
        typeof block.blockId !== 'string' || !knownBlocks.has(block.blockId) || !Array.isArray(block.concepts)) continue;
    const concepts: PulseConcept[] = [];
    for (const item of block.concepts) {
      const row = object(item);
      if (!row || typeof row.conceptId !== 'string' || !row.conceptId || typeof row.state !== 'string' ||
          !Object.hasOwn(pulseLabels, row.state) || (row.state === 'unknown' && row.reason !== 'no-independent-evidence')) continue;
      const history = row.state === 'unknown' ? undefined : fixedHistory(row.anchor);
      const candidate = row.state === 'unknown' ? undefined : object(row.candidate);
      const key = candidate && typeof candidate.key === 'string' ? candidate.key : undefined;
      concepts.push({conceptId:row.conceptId, state:row.state as PulseConcept['state'], ...(history && {history}),
        ...(key && page.id ? {candidate: {key, issue: requestId =>
          api(`/textbooks/${encodeURIComponent(page.id)}/pulse/questions`, {method: 'POST', body: {requestId, key}})}} : {})});
    }
    result.set(block.blockId, concepts);
  }
  return result;
}
