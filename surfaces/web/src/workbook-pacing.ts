// Each page writes its own clock, so blur/pagehide in one tab cannot overwrite another tab.
import {requestId} from './api';

export type ItemPacing = {version: 1; items: {
  questionId: string; effectiveDurationMs: number; skipped: boolean; returned: boolean;
}[]};
export type PaperTiming = {effectiveDurationMs?: number; pacing?: ItemPacing};
export const limitMs = 86_400_000;
let writer: string | undefined;

function prefix(paperId: string, sitting: string) {
  return 'mangekyo:workbook:pacing:' + paperId + ':' + sitting + ':';
}
function keysStartingWith(start: string) {
  return Object.keys(localStorage).filter(key => key.startsWith(start));
}
export function clearWorkbookTiming(paperId: string, sitting: string) {
  for (const key of keysStartingWith(prefix(paperId, sitting))) localStorage.removeItem(key);
}
export function workbookTimingParts(paperId: string, sitting: string) {
  const start = prefix(paperId, sitting);
  const clocks = start + 'clock:';
  writer ??= requestId();
  return {
    clockKey: clocks + writer,
    skip(id: string) { localStorage.setItem(start + 'skip:' + id, '1'); },
    revisit(id: string) {
      if (localStorage.getItem(start + 'skip:' + id) === '1') localStorage.setItem(start + 'return:' + id, '1');
    },
    snapshot(itemIds: readonly string[]): PaperTiming {
      let total = 0;
      const durations = new Map<string, number>();
      for (const key of keysStartingWith(clocks)) {
        const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (!saved || saved.requestId !== sitting || !Number.isSafeInteger(saved.elapsed) || saved.elapsed < 0 ||
            saved.elapsed > limitMs || !saved.items || typeof saved.items !== 'object' || Array.isArray(saved.items))
          throw new Error('无法核对本机卷面计时。');
        total += saved.elapsed;
        for (const [id, ms] of Object.entries(saved.items)) {
          if (!itemIds.includes(id) || typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0 || ms > limitMs)
            throw new Error('无法核对本机逐题计时。');
          durations.set(id, (durations.get(id) ?? 0) + ms);
        }
      }
      const items: ItemPacing['items'] = [];
      for (const questionId of itemIds) {
        const skipped = localStorage.getItem(start + 'skip:' + questionId) === '1';
        const ms = durations.get(questionId);
        if (ms === undefined) continue;
        items.push({questionId, effectiveDurationMs: ms, skipped,
          returned: skipped && localStorage.getItem(start + 'return:' + questionId) === '1'});
      }
      const effectiveDurationMs = Math.min(limitMs, total);
      // Beyond the wire limits, retain the whole-paper clock without manufacturing item durations.
      if (!items.length || items.length > 100 || items.reduce((sum, row) => sum + row.effectiveDurationMs, 0) > effectiveDurationMs)
        return effectiveDurationMs ? {effectiveDurationMs} : {};
      return {effectiveDurationMs, pacing: {version: 1, items}};
    },
  };
}
