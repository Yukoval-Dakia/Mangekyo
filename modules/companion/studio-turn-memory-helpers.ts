// Pure helpers extracted from runtime/studio/turn-memory.ts.
// All IO stays in the runtime host; this module owns pure merging/shaping only.

// Merge [start, end] ranges into a sorted non-overlapping cover.
export function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const covered: [number, number][] = [];
  for (const range of sorted) {
    const last = covered.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else covered.push(range);
  }
  return covered;
}

// Locate the serialized `"claims":[...]` span inside a delivered tool output
// and return, for each claim, its [start, end] within `output` when the
// claim's position is fully covered by `covered` ranges.
export function findClaimSpans(
  output: string,
  claims: readonly unknown[],
  covered: readonly [number, number][],
): { item: unknown; start: number; end: number }[] {
  const key = '"claims":';
  const offset = output.indexOf(key + JSON.stringify(claims));
  if (offset < 0) return [];
  const spans: { item: unknown; start: number; end: number }[] = [];
  let position = offset + key.length + 1;
  for (const item of claims) {
    const limit = position + JSON.stringify(item).length;
    const isCovered = covered.some(([from, to]) => from <= position && limit <= to);
    if (isCovered) spans.push({ item, start: position, end: limit });
    position = limit + 1;
  }
  return spans;
}

// Match a serialized claim item back to a sent witness by id/rev/type.
export function matchClaimWitness<S extends { id: unknown; rev: unknown; type: string }>(
  sent: readonly S[],
  item: unknown,
  claimTypeValue: string,
  memoryAssertionTypeValue: string,
): S | undefined {
  if (!item || typeof item !== 'object' || !('id' in item) || !('rev' in item)) return;
  const id = (item as { id: unknown }).id;
  const rev = (item as { rev: unknown }).rev;
  return sent.find(
    ref =>
      (ref.type === claimTypeValue || ref.type === memoryAssertionTypeValue) &&
      ref.id === id &&
      ref.rev === rev,
  );
}

export function isMemoryConflictError(
  error: unknown,
  classifiers: {
    isClaimInput: (e: unknown) => boolean;
    isReadDenied: (e: unknown) => boolean;
    isNotFound: (e: unknown) => boolean;
  },
): boolean {
  return classifiers.isClaimInput(error) || classifiers.isReadDenied(error) || classifiers.isNotFound(error);
}
