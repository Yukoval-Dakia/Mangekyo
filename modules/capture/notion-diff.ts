export type NotionBlockPosition = { readonly id: string; readonly parentId?: string | null };
export type NotionHashedBlock = NotionBlockPosition & { readonly contentHash: string };

export type NotionBlockDiff = {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly edited: readonly string[];
  readonly moved: readonly string[];
};

// Keep the longest subsequence of siblings already in the correct order. An
// insertion or removal then cannot be mistaken for a move of its neighbors.
function retainedOrder(ids: readonly string[], previousIndex: ReadonlyMap<string, number>): Set<string> {
  const tails: { id: string; index: number }[] = [];
  const predecessor = new Map<string, string>();
  for (const id of ids) {
    const index = previousIndex.get(id)!;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tails[middle]!.index < index) low = middle + 1;
      else high = middle;
    }
    if (low > 0) predecessor.set(id, tails[low - 1]!.id);
    tails[low] = { id, index };
  }
  const retained = new Set<string>();
  for (let id = tails.at(-1)?.id; id !== undefined; id = predecessor.get(id)) retained.add(id);
  return retained;
}

export function diffNotionBlocks(
  previous: readonly NotionHashedBlock[],
  next: readonly NotionHashedBlock[],
): NotionBlockDiff {
  const before = new Map(previous.map(block => [block.id, block]));
  const after = new Set(next.map(block => block.id));
  const previousIndex = new Map(previous.map((block, index) => [block.id, index]));
  const added: string[] = [];
  const edited: string[] = [];
  const moved = new Set<string>();
  const siblings = new Map<string | null, string[]>();
  for (const block of next) {
    const old = before.get(block.id);
    if (!old) {
      added.push(block.id);
      continue;
    }
    if (old.contentHash !== block.contentHash) edited.push(block.id);
    const parent = block.parentId ?? null;
    if ((old.parentId ?? null) !== parent) {
      moved.add(block.id);
      continue;
    }
    const sameParent = siblings.get(parent);
    if (sameParent) sameParent.push(block.id);
    else siblings.set(parent, [block.id]);
  }
  for (const ids of siblings.values()) {
    const retained = retainedOrder(ids, previousIndex);
    for (const id of ids) if (!retained.has(id)) moved.add(id);
  }
  return {
    added,
    removed: previous.filter(block => !after.has(block.id)).map(block => block.id),
    edited,
    moved: next.filter(block => moved.has(block.id)).map(block => block.id),
  };
}
