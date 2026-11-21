import { factId, type FactId } from '@mangekyo/kernel';

export const learningPythonReadLabel = 'local:learning-python-v1';
export const questionScope = 'authorized_workbook_source_questions';
export const questionExposureReceiptVersion = 3;

export function questionNegativeRefs(results: readonly string[]) {
  const sources = new Set<FactId>();
  for (const result of results) {
    const packet = JSON.parse(result) as {
      values?: {scope?: string}[]; questionExposure?: number; questionNegatives?: string[];
    };
    if (!packet.values?.some(value => value?.scope === questionScope)) continue;
    if (!Array.isArray(packet.questionNegatives)) return;
    // Version 2 recorded filtered negatives, but used an unsound reply classifier.
    // Its receipts that made no negative claims retain their original authority.
    if (packet.questionExposure === 2 && packet.questionNegatives.length === 0) continue;
    if (packet.questionExposure !== questionExposureReceiptVersion) return;
    for (const id of packet.questionNegatives) sources.add(factId(id));
  }
  return sources;
}
