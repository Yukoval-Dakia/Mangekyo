import { factId, FactNotFoundError, type CommandContext, type FactId, type FactSnapshot, type LearnerId, type ReadContext } from '@mangekyo/kernel';
import type { NotionRoot, NotionSelectionWitness } from './notion-api.ts';
import { advanceNotionCursor, type NotionCursor, notionHash, notionId, notionRecord, notionSelectionId } from './notion-values.ts';

export const notionSelectionType = 'capture.notionSelection';
export const grantNotionSelectionCommand = 'capture.grantNotionSelection';
export const revokeNotionSelectionCommand = 'capture.revokeNotionSelection';
export type NotionRetainedPreset = 'storage' | 'learning';
export type NotionPreset = NotionRetainedPreset | 'turn-only' | 'temporary';
export type NotionRecipientUse = { readonly id: string; readonly purpose: string };
type SelectionSettings = { id: string; root: NotionRoot; preset: NotionPreset; recipients: NotionRecipientUse[] };
type ContinuousUse = NotionRecipientUse & { sinceEpoch: string };
export type NotionSelection = SelectionSettings & {
  active: boolean; selectionEpoch: string; learner: LearnerId; continuity: readonly ContinuousUse[];
};
export type NotionReadOptions = Parameters<ReadContext['fact']>[1];
export type NotionFactReader = { fact(id: FactId, options: NotionReadOptions): Promise<FactSnapshot> };

export function notionRetainedPurposes(preset: NotionPreset = 'storage'): readonly string[] {
  switch (preset) {
    case 'storage': return ['storage'];
    case 'learning': return ['storage', 'learning', 'teaching', 'background-research'];
    default: throw new Error('该 Notion 用途不能保存为长期原件。');
  }
}

function onlyFields(row: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(row).some(key => !fields.includes(key))) throw new Error('Notion 选源包含未知字段。');
}

export function notionRoot(input: unknown): NotionRoot {
  const root = notionRecord(input);
  onlyFields(root, ['kind', 'id']);
  if (root.kind !== 'page' && root.kind !== 'data-source') throw new Error('请选择 Notion 页或库。');
  return { kind: root.kind, id: notionId(root.id) };
}

export function notionEpoch(value: unknown) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('选源代次无效。');
  return value;
}

function recipientUse(input: unknown): NotionRecipientUse {
  const pair = notionRecord(input);
  onlyFields(pair, ['id', 'purpose']);
  const { id, purpose } = pair;
  if (typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 256 ||
      typeof purpose !== 'string' || !purpose) throw new Error('Notion 接收方或用途无效。');
  return { id, purpose };
}

function settings(row: Record<string, unknown>): SelectionSettings {
  const { preset, recipients } = row;
  if (preset !== 'storage' && preset !== 'learning' && preset !== 'turn-only' && preset !== 'temporary')
    throw new Error('请选择 Notion 用途。');
  const permitted = preset === 'turn-only' || preset === 'temporary'
    ? ['turn-answer', 'turn-tool'] : notionRetainedPurposes(preset).filter(purpose => purpose !== 'storage');
  if (!Array.isArray(recipients)) throw new Error('请显式指定接收方。');
  const uses = recipients.map(recipientUse);
  if (uses.some(use => !permitted.includes(use.purpose))) throw new Error('该用途不属于所选预设。');
  if (new Set(uses.map(use => JSON.stringify([use.id, use.purpose]))).size !== uses.length)
    throw new Error('Notion 接收方与用途重复。');
  return { id: notionSelectionId(row.selectionId), root: notionRoot(row.root), preset, recipients: uses };
}

export function selectionValue(input: unknown): SelectionSettings & { active: boolean; continuity?: ContinuousUse[] } {
  const row = notionRecord(input);
  if (typeof row.active !== 'boolean') throw new Error('选源状态无效。');
  const value = { ...settings({ ...row, selectionId: row.id }), active: row.active };
  if (row.continuity === undefined) return value;
  if (!Array.isArray(row.continuity)) throw new Error('选源连续授权记录无效。');
  const continuity = row.continuity.map(input => {
    const { id, purpose, sinceEpoch } = notionRecord(input);
    return { ...recipientUse({ id, purpose }), sinceEpoch: notionEpoch(sinceEpoch) };
  });
  return { ...value, continuity };
}

function retainedUses(value: SelectionSettings & { active: boolean }, learner: LearnerId): NotionRecipientUse[] {
  if (!value.active || (value.preset !== 'learning' && value.preset !== 'storage')) return [];
  return [{ id: learner, purpose: 'storage' }, ...value.recipients];
}

function nextContinuity(value: SelectionSettings & { active: boolean }, learner: LearnerId,
  epoch: string, previous?: NotionSelection) {
  const sameRoot = previous?.active && previous.root.kind === value.root.kind && previous.root.id === value.root.id;
  return retainedUses(value, learner).map(use => {
    const existing = sameRoot && previous.continuity.find(entry => entry.id === use.id && entry.purpose === use.purpose);
    return { ...use, sinceEpoch: existing ? existing.sinceEpoch : epoch };
  });
}

export async function notionSelectionFactId(learner: LearnerId, selectionId: string) {
  const hash = await notionHash(JSON.stringify([notionSelectionType, learner, notionSelectionId(selectionId)]));
  return factId(hash.slice(0, 26).toUpperCase());
}

/** Use the learner's storage reader from the same transaction as the source read or write. */
export async function readNotionSelection(read: NotionFactReader, learner: LearnerId, selectionId: string): Promise<NotionSelection | null> {
  const id = await notionSelectionFactId(learner, selectionId);
  let snapshot: FactSnapshot;
  try { snapshot = await read.fact(id, { mode: 'following' }); }
  catch (error) { if (error instanceof FactNotFoundError) return null; throw error; }
  if (snapshot.ref.learner !== learner || snapshot.ref.id !== id || snapshot.type !== notionSelectionType)
    throw new Error('选源记录不匹配。');
  const value = selectionValue(snapshot.value);
  if (value.id !== selectionId) throw new Error('选源记录不匹配。');
  const selectionEpoch = String(snapshot.ref.rev);
  // Older settings only prove their current revision's grant.
  const continuity = value.continuity ?? nextContinuity(value, learner, selectionEpoch);
  if (continuity.some(use => use.sinceEpoch === '0' || BigInt(use.sinceEpoch) > BigInt(selectionEpoch)))
    throw new Error('选源连续授权代次无效。');
  return { ...value, learner, selectionEpoch, continuity };
}

function changeTarget(row: Record<string, unknown>) {
  return { selectionId: notionSelectionId(row.selectionId), expectedEpoch: notionEpoch(row.expectedEpoch) };
}

export function selectionChange(input: unknown) {
  const row = notionRecord(input);
  onlyFields(row, ['selectionId', 'expectedEpoch', 'recipient']);
  return { ...changeTarget(row), ...(row.recipient === undefined ? {} : { recipient: recipientUse(row.recipient) }) };
}

export function selectionGrant(input: unknown) {
  const row = notionRecord(input);
  onlyFields(row, ['selectionId', 'expectedEpoch', 'root', 'preset', 'recipients']);
  return { ...changeTarget(row), settings: settings(row) };
}

export async function changeNotionSelection(ctx: CommandContext, target: ReturnType<typeof selectionChange>, grant?: SelectionSettings) {
  const current = await readNotionSelection(ctx.read, ctx.learner, target.selectionId);
  if ((current?.selectionEpoch ?? '0') !== target.expectedEpoch) throw new Error('选源代次已变更。');
  const id = await notionSelectionFactId(ctx.learner, target.selectionId);
  if (!current) {
    if (!grant) throw new Error('找不到选源。');
    const data = { ...grant, active: true };
    return [{ kind: 'create' as const, id, factType: notionSelectionType, purpose: ['storage'],
      data: { ...data, continuity: nextContinuity(data, ctx.learner, '1') } }];
  }
  if (!current.active && !grant) return [];
  let data;
  if (grant) {
    data = { ...grant, active: true };
  } else if (target.recipient) {
    const excluded = target.recipient;
    const recipients = current.recipients.filter(use => use.id !== excluded.id || use.purpose !== excluded.purpose);
    if (recipients.length === current.recipients.length) throw new Error('找不到选定的接收方与用途。');
    data = { id: current.id, root: current.root, preset: current.preset, recipients, active: true };
  } else {
    data = { id: current.id, root: current.root, preset: current.preset, recipients: [], active: false };
  }
  const expectedRev = Number(current.selectionEpoch) as FactSnapshot['ref']['rev'];
  const continuity = nextContinuity(data, ctx.learner, String(expectedRev + 1), current);
  return [{ kind: 'correct' as const, id, expectedRev, data: { ...data, continuity } }];
}

export function selectionAllows(selection: NotionSelection | null, purpose: string, recipientId: string) {
  if (!selection?.active) return false;
  if (purpose === 'storage') return recipientId === selection.learner &&
    (selection.preset === 'learning' || selection.preset === 'storage');
  return selection.recipients.some(use => use.id === recipientId && use.purpose === purpose);
}

export type NotionSelectionCursor = NotionSelectionWitness & { readonly position: NotionCursor };

/** Copy this scope before dispatch, and keep it with pages, cursors and bounded handles. */
export function notionSelectionWitness(selection: NotionSelection): NotionSelectionWitness {
  if (!selection.active) throw new Error('Notion 选源不可用。');
  return { learner: selection.learner, selectionId: selection.id, selectionEpoch: selection.selectionEpoch };
}

function cursorScope(selection: NotionSelection) {
  if (!selection.active || selection.root.kind !== 'data-source' ||
      (selection.preset !== 'learning' && selection.preset !== 'storage')) throw new Error('当前选源不可增量同步。');
  return notionSelectionWitness(selection);
}

function cursorMatches(scope: NotionSelectionWitness, other: NotionSelectionWitness) {
  return scope.learner === other.learner && scope.selectionId === other.selectionId && scope.selectionEpoch === other.selectionEpoch;
}

/** A new or replaced grant starts the data-source query from the beginning. */
export function resumeNotionSelectionCursor(selection: NotionSelection, saved: NotionSelectionCursor | null) {
  const current = cursorScope(selection);
  return saved && cursorMatches(current, saved) ? saved.position : undefined;
}

/** Commit this checkpoint under the same learner lock, after all row writes and a fresh selection read. */
export function commitNotionSelectionCursor(current: NotionSelection, dispatch: NotionSelectionWitness,
  previous: NotionSelectionCursor | null, committed: readonly NotionCursor[]): NotionSelectionCursor | null {
  const scope = cursorScope(current);
  if (!cursorMatches(scope, dispatch)) throw new Error('Notion 同步选源代次已变更。');
  const position = advanceNotionCursor(resumeNotionSelectionCursor(current, previous), committed);
  return position ? { ...scope, position } : null;
}
