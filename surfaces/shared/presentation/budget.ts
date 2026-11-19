import { isRecord } from './schema.ts';

// Count instances, including repeated uses of one asset. The resolver's byte
// ceiling and the number of slots together bound simultaneous blob URLs.
export const artifactLimits = {
  nodes: 128,
  objects: 512,
  points: 4096,
  values: 24576,
  textUnits: 131072,
  assets: 4,
  bytesPerAsset: 16 * 1024 * 1024,
} as const;

/** Preflight before schema expansion, cross-reference maps or DOM allocation. */
export function checkBudget(input: unknown): string | undefined {
  const used = { nodes: 0, objects: 0, points: 0, values: 0, textUnits: 0, assets: 0 };
  function charge(key: keyof typeof used, amount: number) {
    used[key] += amount;
    if (used[key] > artifactLimits[key]) return 'view exceeds ' + key + ' budget';
    return undefined;
  }
  function visit(v: unknown, key: string, depth: number): string | undefined {
    if (depth > 24) return 'view exceeds nesting budget';
    const limit = charge('values', 1);
    if (limit) return limit;
    if (typeof v === 'string') return charge('textUnits', v.length);
    if (Array.isArray(v)) {
      if (key === 'objects' || key === 'points' || key === 'nodes') {
        const error = charge(key, v.length);
        if (error) return error;
      }
      for (const child of v) {
        const error = visit(child, '', depth + 1);
        if (error) return error;
      }
    } else if (isRecord(v)) {
      if (v.kind === 'asset') {
        const error = charge('assets', 1);
        if (error) return error;
      }
      if (v.kind === 'curve' && Array.isArray(v.values)) {
        const error = charge('points', v.values.length);
        if (error) return error;
      }
      for (const field in v) {
        if (!Object.hasOwn(v, field)) continue;
        const error = charge('textUnits', field.length) || visit(v[field], field, depth + 1);
        if (error) return error;
      }
    }
    return undefined;
  }
  return visit(input, '', 0);
}
