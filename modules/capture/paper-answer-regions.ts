import type { Block } from './source.ts';

type Box = NonNullable<Block['body']['crop_ref']>['bbox'];

function relation(candidate: Block, edit: Block) {
  const a = candidate.body.crop_ref!.bbox;
  const b = edit.body.crop_ref!.bbox;
  if (a.every((edge, i) => edge === b[i])) return 'exact';
  const sameId = candidate.id === edit.id;
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (width <= 0 || height <= 0) return sameId ? 'possible' : 'separate';
  const intersection = width * height;
  const area = (box: Box) => (box[2] - box[0]) * (box[3] - box[1]);
  const first = area(a), second = area(b);
  // A stable ID corroborates translation on a narrow line when at least half
  // of each box is still shared. Renamed lines need a tighter geometric match.
  if (intersection >= 0.8 * (first + second - intersection) ||
      (sameId && intersection >= 0.5 * Math.max(first, second))) return 'close';
  // A contained fragment can be a split or join even with very different areas.
  return !sameId && intersection < 0.5 * Math.min(first, second) ? 'fringe' : 'possible';
}

function scope({ body }: Block) {
  const { original, page } = body.crop_ref!;
  return JSON.stringify([original, page, body.itemId, body.slotId]);
}

/** Both inputs belong to one authorized source and one collection run. */
export function reconcileAnswerRegions(extracted: readonly Block[], edits: readonly Block[]): readonly Block[] {
  if (!edits.length) return extracted;
  const byScope = Map.groupBy(extracted, scope);
  const matches = new Map<Block, { count: number; exact: boolean; unique: boolean }>();
  for (const edit of edits) {
    const nearby = (byScope.get(scope(edit)) ?? []).map(block => ({ block, kind: relation(block, edit) }))
      .filter(match => match.kind !== 'separate');
    const anchored = nearby.some(({ kind }) => kind === 'exact' || kind === 'close');
    // Once the edited line has a geometric anchor, a neighbor touching only its
    // fringe is independent. Without that anchor, leave such a guess for review.
    const candidates = nearby.filter(({ kind }) => !anchored || kind !== 'fringe');
    for (const { block, kind } of candidates) {
      const match = matches.get(block) ?? { count: 0, exact: false, unique: false };
      match.count++;
      match.exact ||= kind === 'exact';
      match.unique ||= kind === 'close' && candidates.length === 1;
      matches.set(block, match);
    }
  }

  const result = [...edits];
  for (const block of extracted) {
    const match = matches.get(block);
    if (match?.exact || (match?.count === 1 && match.unique)) continue;
    if (!match || block.body.status === 'unknown') {
      result.push(block);
      continue;
    }
    // Keep the OCR region addressable for clarification without emitting its
    // suggestion as a confirmed answer or copying it into the original.
    const { layer, crop_ref, itemId, slotId, text } = block.body;
    result.push({ ...block, body: { kind: 'capture', layer, crop_ref: crop_ref!, itemId: itemId!, slotId: slotId!,
      status: 'unknown', clarification: 'pending', candidates: text.length <= 500 && text.trim() ? [text] : [] } });
  }
  return result;
}
