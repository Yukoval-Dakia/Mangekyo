import { factId, type CommandContext, type FactId, type FactSnapshot, type LearnerId, type Revision } from '@mangekyo/kernel';
import { captureSourceType, sourceEnvelope, type SourceEnvelope } from './source.ts';
import { notionConfirmPageAccess, notionReadPage, notionReadRows, NotionSourceChanged, NotionSourceUnavailable, NotionTemporaryFailure, type NotionReadRequest, type NotionReadResponse, type NotionRoot, type NotionSelectionWitness } from './notion-api.ts';
import { notionRevisionDiff } from './notion-diff.ts';
import { notionId, notionRecord, notionSelectionId, notionSourceId, notionSourceProjection, notionTimestamp, type NotionCursor } from './notion-values.ts';
import { notionRetainedPurposes, notionSelectionWitness, notionRoot, readNotionSelection, selectionAllows,
  type NotionFactReader, type NotionReadOptions, type NotionSelection } from './notion-selection.ts';

export { openCurrentNotionBlock, openPinnedNotionBlock, planNotionBlockWork, notionBlockWitness,
  type NotionBlockWitness, type NotionBlockPurpose } from './notion-blocks.ts';
export { consumeNotionBlockLink, notionBlockDeriver, notionBlockSlot, notionBlockWorkKey, notionBlockLinkEffect,
  verifyNotionBlockEdges } from './notion-block-work.ts';
export { notionRetainedPurposes, planNotionSelectionInvalidation, selectionAllows as notionRecipientAllowed } from './notion-selection.ts';
export type { NotionPreset, NotionRetainedPreset, NotionSelection, NotionSelectionInvalidation,
  NotionSelectionUseRetraction } from './notion-selection.ts';

export const refreshNotionSourceCommand = 'capture.refreshNotionSource';
export const revokeNotionSourceCommand = 'capture.revokeNotionSource';
export const setNotionPurposeCommand = 'capture.setNotionPurpose';

export type { NotionSelectionWitness } from './notion-api.ts';

function checkNotionPageDispatch(page: unknown, selection: NotionSelectionWitness & { root: NotionRoot }) {
  const row = notionRecord(page);
  const root = notionRoot(row.root);
  const witness = notionRecord(row.dispatch);
  if (witness.learner !== selection.learner || witness.selectionId !== selection.selectionId ||
      witness.selectionEpoch !== selection.selectionEpoch || root.kind !== selection.root.kind ||
      root.id !== selection.root.id) throw new Error('Notion 拉取见证已变更。');
}

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
  checkNotionPageDispatch(page, witness.selection);
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
  const dispatch = await resolveCurrent();
  if (!notionBoundedUseAllowed(snapshot.use, dispatch.use, dispatch.now)) throw new Error('Notion 本轮授权无效。');
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

function matchesRoot(selection: NotionSelection, source: SourceEnvelope) {
  return selection.active && source.kind === 'notion' && source.sourceSelectionId === selection.id &&
    source.sourceRoot?.kind === selection.root.kind &&
    source.sourceRoot.id === selection.root.id && (selection.root.kind === 'data-source' || source.externalId === selection.root.id);
}

export function notionSourceRecipient(selection: NotionSelection | null, purpose: string, recipientId: string) {
  return (fact: FactSnapshot): boolean => {
    if (!selection || fact.type !== captureSourceType || fact.ref.learner !== selection.learner ||
        !selectionAllows(selection, purpose, recipientId)) return false;
    const source = sourceEnvelope(fact.value);
    if (!matchesRoot(selection, source) || !source.sourceSelectionEpoch) return false;
    const use = selection.continuity?.find(entry => entry.id === recipientId && entry.purpose === purpose);
    if (!use) return false;
    const origin = BigInt(source.sourceSelectionEpoch);
    return origin >= BigInt(use.sinceEpoch) && origin <= BigInt(selection.selectionEpoch);
  };
}

export type SelectedNotionAccess = {
  readonly selectionRead: NotionFactReader;
  readonly sourceRead: NotionFactReader;
  readonly learner: LearnerId;
  readonly purpose: string;
  readonly recipientId: string;
  readonly checkSelection?: (selection: NotionSelection, source: SourceEnvelope) => Promise<void>;
};

export class NotionSelectionUnavailable extends Error {
  constructor() { super('Notion 选源不可用。'); }
}

/** Both readers belong to the same snapshot. sourceRead also applies current and pinned fact purposes. */
export async function openSelectedNotionSource(access: SelectedNotionAccess, id: FactId, options: NotionReadOptions) {
  const requested = await access.sourceRead.fact(id, options);
  return authorizeNotionRead(access, id, options, requested);
}

async function authorizeNotionRead(
  access: SelectedNotionAccess, id: FactId, options: NotionReadOptions, requested: FactSnapshot,
) {
  const current = options.mode === 'following' ? requested : await access.sourceRead.fact(id, { mode: 'following' });
  if (current.type !== captureSourceType || current.ref.learner !== access.learner || current.ref.id !== id)
    throw new NotionSelectionUnavailable();
  const source = sourceEnvelope(current.value);
  if (source.kind !== 'notion' || !source.sourceSelectionId) throw new NotionSelectionUnavailable();
  const selection = await readNotionSelection(access.selectionRead, access.learner, source.sourceSelectionId);
  const allowed = notionSourceRecipient(selection, access.purpose, access.recipientId);
  const check = (fact: FactSnapshot) => fact.ref.id === id && fact.purpose.includes(access.purpose) && allowed(fact);
  if (!selection || !check(current) || (options.mode === 'pinned' && (requested.ref.rev !== options.rev || !check(requested))))
    throw new NotionSelectionUnavailable();
  await access.checkSelection?.(selection, source);
  return requested;
}

/** Pass this fact reader to the host's recursive basis walker; bind it again at actual egress. */
export function withSelectedNotionSources(access: SelectedNotionAccess): NotionFactReader {
  return {
    async fact(id, options) {
      const requested = await access.sourceRead.fact(id, options);
      if (requested.type !== captureSourceType || sourceEnvelope(requested.value).kind !== 'notion') return requested;
      return authorizeNotionRead(access, id, options, requested);
    },
  };
}

export async function checkNotionAdmission(ctx: CommandContext, id: FactId, source: SourceEnvelope, purposes: readonly string[]) {
  if (!source.sourceSelectionId || !source.externalId) throw new Error('Notion 选源不可用。');
  const selection = await readNotionSelection(ctx.read, ctx.learner, source.sourceSelectionId);
  if (!selection || !matchesRoot(selection, source) || selection.selectionEpoch !== source.sourceSelectionEpoch ||
      await notionSourceId(ctx.learner, selection.id, source.externalId, selection.selectionEpoch) !== id ||
      !purposes.every(use => notionRetainedPurposes(selection.preset).includes(use))) throw new Error('Notion 选源或用途已变更。');
}

export async function resolveBoundedNotionSelection(read: NotionFactReader, use: NotionBoundedUse) {
  const grant = await readNotionSelection(read, use.selection.learner, use.selection.selectionId);
  return grant && grant.preset === use.preset && grant.selectionEpoch === use.selection.selectionEpoch &&
    grant.root.kind === use.selection.root.kind && grant.root.id === notionId(use.selection.root.id) &&
    selectionAllows(grant, use.recipient.purpose, use.recipient.id) ? use : null;
}

export async function prepareNotionIngest(selection: NotionSelection, page: unknown, recordedAt: string) {
  const purpose = notionRetainedPurposes(selection.preset);
  const envelope = await prepareNotionRevision(selection, page, recordedAt);
  const id = await notionSourceId(selection.learner, selection.id, envelope.externalId, selection.selectionEpoch);
  return { id, envelope, purpose };
}

export async function prepareSelectedNotionPages(selection: NotionSelection, cursor: NotionCursor | undefined,
  deniedPages: ReadonlySet<string>, now: () => string, read: <T>(
    stream: Generator<NotionReadRequest, T, NotionReadResponse> | AsyncGenerator<NotionReadRequest, T, NotionReadResponse>,
    pageId?: string, supplemental?: boolean,
  ) => Promise<T>, recovery: {
    pages: readonly string[];
    defer: (reason: {status: number} | {reason: 'ahead-of-cursor'}) => void;
  },
) {
  const { root } = selection;
  const dispatch = notionSelectionWitness(selection);
  const rows: {pageId: string; lastEditedTime: string | null; supplemental?: true}[] = root.kind === 'page'
    ? [{ pageId: root.id, lastEditedTime: null }] : [...await read(notionReadRows(root, cursor))];
  const listed = new Set(rows.map(({ pageId }) => pageId));
  // A blocked page may predate the data source's incremental query cursor.
  for (const pageId of new Set(recovery.pages)) if (!listed.has(pageId)) rows.push({ pageId, lastEditedTime: null, supplemental:true });
  const prepared = [];
  for (const { pageId, lastEditedTime, supplemental } of rows) {
    if (deniedPages.has(pageId)) continue;
    const page = await read(notionReadPage(root, pageId, dispatch), pageId, supplemental).catch(error => {
      if (!supplemental || !(error instanceof NotionTemporaryFailure)) throw error;
      recovery.defer({status:error.status});
      return null;
    });
    if (!page) continue;
    if (lastEditedTime && page.lastEditedTime !== lastEditedTime) throw new NotionSourceChanged('Notion 页面观测已过时。');
    // A direct probe has not established that intervening incremental rows were listed.
    if (supplemental && (!cursor || page.lastEditedTime > cursor.lastEditedTime)) {
      recovery.defer({reason:'ahead-of-cursor'});
      continue;
    }
    prepared.push(await prepareNotionIngest(selection, page, now()));
  }
  return prepared;
}

export async function prepareNotionRevision(selection: NotionSelection, page: unknown, recordedAt: string) {
  notionRetainedPurposes(selection.preset);
  checkNotionPageDispatch(page, { ...notionSelectionWitness(selection), root: selection.root });
  const projection = await notionSourceProjection(page);
  if (selection.root.kind === 'page' && projection.externalId !== notionId(selection.root.id)) {
    throw new Error('Notion 页面不在获准来源内。');
  }
  const envelope = {
    ...projection, kind: 'notion' as const, sourceSelectionId: notionSelectionId(selection.id),
    sourceSelectionEpoch: selection.selectionEpoch, sourceRoot: selection.root,
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

export { notionRevisionDiff };

export type { NotionRefreshInput, NotionRefreshTarget, NotionObservation } from './notion-observation.ts';
export { prepareNotionRefreshInput, notionPageObservationId, notionPageObservationType, UnchangedNotionSourceError } from './notion-observation.ts';

/** Compare content only.
 * Timestamp-only observations must still be committed using prepareNotionRefreshInput.
 */
export function notionRefreshHasChanges(previous: SourceEnvelope, next: SourceEnvelope) {
  const diff = notionRevisionDiff(previous, next);
  return previous.unit.title !== next.unit.title || Object.values(diff).some(ids => ids.length > 0);
}

export async function readActiveNotionSelectionSummary(
  tx: { readonly learner: LearnerId; query<Row>(sql: string, params: readonly (string | number | null)[]): Promise<{ readonly rows: readonly Row[] }> },
  selectionRead: NotionFactReader,
  openSource: (id: FactId) => Promise<FactSnapshot | undefined>,
  selectionId: string,
) {
  const selection = await readNotionSelection(selectionRead, tx.learner, selectionId);
  if (!selection?.active) return undefined;
  const { rows } = await tx.query<{ id: string }>(
    `SELECT f.id FROM facts f JOIN fact_revs r ON (f.learner_id,f.id,f.current_rev)=(r.learner_id,r.fact_id,r.rev)
     WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
       AND r.data->>'kind'='notion' AND r.data->>'sourceSelectionId'=$3 AND r.data->>'sourceSelectionEpoch'=$4`,
    [tx.learner, captureSourceType, selection.id, selection.selectionEpoch],
  );
  let sourceCount = 0;
  for (const row of rows) if (await openSource(factId(row.id))) sourceCount += 1;
  return {
    title: `Notion 选源 · ${selection.id}`,
    summary: `已授权 ${sourceCount} 份同步来源（代次 ${selection.selectionEpoch}）`,
    sourceCount,
  };
}
