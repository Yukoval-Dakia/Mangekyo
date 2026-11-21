import type { Json, JsonObject } from '@mangekyo/kernel';
import type { AssetReference } from './asset.ts';
import { jsonObject } from './question-effects.ts';

function isPublicCaptureLayer(body: JsonObject) {
  return body.kind === 'capture' && (body.layer === 'material' || body.layer === 'prompt');
}

export function projectPublicCaptureMaterial(value: Json, anchor: AssetReference['anchor']) {
  if (!jsonObject(value) || !jsonObject(value.unit) || !Array.isArray(value.unit.blocks) || anchor.kind === 'path') {
    return undefined;
  }
  const byId = new Map<string, JsonObject>();
  for (const block of value.unit.blocks) {
    if (!jsonObject(block) || typeof block.id !== 'string' || byId.has(block.id)) return undefined;
    byId.set(block.id, block);
  }
  const selected = anchor.kind === 'block' ? [byId.get(anchor.blockId)]
    : [...byId.values()].filter(block => jsonObject(block.body) && block.body.layer === 'material');
  const result = [];
  for (const block of selected) {
    if (!block || typeof block.id !== 'string' || !jsonObject(block.body) || !isPublicCaptureLayer(block.body) ||
        block.body.status !== 'known' || typeof block.body.text !== 'string' || !block.body.text.trim()) return undefined;
    const seen = new Set([block.id]);
    let parentId = block.parentId;
    while (parentId !== null) {
      if (typeof parentId !== 'string' || seen.has(parentId)) return undefined;
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent || !jsonObject(parent.body) || !isPublicCaptureLayer(parent.body) || parent.body.status !== 'known') return undefined;
      parentId = parent.parentId;
    }
    result.push({ blockId: block.id, text: block.body.text });
  }
  return result.length ? result : undefined;
}
