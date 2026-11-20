import { factId, type CommandContext, type FactSnapshot, type LearnerId, type Revision } from '@mangekyo/kernel';
import { captureSourceType, sourceEnvelope, type SourceEnvelope } from './source.ts';
import type { NotionRoot } from './notion-api.ts';
import { diffNotionBlocks } from './notion-diff.ts';
import { notionId, notionRecord, notionSelectionId, notionSourceId, notionSourceProjection, notionTimestamp } from './notion-values.ts';

export const refreshNotionSourceCommand = 'capture.refreshNotionSource';
export const revokeNotionSourceCommand = 'capture.revokeNotionSource';
export const setNotionPurposeCommand = 'capture.setNotionPurpose';

export type NotionRetainedPreset = 'storage' | 'learning';
export type NotionPreset = NotionRetainedPreset | 'turn-only' | 'temporary';

// Scope of a retained capture. The bounded presets require the host's
// controlled turn or temporary lifecycle and must never reach this writer.
export function notionRetainedPurposes(preset: NotionPreset = 'storage'): readonly string[] {
  switch (preset) {
    case 'storage': return ['storage'];
    case 'learning': return ['storage', 'learning', 'teaching', 'background-research'];
    default: throw new Error('该 Notion 用途不能保存为长期原件。');
  }
}

export type NotionSelection = {
  readonly id: string;
  readonly learner: LearnerId;
  readonly root: NotionRoot;
  readonly preset: NotionPreset;
};

export type NotionRecipient = 'learner' | 'workspace';

export function notionRecipientAllowed(selection: NotionSelection, purpose: string, recipient: NotionRecipient) {
  if (selection.preset !== 'storage' && selection.preset !== 'learning') return false;
  if (recipient === 'learner') return purpose === 'storage';
  return purpose !== 'storage' && notionRetainedPurposes(selection.preset).includes(purpose);
}

// Compose with the kernel's authorized fact reader, which independently
// verifies current and pinned-revision purposes and the access witness.
export function notionSourceRecipient(selection: NotionSelection | null, purpose: string, recipient: NotionRecipient) {
  return (fact: FactSnapshot): boolean => {
    if (!selection || fact.type !== captureSourceType || fact.ref.learner !== selection.learner ||
        !notionRecipientAllowed(selection, purpose, recipient)) return false;
    const source = sourceEnvelope(fact.value);
    return source.kind === 'notion' && source.sourceSelectionId === selection.id &&
      (selection.root.kind === 'data-source' || source.externalId === notionId(selection.root.id));
  };
}

export async function prepareNotionIngest(selection: NotionSelection, page: unknown, recordedAt: string) {
  const purpose = notionRetainedPurposes(selection.preset);
  const envelope = await prepareNotionRevision(selection, page, recordedAt);
  const id = await notionSourceId(selection.learner, selection.id, envelope.externalId);
  return { id, envelope, purpose };
}

export async function prepareNotionRevision(selection: NotionSelection, page: unknown, recordedAt: string) {
  notionRetainedPurposes(selection.preset);
  const projection = await notionSourceProjection(page);
  if (selection.root.kind === 'page' && projection.externalId !== notionId(selection.root.id)) {
    throw new Error('Notion 页面不在获准来源内。');
  }
  const envelope = {
    ...projection, kind: 'notion' as const, sourceSelectionId: notionSelectionId(selection.id),
    recordedAt: notionTimestamp(recordedAt), retentionPolicy: 'retained' as const, originals: [],
  };
  sourceEnvelope(envelope);
  return envelope;
}

export function notionSourceTarget(input: unknown) {
  const { id, expectedRev, accessEpoch, selectionId } = notionRecord(input);
  if (typeof id !== 'string' || typeof expectedRev !== 'number' || !Number.isSafeInteger(expectedRev) || expectedRev < 1 ||
      typeof accessEpoch !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(accessEpoch)) throw new Error('Notion 原件见证无效。');
  return { id: factId(id), expectedRev: expectedRev as Revision, accessEpoch, selectionId: notionSelectionId(selectionId) };
}

export async function readNotionSourceTarget(ctx: CommandContext, target: ReturnType<typeof notionSourceTarget>) {
  const current = await ctx.read.fact(target.id, { mode: 'following' });
  if (current.type !== captureSourceType || current.ref.rev !== target.expectedRev || current.accessEpoch !== target.accessEpoch) {
    throw new Error('Notion 原件版本或授权已变更。');
  }
  const source = sourceEnvelope(current.value);
  if (source.kind !== 'notion' || source.sourceSelectionId !== target.selectionId) throw new Error('Notion 授权来源已变更。');
  return { current, source };
}

export function notionRevisionDiff(previous: SourceEnvelope, next: SourceEnvelope) {
  const blocks = (source: SourceEnvelope) => source.unit.blocks.map(({ id, parentId, body }) => {
    if (source.kind !== 'notion' || !body.contentHash) throw new Error('Notion 原件块缺少内容哈希。');
    return { id, parentId, contentHash: body.contentHash };
  });
  return diffNotionBlocks(blocks(previous), blocks(next));
}
