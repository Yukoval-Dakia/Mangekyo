import type { FactId, ReadContext, Revision } from '@mangekyo/kernel';
import { isPurposeWidenedContinuation } from '@mangekyo/module-content/facts/asset-contract';

/** Confirms `rev` widens monotonically to `target` on `id` — same data each hop with strictly
 * widening purpose and no skipped rev. Returns `target` when reachable within the current chain;
 * `undefined` on any content edit, narrowing, missing rev, or unavailable read. Caller decides
 * whether `target` is a live rev — an older `target` buried inside a longer widening chain is
 * still accepted so historical links stay paired. */
export async function widenedRevOr(
  read: ReadContext, id: FactId, rev: Revision, target: Revision,
  unavailable: (error: unknown) => boolean,
): Promise<Revision | undefined> {
  try {
    const pinned = await read.fact(id, { mode: 'pinned', rev });
    const current = await read.fact(id, { mode: 'following' });
    if (current.ref.rev < target) return undefined;
    const expectedEpoch = String(BigInt(pinned.accessEpoch) - BigInt(current.ref.rev - rev));
    return (await isPurposeWidenedContinuation(read, pinned, expectedEpoch)) ? target : undefined;
  } catch (error) {
    if (unavailable(error)) return undefined;
    throw error;
  }
}
