import type { Json, JsonObject } from '@mangekyo/kernel';
import type { AnswerSlot } from './assessment-values.ts';

function object(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Project the choices a learner can enter, without copying view state, arbitrary text blocks or grading data. */
export function publicAnswerControls(view: JsonObject, prompt: string, slots: readonly AnswerSlot[]): JsonObject | undefined {
  if (view.version !== 1 || view.fallback !== prompt || view.interaction !== undefined || !Array.isArray(view.sections)) {
    return undefined;
  }
  const expected = new Map(slots.map(slot => [slot.slotId, slot]));
  const controls: JsonObject[] = [];
  const inputs = new Set<string>();
  let submission: readonly Json[] | undefined;
  for (const section of view.sections) {
    if (!object(section) || !Array.isArray(section.nodes)) return undefined;
    for (const node of section.nodes) {
      if (!object(node) || typeof node.id !== 'string') return undefined;
      if (node.kind === 'action') {
        if (node.intent !== 'submit' || submission || !Array.isArray(node.inputs)) return undefined;
        submission = node.inputs;
        continue;
      }
      if (node.kind === 'listen') {
        if (!Array.isArray(node.lanes) || !node.lanes.every(id => typeof id === 'string' && expected.has(id)) ||
          typeof node.bpm !== 'number' || node.bpm < 40 || node.bpm > 200) return undefined;
        controls.push({ kind: 'listen', lanes: node.lanes, bpm: node.bpm });
        continue;
      }
      const slot = expected.get(node.id);
      if (!slot || inputs.has(node.id) || typeof node.label !== 'string') return undefined;
      inputs.add(node.id);
      if (node.kind === 'note' && slot.fields.some(field => field.path === '' && field.kind === 'text')) {
        controls.push({ kind: 'note', id: node.id, label: node.label });
        continue;
      }
      if (node.kind !== 'selection' || !slot.fields.some(field => field.path === '' && field.kind === 'structured') ||
        !Array.isArray(node.items) || !node.items.length || !Array.isArray(node.selected) || node.selected.length ||
        (node.layout !== 'beats' && node.layout !== 'passage') || typeof node.tail !== 'string') return undefined;
      const items: JsonObject[] = [];
      const ids = new Set<string>();
      for (const item of node.items) {
        if (!object(item) || typeof item.id !== 'string' || typeof item.label !== 'string' || ids.has(item.id)) return undefined;
        ids.add(item.id);
        items.push({ id: item.id, label: item.label });
      }
      controls.push({ kind: 'selection', id: node.id, label: node.label, layout: node.layout, items, tail: node.tail });
    }
  }
  if (inputs.size !== expected.size || !submission || submission.length !== inputs.size ||
    ![...inputs].every(id => submission.includes(id))) return undefined;
  return { controls };
}
