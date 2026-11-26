import type { FactId } from '@mangekyo/kernel';

export const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
export function purposeAllowed(purpose: readonly string[] | undefined, requiredPurpose: string | undefined): boolean {
  const needed = requiredPurpose?.trim();
  if (!needed) return true;
  if (!purpose?.length) return false;
  return purpose.some(entry => { const v = entry.trim(); return v === needed || v === 'all'; });
}
export function addSetValue<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let bucket = map.get(key);
  if (!bucket) map.set(key, bucket = new Set());
  bucket.add(value);
}
export function pushMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  let bucket = map.get(key);
  if (!bucket) map.set(key, bucket = []);
  bucket.push(value);
}
export function indexLatestById<T extends { readonly id: FactId }>(items: readonly T[] | undefined): Map<FactId, T> {
  const map = new Map<FactId, T>();
  for (const item of items ?? []) map.set(item.id, item);
  return map;
}
export function parseIsoMs(iso: string, label: string): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 不是合法的 ISO 时间戳。`);
  return parsed;
}
export const parseOptionalIsoMs = (iso: string | undefined): number | null => {
  const parsed = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
export function entityRedirectTarget(
  entity: { readonly merged_into?: FactId | null; readonly mergedInto?: FactId | null },
): FactId | null {
  if (entity.merged_into != null && entity.mergedInto != null && entity.merged_into !== entity.mergedInto) {
    throw new Error('规范实体的合并目标不一致。');
  }
  return entity.merged_into ?? entity.mergedInto ?? null;
}
