import { factId, type CommandContext, type FactSnapshot, type LearnerId, type Revision } from '@mangekyo/kernel';
import { captureSourceType, sourceEnvelope, type SourceEnvelope } from './source.ts';
import { notionConfirmPageAccess, NotionSourceUnavailable, type NotionReadRequest, type NotionReadResponse, type NotionRoot } from './notion-api.ts';
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

export type NotionSelectionWitness = {
  readonly learner: LearnerId;
  readonly selectionId: string;
  readonly selectionEpoch: string;
};

function sameNotionSelection(left: NotionSelectionWitness, right: NotionSelectionWitness) {
  return left.learner === right.learner && left.selectionId === right.selectionId && left.selectionEpoch === right.selectionEpoch;
}

export function notionSourceInvalidation(error: unknown, dispatched: NotionSelectionWitness, current: NotionSelectionWitness | null) {
  if (!(error instanceof NotionSourceUnavailable) || !error.invalidated || !current ||
      !sameNotionSelection(dispatched, current)) return null;
  const { learner, selectionId, selectionEpoch } = dispatched;
  return { selection: { learner, selectionId, selectionEpoch }, target: error.invalidated };
}

export type NotionBoundedUse = {
  readonly preset: 'turn-only' | 'temporary';
  readonly selection: NotionSelectionWitness & { readonly root: NotionRoot };
  readonly pageId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly authorizationEpoch: string;
  readonly recipient:
    | { readonly purpose: 'turn-answer'; readonly id: string }
    | { readonly purpose: 'turn-tool'; readonly id: string };
  readonly authorizedAt: string;
  readonly expiresAt: string;
};

const maximumTemporaryWindow = 24 * 60 * 60 * 1_000;
const generation = /^(?:0|[1-9][0-9]*)$/;

// Resolve 'current' through the host's live authorization for this action,
// actual recipient, provider retention policy, open turn and selected page.
// A closed turn, unavailable grant or unknown provider policy yields null.
export function notionBoundedUseAllowed(expected: NotionBoundedUse, current: NotionBoundedUse | null, now: string): boolean {
  if (!current || (expected.preset !== 'turn-only' && expected.preset !== 'temporary') ||
      (expected.recipient.purpose !== 'turn-answer' && expected.recipient.purpose !== 'turn-tool') ||
      (expected.selection.root.kind !== 'page' && expected.selection.root.kind !== 'data-source') ||
      !expected.recipient.id || !expected.conversationId || !expected.turnId ||
      !generation.test(expected.selection.selectionEpoch) || !generation.test(expected.authorizationEpoch)) return false;
  const rootId = notionId(expected.selection.root.id);
  const pageId = notionId(expected.pageId);
  const authorized = Date.parse(notionTimestamp(expected.authorizedAt));
  const expires = Date.parse(notionTimestamp(expected.expiresAt));
  const checked = Date.parse(notionTimestamp(now));
  return checked >= authorized && checked < expires &&
    (expected.preset !== 'temporary' || expires - authorized <= maximumTemporaryWindow) &&
    (expected.selection.root.kind === 'data-source' || rootId === pageId) &&
    expected.preset === current.preset && expected.selection.learner === current.selection.learner &&
    notionSelectionId(expected.selection.selectionId) === current.selection.selectionId &&
    expected.selection.root.kind === current.selection.root.kind && rootId === notionId(current.selection.root.id) &&
    expected.selection.selectionEpoch === current.selection.selectionEpoch && pageId === notionId(current.pageId) &&
    expected.conversationId === current.conversationId && expected.turnId === current.turnId &&
    expected.authorizationEpoch === current.authorizationEpoch &&
    expected.recipient.purpose === current.recipient.purpose && expected.recipient.id === current.recipient.id &&
    authorized === Date.parse(notionTimestamp(current.authorizedAt)) && expires === Date.parse(notionTimestamp(current.expiresAt));
}

export type NotionBoundedSnapshot = {
  readonly use: NotionBoundedUse;
  readonly projection: {
    readonly title: string;
    readonly blocks: readonly { readonly id: string; readonly parentId: string | null; readonly text: string }[];
  };
};

// Page must come from the complete, authorized Notion page read for this
// dispatch. Use the check again at the actual egress boundary after recovery.
export async function prepareNotionBoundedSnapshot(
  use: NotionBoundedUse, current: NotionBoundedUse | null, page: unknown, now: string,
): Promise<NotionBoundedSnapshot> {
  const witness = structuredClone(use);
  if (!notionBoundedUseAllowed(witness, current, now)) throw new Error('Notion 本轮授权无效。');
  const { externalId, unit } = await notionSourceProjection(page);
  if (externalId !== notionId(witness.pageId)) throw new Error('Notion 本轮页面授权不匹配。');
  return { use: witness, projection: { title: unit.title, blocks: unit.blocks.map(({ id, parentId, body }) => ({
    id, parentId, text: body.text,
  })) } };
}

export function openNotionBoundedSnapshot(snapshot: NotionBoundedSnapshot, current: NotionBoundedUse | null, now: string) {
  if (!notionBoundedUseAllowed(snapshot.use, current, now)) throw new Error('Notion 本轮授权无效。');
  return snapshot.projection;
}

// Drive immediately before each outbound use, including recovered cache. The
// host binds the transport to this dispatch, re-resolves the live grant and
// clock after the GET, and sends only the resulting projection. A failed check
// stops this send. Apply confirmed invalidation with the dispatch witness only.
export async function* notionBoundedSnapshotForSend(
  snapshot: NotionBoundedSnapshot,
  resolveCurrent: () => Promise<{ readonly use: NotionBoundedUse | null; readonly now: string }>,
): AsyncGenerator<NotionReadRequest, NotionBoundedSnapshot['projection'], NotionReadResponse> {
  yield* notionConfirmPageAccess(snapshot.use.selection.root, snapshot.use.pageId);
  const { use, now } = await resolveCurrent();
  return openNotionBoundedSnapshot(snapshot, use, now);
}

export type NotionBoundedHandle = { readonly id: string };
export type NotionBoundedEnd = 'completed' | 'cancelled' | 'expired' | 'source-revoked' | 'turn-revoked';

// Implemented by the shared lifecycle host. Handles are random, content-free
// references. Recovery for temporary use requires an independent encryption key
// and an immutable expiry. On close, block use first, then destroy the key and
// online copies. Only turn-only permits the separate learner-visible transcript
// in the original conversation, outside future context and retrieval.
export type NotionBoundedLifecycle = {
  seal(snapshot: NotionBoundedSnapshot): Promise<NotionBoundedHandle>;
  open(handle: NotionBoundedHandle, current: NotionBoundedUse, now: string): Promise<NotionBoundedSnapshot['projection']>;
  close(handle: NotionBoundedHandle, reason: NotionBoundedEnd): Promise<void>;
};

// Apply with the host's live generation and immutable bindings for its open
// handles. Close fences each handle before destruction. A replacement grant
// has a separate generation and its handles are outside this operation.
export async function applyNotionSourceInvalidation(
  error: unknown, dispatched: NotionSelectionWitness, current: NotionSelectionWitness | null,
  handles: readonly { readonly handle: NotionBoundedHandle; readonly use: Pick<NotionBoundedUse, 'selection' | 'pageId'> }[],
  lifecycle: Pick<NotionBoundedLifecycle, 'close'>,
) {
  const invalidation = notionSourceInvalidation(error, dispatched, current);
  if (!invalidation) return null;
  const { selection, target } = invalidation;
  const affected = handles.filter(({ use }) => sameNotionSelection(selection, use.selection) &&
    (target.kind === 'selection' || notionId(use.pageId) === target.pageId));
  await Promise.all(affected.map(({ handle }) => lifecycle.close(handle, 'source-revoked')));
  return invalidation;
}

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
