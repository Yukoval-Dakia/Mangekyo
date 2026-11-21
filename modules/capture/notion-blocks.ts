import type { FactSnapshot, Revision } from '@mangekyo/kernel';
import { openSelectedNotionSource, type SelectedNotionAccess } from './notion-source.ts';
import { changedNotionBlocks, notionRevisionDiff } from './notion-diff.ts';
import { captureRef } from './parse.ts';
import { notionEpoch } from './notion-selection.ts';
import { notionId, notionRecord } from './notion-values.ts';
import { captureSourceType, sourceEnvelope, type SourceEnvelope } from './source.ts';

export type NotionBlockWitness = ReturnType<typeof notionBlockWitness>;
export type NotionBlockPurpose = 'learning' | 'teaching' | 'background-research';

export function isNotionBlockPurpose(purpose: string): purpose is NotionBlockPurpose {
  return purpose === 'learning' || purpose === 'teaching' || purpose === 'background-research';
}

export function notionBlockWitness(input: unknown) {
  const row = notionRecord(input);
  return { ...captureRef(row), accessEpoch: notionEpoch(row.accessEpoch), blockId: notionId(row.blockId) };
}

function witness(snapshot: FactSnapshot, blockId: string) {
  return { id: snapshot.ref.id, rev: snapshot.ref.rev, accessEpoch: snapshot.accessEpoch, blockId };
}

function notionSource(fact: FactSnapshot | null) {
  if (fact?.type !== captureSourceType) return null;
  const source = sourceEnvelope(fact.value);
  return source.kind === 'notion' ? source : null;
}

function isRetractedSource(fact: FactSnapshot | null): boolean {
  return Boolean(fact && fact.type === captureSourceType && fact.value == null);
}

/** Project one committed source change, within the source command transaction.
 * Selection/recipient access is checked separately by the host for its actual recipient.
 * Retire by source ID and block ID. The prior snapshot may be newer than a live edge's original pin.
 */
export function planNotionBlockWork(
  previous: FactSnapshot | null, current: FactSnapshot | null, purpose: NotionBlockPurpose,
): { readonly rebuild: readonly NotionBlockWitness[]; readonly retire: readonly NotionBlockWitness[] } {
  if (!isNotionBlockPurpose(purpose)) throw new Error('Notion 块处理用途无效。');
  if (isRetractedSource(previous)) throw new Error('Notion 块计划需要同一原件的连续修订。');
  const before = notionSource(previous);
  // A retracted head revision stores no envelope: validate continuity with `previous`,
  // then clear the current block set so every previously eligible block retires.
  if (isRetractedSource(current)) {
    if (previous && (previous.ref.learner !== current!.ref.learner ||
        previous.ref.id !== current!.ref.id || current!.ref.rev !== previous.ref.rev + 1)) {
      throw new Error('Notion 块计划需要同一原件的连续修订。');
    }
    const oldEligible = Boolean(before && previous?.purpose.includes(purpose));
    return { rebuild: [], retire: (oldEligible ? before!.unit.blocks : [])
      .map(({ id }) => witness(previous!, id)) };
  }
  const after = notionSource(current);
  if (!before && !after) return { rebuild: [], retire: [] };
  if (previous && current && (previous.ref.learner !== current.ref.learner ||
      previous.ref.id !== current.ref.id || current.ref.rev !== previous.ref.rev + 1 ||
      before?.sourceSelectionId !== after?.sourceSelectionId || before?.sourceSelectionEpoch !== after?.sourceSelectionEpoch ||
      before?.externalId !== after?.externalId)) throw new Error('Notion 块计划需要同一原件的连续修订。');
  const oldEligible = Boolean(before && previous?.purpose.includes(purpose));
  const newEligible = Boolean(after && current?.purpose.includes(purpose));
  const beforeBlocks = oldEligible ? before!.unit.blocks : [];
  const afterBlocks = newEligible ? after!.unit.blocks : [];
  const accessChanged = previous?.accessEpoch !== current?.accessEpoch;
  const diff = oldEligible && newEligible ? notionRevisionDiff(before!, after!) : null;
  const changed = diff && changedNotionBlocks(diff);
  const removed = new Set(diff?.removed);
  return {
    rebuild: afterBlocks.filter(({ id }) => !changed || accessChanged || changed.has(id))
      .map(({ id }) => witness(current!, id)),
    retire: beforeBlocks.filter(({ id }) => !newEligible || accessChanged || removed.has(id) || changed?.has(id))
      .map(({ id }) => witness(previous!, id)),
  };
}

function atBlock(source: SourceEnvelope, blockId: string) {
  const block = source.unit.blocks.find(({ id }) => id === blockId);
  if (!block || block.body.status !== 'known' || !block.body.contentHash) throw new Error('Notion 块不可用或已移除。');
  return { id: block.id, parentId: block.parentId, contentHash: block.body.contentHash, text: block.body.text };
}

async function readBlockSource(access: SelectedNotionAccess, ref: NotionBlockWitness, rev = ref.rev) {
  const fact = await openSelectedNotionSource(access, ref.id, { mode: 'pinned', rev });
  if (fact.accessEpoch !== ref.accessEpoch) throw new Error('Notion 块访问代次已变更。');
  return sourceEnvelope(fact.value);
}

/** Historical mode preserves the exact block version, subject to live authorization. */
export async function openPinnedNotionBlock(access: SelectedNotionAccess, ref: NotionBlockWitness) {
  return atBlock(await readBlockSource(access, ref), ref.blockId);
}

/** Reopen an existing slice/edge basis for current use. Legacy source revisions
 * have no per-block stamp, so compare the intervening transitions to catch ABA.
 */
export async function openCurrentNotionBlock(access: SelectedNotionAccess, ref: NotionBlockWitness) {
  const current = await openSelectedNotionSource(access, ref.id, { mode: 'following' });
  if (current.accessEpoch !== ref.accessEpoch || ref.rev > current.ref.rev) throw new Error('Notion 块访问代次或版本已变更。');
  const source = sourceEnvelope(current.value);
  const block = atBlock(source, ref.blockId);
  const stamp = source.notionBlockRevisions?.[ref.blockId] ?? current.ref.rev;
  if (stamp > current.ref.rev) throw new Error('Notion 块版本见证无效。');
  const pinned = ref.rev === current.ref.rev ? source : await readBlockSource(access, ref);
  const old = atBlock(pinned, ref.blockId);
  if (block.contentHash !== old.contentHash || block.parentId !== old.parentId) throw new Error('Notion 块已变更。');
  if (stamp > ref.rev) {
    let newer = stamp === current.ref.rev ? source : await readBlockSource(access, ref, stamp as Revision);
    if (newer.notionBlockRevisions) throw new Error('Notion 块已变更。');
    for (let rev = stamp - 1; rev >= ref.rev; rev--) {
      const older = rev === ref.rev ? pinned : await readBlockSource(access, ref, rev as Revision);
      const diff = notionRevisionDiff(older, newer);
      if (changedNotionBlocks(diff).has(ref.blockId) || diff.removed.includes(ref.blockId)) throw new Error('Notion 块已变更。');
      newer = older;
    }
  }
  return block;
}
