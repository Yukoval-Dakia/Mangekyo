import {
  commandId,
  factId,
  learnerId,
  stableId,
  type CommandId,
  type FactId,
  type LearnerId,
  type Revision,
} from '@mangekyo/kernel';
import type { CommandReceipt, FactSnapshot, Json } from '@mangekyo/kernel';
import { editSequence, key, pageId, revision } from './parse.ts';
import {
  accessPurpose,
  creationPurposes,
  TextbookReferenceScopeError,
  type TextbookCreateInput,
  type TextbookReviseInput,
} from './textbook-view.ts';
import { parseTextbookPage, textbookPageFrom, textbookPageType } from './textbook-page.ts';
import { parseTextbookRevision, type TextbookRevision } from './textbook-edits.ts';

export type StudioRequestErrorCtor = new (status: number, message: string) => Error;

export type StudioTextbookHelpersDeps = {
  readonly RequestError: StudioRequestErrorCtor;
  readonly isFactNotFound: (error: unknown) => boolean;
  readonly isFactDenied: (error: unknown) => boolean;
  readonly isRetracted: (error: unknown) => boolean;
  readonly sourceUnavailable: () => Error;
  readonly canonicalJsonString: (value: unknown) => string;
  readonly organizerNoteType: string;
  readonly organizerNote: (value: unknown) => { readonly title: string };
  readonly createTextbookCommand: string;
  readonly reviseTextbookCommand: string;
  readonly reviseTextbookDraftCommand: string;
  readonly undoTextbookCommand: string;
  readonly textbookUndoId: (token: CommandId) => CommandId;
};

function invalid(deps: StudioTextbookHelpersDeps, message: string): never {
  throw new deps.RequestError(400, message);
}

export function parseTextbookInput<T>(deps: StudioTextbookHelpersDeps, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    return invalid(deps, error instanceof Error ? error.message : '教材数据无效。');
  }
}

export function scopedTextbookLearner(deps: StudioTextbookHelpersDeps, value: unknown): LearnerId {
  if (typeof value !== 'string') return invalid(deps, '学习者标识无效。');
  try {
    return learnerId(value);
  } catch {
    return invalid(deps, '学习者标识无效。');
  }
}

export function translateTextbookRead(deps: StudioTextbookHelpersDeps, error: unknown): never {
  if (error instanceof deps.RequestError) throw error;
  if (deps.isFactNotFound(error)) throw new deps.RequestError(404, '找不到这份教材或笔记。');
  if (error instanceof TextbookReferenceScopeError) throw new deps.RequestError(403, error.message);
  if (deps.isFactDenied(error)) throw new deps.RequestError(403, '当前用途不能读取这份内容或其引用。');
  throw error;
}

export function translateTextbookWrite(deps: StudioTextbookHelpersDeps, error: unknown): never {
  if (error instanceof deps.RequestError) throw error;
  if (deps.isFactNotFound(error)) throw new deps.RequestError(404, '找不到要编辑的教材或引用。');
  if (deps.isFactDenied(error)) throw new deps.RequestError(403, '当前用途不能读取或引用这份内容。');
  if (error instanceof Error) {
    if (error.message === 'Command ID already used with a different command identity') {
      throw new deps.RequestError(409, '同一个请求标识已经用于不同编辑。');
    }
    if (error.message.startsWith('Fact already exists: ')) throw new deps.RequestError(409, '教材标识已经存在。');
    if (error.message.startsWith('Fact does not exist: ')) throw new deps.RequestError(404, '找不到要编辑的教材。');
    if (error.message.startsWith('Fact is retracted: ')) throw new deps.RequestError(409, '这份教材已经撤回。');
    if (error.message.startsWith('Fact purpose does not allow this write: ')) {
      throw new deps.RequestError(403, '当前用途不能编辑这份教材。');
    }
    if (error.message === '教材依据已变更。') throw new deps.RequestError(403, '教材来源已变更。');
    if (error.message === 'Proposal not found') throw new deps.RequestError(404, '找不到教材提议。');
    if (error.message === 'Proposal already decided' || error.message.startsWith('Fact revision conflict: ') ||
        error.message === 'Only an unedited companion draft can be revised')
      throw new deps.RequestError(409, '教材或提议已变更，请刷新。');
    if (/^(教材|引用|插入位置|来源)/.test(error.message)) throw new deps.RequestError(400, error.message);
  }
  throw error;
}

export function textbookAccessPurpose(deps: StudioTextbookHelpersDeps, purpose: unknown) {
  return parseTextbookInput(deps, () => accessPurpose(purpose));
}

export function proposalStatusOf(
  proposalState: string,
  currentRev: number,
  baseRev: number,
): 'applied' | 'rejected' | 'conflict' | 'proposed' {
  return proposalState === 'confirmed' ? 'applied'
    : proposalState === 'rejected' ? 'rejected'
    : proposalState === 'conflict' || currentRev !== baseRev ? 'conflict'
    : 'proposed';
}

export function decisionSelectionOf(decision: { readonly receipt: unknown } | null | undefined): readonly string[] {
  const output = (decision?.receipt as CommandReceipt | undefined)?.output;
  return output && typeof output === 'object' && 'selection' in output && Array.isArray(output.selection)
    ? (output.selection as readonly string[])
    : [];
}

export function decisionWrittenOf(decision: { readonly receipt: unknown } | null | undefined) {
  return (decision?.receipt as CommandReceipt | undefined)?.wrote[0];
}

export function parseSelectedTextbookBlockIds(deps: StudioTextbookHelpersDeps, blockIds: unknown): string[] {
  if (!Array.isArray(blockIds) || blockIds.length > 24) invalid(deps, '请选择教材块。');
  const selected = parseTextbookInput(deps, () => blockIds.map(key).sort());
  if (new Set(selected).size !== selected.length) invalid(deps, '请勿重复选择教材块。');
  return selected;
}

export function parseTextbookPageId(deps: StudioTextbookHelpersDeps, id: unknown) {
  return parseTextbookInput(deps, () => pageId(id));
}

export function undoTokenFor(deps: StudioTextbookHelpersDeps, token: unknown): CommandId {
  return parseTextbookInput(deps, () => commandId(key(token)));
}

export function undoOutcomeOf(
  original: { readonly rev: number; readonly priorRev: number | null },
  receipt: CommandReceipt,
  id: FactId,
) {
  return {
    status: original.priorRev === null ? 'withdrawn' : 'reverted',
    ref: { id, rev: receipt.wrote[0]!.rev },
  } as const;
}

export function translateTextbookUndo(deps: StudioTextbookHelpersDeps, error: unknown): never {
  if (deps.isFactDenied(error) && deps.isRetracted(error))
    throw new deps.RequestError(409, '教材已撤回。');
  return translateTextbookWrite(deps, error);
}

export function textbookListEntry(fact: FactSnapshot, deps: StudioTextbookHelpersDeps) {
  return fact.type === textbookPageType
    ? { title: textbookPageFrom(fact).title, kind: 'textbook' as const, readOnly: false }
    : { title: deps.organizerNote(fact.value).title, kind: 'legacyNote' as const, readOnly: true };
}

export function isSkippableListRowError(deps: StudioTextbookHelpersDeps, error: unknown): boolean {
  return deps.isFactDenied(error) || deps.isFactNotFound(error);
}

export function listRowTypes(deps: StudioTextbookHelpersDeps): readonly string[] {
  return [textbookPageType, deps.organizerNoteType];
}

export type TextbookCreatePlan = {
  readonly learner: LearnerId;
  readonly requestId: string;
  readonly accessPurpose: string;
  readonly id: FactId;
  readonly clientEditSeq: number;
  readonly commandInput: Json;
  readonly commandIdValue: CommandId;
};

export function planTextbookCreate(deps: StudioTextbookHelpersDeps, input: TextbookCreateInput): TextbookCreatePlan {
  const learner = scopedTextbookLearner(deps, input.learner);
  const requestId = clientRequestOf(deps, input.requestId);
  const purposes = parseTextbookInput(deps, () => creationPurposes(input.purpose));
  const page = parseTextbookInput(deps, () => parseTextbookPage(input.page));
  const id = input.id === undefined
    ? factId(stableId('textbook-page', learner, requestId, deps.canonicalJsonString(page as Json)))
    : pageId(input.id);
  const clientEditSeq = parseTextbookInput(deps, () => editSequence(input.clientEditSeq));
  return {
    learner,
    requestId,
    accessPurpose: purposes.access,
    id,
    clientEditSeq,
    commandInput: { id, clientEditSeq, purpose: purposes.fact, page } as unknown as Json,
    commandIdValue: commandId(stableId('textbook-command', learner, deps.createTextbookCommand, requestId)),
  };
}

export function clientRequestOf(deps: StudioTextbookHelpersDeps, value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) {
    throw new deps.RequestError(400, '请求标识无效。');
  }
  return value;
}

export type TextbookRevisePlan = {
  readonly learner: LearnerId;
  readonly requestId: string;
  readonly originalEdit: TextbookRevision;
  readonly commandKey: CommandId;
  readonly purpose: string;
};

export function planTextbookRevise(deps: StudioTextbookHelpersDeps, input: TextbookReviseInput): TextbookRevisePlan {
  const learner = scopedTextbookLearner(deps, input.learner);
  const requestId = clientRequestOf(deps, input.requestId);
  const originalEdit = parseTextbookInput(deps, () =>
    parseTextbookRevision({
      id: input.id,
      expectedRev: input.expectedRev,
      clientEditSeq: input.clientEditSeq,
      edits: input.edits,
    }));
  const purpose = parseTextbookInput(deps, () => accessPurpose(input.purpose));
  return {
    learner,
    requestId,
    originalEdit,
    commandKey: commandId(stableId('textbook-command', learner, deps.reviseTextbookCommand, requestId)),
    purpose,
  };
}

export function proposalDecisionId(deps: StudioTextbookHelpersDeps, proposalId: string): CommandId {
  return commandId(stableId('textbook-proposal-decision', proposalId));
}

export function blockModeOf(deps: StudioTextbookHelpersDeps, mode: unknown): 'pinned' | 'following' {
  const resolved = (mode ?? 'pinned') as string;
  if (resolved !== 'pinned' && resolved !== 'following') invalid(deps, '教材块定位方式无效。');
  return resolved;
}

export function legacyConflictOf(
  error: unknown,
  originalEditId: string,
): 'legacy' | 'revconflict' | 'requestconflict' | undefined {
  if (error instanceof Error && (
    error.message === '目标事实不是教材页。' ||
    error.message === `Fact type is not registry-owned: ${originalEditId}`
  )) return 'legacy';
  if (error instanceof Error && (
    error.message.startsWith('Fact revision conflict: ') || error.message === 'Fact update conflict'
  )) return 'revconflict';
  if (error instanceof Error && error.message === 'Command ID already used with a different command identity')
    return 'requestconflict';
  return undefined;
}

export function proposalSkipError(deps: StudioTextbookHelpersDeps, error: unknown): boolean {
  return deps.isFactDenied(error) || deps.isFactNotFound(error) ||
    (error instanceof Error && error.message === '教材依据已变更。');
}

export function priorEditInputOf<Row extends { readonly input: unknown }>(row: Row | null | undefined) {
  return row && { ...row, input: typeof row.input === 'string' ? JSON.parse(row.input) : row.input };
}

export function missingUndoChange(deps: StudioTextbookHelpersDeps): never {
  throw new deps.RequestError(404, '找不到可撤回的教材变更。');
}

export function notTextbookPage(deps: StudioTextbookHelpersDeps): never {
  throw new deps.RequestError(404, '这份内容不是教材。');
}

export function isMissingTextbookPage(deps: StudioTextbookHelpersDeps): never {
  throw new deps.RequestError(404, '这份内容不是个人教材或旧笔记。');
}

export function missingBlockPage(deps: StudioTextbookHelpersDeps): never {
  throw new deps.RequestError(404, '旧笔记没有教材块。');
}

export function proposalNotFound(deps: StudioTextbookHelpersDeps): never {
  throw new deps.RequestError(404, '找不到教材提议。');
}

export function staleTextbookPage(deps: StudioTextbookHelpersDeps): never {
  throw new deps.RequestError(409, '教材已更新。');
}

export type TextbookReadHost<Tx, Check, Result> = {
  readonly confirmNotionRead: (database: unknown, learner: LearnerId, read: (tx: Tx, check: Check) => Promise<Result>, publish?: (tx: Tx, check: Check) => Promise<Result>) => Promise<Result>;
  readonly database: unknown;
};

export async function readTextbook<Tx, Check, Result>(
  deps: StudioTextbookHelpersDeps,
  host: TextbookReadHost<Tx, Check, Result>,
  input: { readonly learner: unknown },
  body: (tx: Tx, check: Check) => Promise<Result>,
): Promise<Result> {
  const learner = scopedTextbookLearner(deps, input.learner);
  return host.confirmNotionRead(host.database, learner, body).catch(error => translateTextbookRead(deps, error));
}

export async function writeTextbook<Tx, Check, Result>(
  deps: StudioTextbookHelpersDeps,
  host: TextbookReadHost<Tx, Check, Result>,
  input: { readonly learner: unknown },
  body: (tx: Tx, check: Check) => Promise<Result>,
  publish?: (tx: Tx, check: Check) => Promise<Result>,
): Promise<Result> {
  const learner = scopedTextbookLearner(deps, input.learner);
  return host.confirmNotionRead(host.database, learner, body, publish).catch(error => translateTextbookWrite(deps, error));
}

export function textbookPageIdOrInvalid(deps: StudioTextbookHelpersDeps, value: unknown) {
  return parseTextbookPageId(deps, value);
}

export type TextbookProposalHost<Tx, Check> = {
  readonly readFact: (tx: Tx, check: Check, purpose: string, id: string, rev?: unknown) => Promise<FactSnapshot>;
  readonly checkTextbookBasis: (read: { readonly fact: (id: string, options: { readonly mode: string; readonly rev?: unknown }) => Promise<FactSnapshot> }, basis: readonly unknown[]) => Promise<void>;
  readonly previewTextbookRevision: (args: { readonly learner: LearnerId; readonly read: unknown }, edit: TextbookRevision) => Promise<unknown>;
  readonly readRecordedCommand: (tx: Tx, id: CommandId) => Promise<{ readonly receipt: unknown } | null | undefined>;
  readonly teaching: string;
  readonly storage: string;
};

export async function previewTextbookProposal<Tx, Check>(
  host: TextbookProposalHost<Tx, Check>,
  tx: Tx,
  check: Check,
  input: unknown,
  parseRevision: (input: unknown) => TextbookRevision,
) {
  const edit = parseRevision(input);
  const read = {
    fact: (id: string, options: { readonly mode: string; readonly rev?: unknown }) =>
      host.readFact(tx, check, host.teaching, id, options.mode === 'pinned' ? options.rev : undefined),
  };
  const pinned = await host.readFact(tx, check, host.teaching, edit.id, edit.expectedRev);
  await host.checkTextbookBasis(read, [...(textbookPageFrom(pinned).basis ?? []), ...(edit.basis ?? [])]);
  return host.previewTextbookRevision({ learner: (tx as { learner: LearnerId }).learner, read }, edit);
}

export async function textbookProposalView<Tx, Check>(
  deps: StudioTextbookHelpersDeps,
  host: TextbookProposalHost<Tx, Check>,
  tx: Tx,
  check: Check,
  proposal: { readonly id: string; readonly state: string; readonly input: unknown },
  parseRevision: (input: unknown) => TextbookRevision,
) {
  const { base, items } = await previewTextbookProposal(host, tx, check, proposal.input, parseRevision) as {
    readonly base: { readonly id: string; readonly rev: number };
    readonly items: readonly unknown[];
  };
  const current = await host.readFact(tx, check, host.storage, base.id);
  const decision = await host.readRecordedCommand(tx, proposalDecisionId(deps, proposal.id));
  const blockIds = decisionSelectionOf(decision);
  const written = decisionWrittenOf(decision);
  const status = proposalStatusOf(proposal.state, current.ref.rev, base.rev);
  return {
    proposalId: proposal.id,
    status,
    base,
    items,
    blockIds,
    result: written ? { id: written.id, rev: written.rev, undo_token: proposalDecisionId(deps, proposal.id) } : null,
  };
}

export type TextbookLambdaHost<Tx, Check> = {
  readonly readFact: (tx: Tx, check: Check, purpose: string, id: string, rev?: unknown) => Promise<FactSnapshot>;
  readonly readProposals: (tx: Tx, type: string, filter: { readonly id: FactId }, proposalId?: CommandId) => Promise<readonly { readonly id: string; readonly state: string; readonly input: unknown }[]>;
  readonly readRecordedCommand: (tx: Tx, id: CommandId) => Promise<{ readonly receipt: unknown } | null | undefined>;
  readonly proposalView: (tx: Tx, check: Check, proposal: { readonly id: string; readonly state: string; readonly input: unknown }) => Promise<unknown>;
  readonly decideProposal: (tx: Tx, decision: Record<string, unknown>, select: (inner: Tx, input: unknown) => Promise<unknown>) => Promise<unknown>;
  readonly previewProposal: (tx: Tx, check: Check, input: unknown) => Promise<unknown>;
  readonly readContext: (tx: Tx, purpose: string) => unknown;
  readonly pageView: (read: unknown, fact: FactSnapshot) => Promise<unknown>;
  readonly textbookMasteryPulse: (tx: Tx, check: Check, view: unknown, pulse: unknown) => Promise<Record<string, unknown>>;
  readonly legacyView: (fact: FactSnapshot) => unknown;
  readonly openTextbookBlock: (read: unknown, ref: unknown, blockId: string, mode: 'pinned' | 'following') => Promise<unknown>;
  readonly checkBodyReference: (read: unknown, learner: LearnerId, blockId: string, body: unknown) => Promise<unknown>;
  readonly parseTextbookPulseClaim: (claim: Record<string, unknown>, id: FactId) => { readonly requestId: string; readonly id: FactId; readonly rev: Revision; readonly deletionWatermark?: string };
  readonly textbookPulseClaimMatches: (selected: unknown, claim: unknown) => boolean;
  readonly textbookPageFrom: (fact: FactSnapshot) => { readonly title?: string; readonly basis?: readonly unknown[] };
  readonly organizerNote: (value: unknown) => { readonly title: string };
  readonly reviseCommand: string;
};

export async function textbookProposalsBody<Tx, Check>(
  deps: StudioTextbookHelpersDeps,
  host: TextbookLambdaHost<Tx, Check>,
  tx: Tx,
  check: Check,
  id: FactId,
): Promise<{ readonly proposals: readonly unknown[] }> {
  host.textbookPageFrom(await host.readFact(tx, check, 'storage', id));
  const proposals: unknown[] = [];
  for (const proposal of await host.readProposals(tx, host.reviseCommand, { id })) {
    try {
      const { proposalId, status, base } = await host.proposalView(tx, check, proposal) as { proposalId: string; status: string; base: unknown };
      proposals.push({ proposalId, status, base });
    } catch (error) {
      if (!proposalSkipError(deps, error)) throw error;
    }
  }
  return { proposals };
}

export async function textbookProposalReadBody<Tx, Check>(
  deps: StudioTextbookHelpersDeps,
  host: TextbookLambdaHost<Tx, Check>,
  tx: Tx,
  check: Check,
  id: FactId,
  proposalKey: CommandId,
): Promise<unknown> {
  const [proposal] = await host.readProposals(tx, host.reviseCommand, { id }, proposalKey);
  if (!proposal) return proposalNotFound(deps);
  return host.proposalView(tx, check, proposal);
}

export async function textbookProposalDecideBody<Tx, Check>(
  deps: StudioTextbookHelpersDeps,
  host: TextbookLambdaHost<Tx, Check>,
  tx: Tx,
  check: Check,
  args: {
    readonly learner: LearnerId;
    readonly id: FactId;
    readonly proposalKey: CommandId;
    readonly selected: readonly string[];
    readonly selectTextbookEdits: (preview: unknown, selected: readonly string[]) => unknown;
  },
): Promise<unknown> {
  await textbookProposalReadBody(deps, host, tx, check, args.id, args.proposalKey);
  await host.decideProposal(tx, {
    learner: args.learner,
    purpose: 'storage',
    type: host.reviseCommand,
    id: proposalDecisionId(deps, args.proposalKey),
    proposalId: args.proposalKey,
    selection: args.selected,
  }, async (inner: Tx, proposedInput: unknown) => {
    const edit = parseTextbookRevision(proposedInput);
    if (edit.id !== args.id) return proposalNotFound(deps);
    const preview = await host.previewProposal(inner, check, proposedInput);
    if (!args.selected.length) return null;
    if ((await host.readFact(inner, check, 'storage', args.id)).ref.rev !== edit.expectedRev)
      return staleTextbookPage(deps);
    return parseTextbookInput(deps, () => args.selectTextbookEdits(preview, args.selected));
  });
  return textbookProposalReadBody(deps, host, tx, check, args.id, args.proposalKey);
}

export async function textbookGetBody<Tx, Check>(
  deps: StudioTextbookHelpersDeps,
  host: Pick<TextbookLambdaHost<Tx, Check>, 'readFact' | 'readContext' | 'pageView' | 'textbookMasteryPulse' | 'legacyView' | 'organizerNote'>,
  tx: Tx,
  check: Check,
  args: { readonly id: string; readonly rev?: unknown; readonly purpose: string; readonly pulse?: unknown },
): Promise<unknown> {
  const fact = await host.readFact(tx, check, args.purpose, args.id, args.rev);
  if (fact.type === textbookPageType) {
    const view = await host.pageView(host.readContext(tx, args.purpose), fact);
    return args.rev === undefined && args.pulse
      ? { ...(view as Record<string, unknown>), ...await host.textbookMasteryPulse(tx, check, view, args.pulse) }
      : view;
  }
  if (fact.type === deps.organizerNoteType) return host.legacyView(fact);
  return isMissingTextbookPage(deps);
}

export async function textbookClaimBody<Tx, Check>(
  deps: StudioTextbookHelpersDeps,
  host: Pick<TextbookLambdaHost<Tx, Check>, 'readFact' | 'readContext' | 'pageView' | 'textbookMasteryPulse' | 'textbookPulseClaimMatches' | 'parseTextbookPulseClaim'>,
  tx: Tx,
  check: Check,
  args: { readonly id: FactId; readonly teaching: string; readonly pulse: unknown; readonly selectedClaim: { readonly requestId: string; readonly id: FactId; readonly rev: Revision; readonly deletionWatermark?: string } },
): Promise<null> {
  const fact = await host.readFact(tx, check, args.teaching, args.id);
  if (fact.type !== textbookPageType) return notTextbookPage(deps);
  const view = await host.pageView(host.readContext(tx, args.teaching), fact);
  const selected = await host.textbookMasteryPulse(tx, check, view, args.pulse);
  if (!host.textbookPulseClaimMatches(selected, args.selectedClaim))
    throw new deps.RequestError(409, '这道快检题当前不可领取。');
  return null;
}

export async function textbookOpenBlockBody<Tx, Check>(
  deps: StudioTextbookHelpersDeps,
  host: Pick<TextbookLambdaHost<Tx, Check>, 'readFact' | 'readContext' | 'openTextbookBlock' | 'checkBodyReference'>,
  tx: Tx,
  check: Check,
  args: { readonly id: string; readonly rev?: unknown; readonly blockId: unknown; readonly mode: unknown; readonly purpose: string; readonly learner: LearnerId },
): Promise<unknown> {
  const read = host.readContext(tx, args.purpose);
  const base = await host.readFact(tx, check, args.purpose, args.id, args.rev);
  if (base.type !== textbookPageType) return missingBlockPage(deps);
  const mode = blockModeOf(deps, args.mode);
  const opened = await host.openTextbookBlock(read, base.ref, args.blockId as string, mode);
  const openedRef = (opened as { ref: { id: string; rev: unknown } }).ref;
  await host.readFact(tx, check, args.purpose, openedRef.id, openedRef.rev);
  const source = await host.checkBodyReference(read, args.learner, (opened as { block: { id: string } }).block.id, (opened as { block: { body: unknown } }).block.body);
  return { kind: 'textbookBlock' as const, ...(opened as Record<string, unknown>), source };
}

export function textbookListEntryKind(factType: string, deps: StudioTextbookHelpersDeps): 'textbook' | 'legacyNote' | 'skip' {
  return factType === textbookPageType ? 'textbook' : factType === deps.organizerNoteType ? 'legacyNote' : 'skip';
}

export async function textbookListRowsBody<Tx, Check>(
  deps: StudioTextbookHelpersDeps,
  host: Pick<TextbookLambdaHost<Tx, Check>, 'readFact' | 'organizerNote'>,
  tx: Tx,
  check: Check,
  rows: readonly { readonly id: string; readonly type: string }[],
  purpose: string,
): Promise<{ readonly pages: readonly unknown[]; readonly legacyNotes: readonly unknown[] }> {
  const pages: unknown[] = [];
  const legacyNotes: unknown[] = [];
  for (const row of rows) {
    try {
      const fact = await host.readFact(tx, check, purpose, row.id);
      const view = textbookListEntry(fact, deps);
      const summary = { id: row.id, rev: fact.ref.rev, purpose: fact.purpose, ...view };
      (view.kind === 'textbook' ? pages : legacyNotes).push(summary);
    } catch (error) {
      if (!isSkippableListRowError(deps, error)) throw error;
    }
  }
  return { pages, legacyNotes };
}

export function undoCommandInput(original: { readonly rev: number; readonly priorRev: number | null }, id: FactId): Record<string, unknown> {
  return { id, expectedRev: original.rev, priorRev: original.priorRev };
}

export function reviseConflictDecision(
  kind: 'legacy' | 'revconflict' | 'requestconflict' | undefined,
): 'legacy' | 'REVISION_CONFLICT' | 'REQUEST_ID_CONFLICT' | 'translate' {
  return kind === 'legacy' ? 'legacy' : kind === 'revconflict' ? 'REVISION_CONFLICT' : kind === 'requestconflict' ? 'REQUEST_ID_CONFLICT' : 'translate';
}

export function issueBankArgs(selectedClaim: { readonly requestId: string; readonly id: FactId; readonly rev: Revision; readonly deletionWatermark?: string }) {
  return {
    requestId: selectedClaim.requestId,
    questionRefs: [{ id: selectedClaim.id, rev: selectedClaim.rev }],
    deletionWatermark: selectedClaim.deletionWatermark,
  };
}

export function prepareTextbookAccess(
  deps: StudioTextbookHelpersDeps,
  input: { readonly learner: unknown; readonly purpose?: unknown },
): { readonly learner: LearnerId; readonly purpose: string } {
  return {
    learner: scopedTextbookLearner(deps, input.learner),
    purpose: textbookAccessPurpose(deps, input.purpose),
  };
}

export function prepareTextbookGet(
  deps: StudioTextbookHelpersDeps,
  input: { readonly learner: unknown; readonly id: unknown; readonly purpose?: unknown },
): { readonly learner: LearnerId; readonly id: ReturnType<typeof pageId>; readonly purpose: string } {
  return {
    ...prepareTextbookAccess(deps, input),
    id: parseTextbookPageId(deps, input.id),
  };
}

export type TextbookReviseTailHost = {
  readonly get: (args: { readonly learner: unknown; readonly id: string; readonly purpose: unknown }) => Promise<{ readonly kind: string }>;
  readonly conflict: (code: 'REVISION_CONFLICT' | 'REQUEST_ID_CONFLICT' | 'CLIENT_EDIT_SEQ_CONFLICT', edit: TextbookRevision) => Promise<never>;
};

export async function runTextbookReviseTail(
  deps: StudioTextbookHelpersDeps,
  host: TextbookReviseTailHost,
  args: {
    readonly error: unknown;
    readonly originalEdit: TextbookRevision;
    readonly learner: LearnerId;
    readonly purpose: unknown;
  },
): Promise<never> {
  const kind = legacyConflictOf(args.error, args.originalEdit.id);
  if (kind === 'legacy') {
    const current = await host.get({ learner: args.learner, id: args.originalEdit.id, purpose: args.purpose });
    if (current.kind === 'legacyNote') {
      throw new deps.RequestError(409, '旧笔记保留原所有者，只能读取，不能作为教材修订。');
    }
  }
  if (kind === 'revconflict') return host.conflict('REVISION_CONFLICT', args.originalEdit);
  if (kind === 'requestconflict') return host.conflict('REQUEST_ID_CONFLICT', args.originalEdit);
  return translateTextbookWrite(deps, args.error);
}

export async function runTextbookConflict<Current extends { readonly kind: string }>(
  deps: StudioTextbookHelpersDeps,
  get: () => Promise<Current>,
  code: 'REVISION_CONFLICT' | 'REQUEST_ID_CONFLICT' | 'CLIENT_EDIT_SEQ_CONFLICT',
  originalEdit: TextbookRevision,
  requestId: string,
  ConflictError: new (code: string, current: Current, edit: TextbookRevision, requestId: string, previousReceipt?: unknown) => Error,
  previousReceipt?: unknown,
): Promise<never> {
  const current = await get();
  if (current.kind !== 'textbook') throw new deps.RequestError(409, '旧笔记是只读内容，不能作为教材修订。');
  throw new ConflictError(code, current, originalEdit, requestId, previousReceipt);
}

export async function runTextbookUndo<Receipt extends { readonly wrote: readonly { readonly rev: number }[] }>(
  deps: StudioTextbookHelpersDeps,
  host: {
    readonly handle: (command: { readonly learner: LearnerId; readonly actor: 'learner' | 'companion'; readonly purpose: string; readonly id: CommandId; readonly type: string; readonly input: Json }) => Promise<Receipt>;
    readonly textbookUndoId: (token: CommandId) => CommandId;
    readonly undoTextbookCommand: string;
  },
  args: { readonly learner: LearnerId; readonly id: FactId; readonly undoToken: CommandId; readonly original: { readonly rev: number; readonly priorRev: number | null } },
): Promise<{ readonly status: 'withdrawn' | 'reverted'; readonly ref: { readonly id: FactId; readonly rev: number } }> {
  const receipt = await host.handle({
    learner: args.learner,
    actor: 'learner',
    purpose: 'storage',
    id: host.textbookUndoId(args.undoToken),
    type: host.undoTextbookCommand,
    input: undoCommandInput(args.original, args.id) as Json,
  }).catch(error => translateTextbookUndo(deps, error));
  return undoOutcomeOf(args.original, receipt as unknown as CommandReceipt, args.id);
}

export type TextbookPrior = { readonly id: CommandId; readonly receipt: CommandReceipt; readonly input: { readonly input: unknown } };

export async function textbookReadFact<Tx, Check extends (fact: FactSnapshot) => Promise<void>>(
  tx: Tx,
  check: Check,
  host: {
    readonly readContext: (tx: Tx, purpose: string) => { readonly fact: (id: ReturnType<typeof pageId>, options: { readonly mode: string; readonly rev?: ReturnType<typeof revision> }) => Promise<FactSnapshot> };
    readonly checkStudioNotionFact: (tx: Tx, fact: FactSnapshot, purpose: string, recipient: 'learner') => Promise<unknown>;
    readonly resolveSource: (tx: Tx, source: unknown, options: { readonly recipient: 'learner'; readonly track: (source: FactSnapshot) => void }) => Promise<boolean>;
    readonly sourceReference: (fact: FactSnapshot, scope: { readonly kind: 'whole' }) => unknown;
    readonly sourceUnavailable: () => Error;
  },
  purpose: string,
  id: string,
  rev?: unknown,
): Promise<FactSnapshot> {
  const read = host.readContext(tx, purpose);
  const fact = await read.fact(pageId(id), rev === undefined ? { mode: 'following' } : { mode: 'pinned', rev: revision(rev) });
  await host.checkStudioNotionFact(tx, fact, 'storage', 'learner');
  const sources: FactSnapshot[] = [fact];
  if (fact.type === textbookPageType) {
    const page = textbookPageFrom(fact);
    if ((page.basis?.length || page.blocks.some(({ body }) => body.kind === 'reference' || body.kind === 'image')) &&
        !await host.resolveSource(tx, host.sourceReference(fact, { kind: 'whole' }), { recipient: 'learner', track: source => sources.push(source) }))
      throw host.sourceUnavailable();
  }
  for (const source of sources) await check(source);
  return fact;
}
