import {
  commandId, factId, type CommandId, type CommandReceipt, type FactId, type FactSnapshot, type Json,
  type LearnerId, type ReadContext, type Revision, type Tick,
} from '@mangekyo/kernel';
import { helpExposureRequest, type HelpPresentation } from './help-exposure-values.ts';
import { storagePurpose } from './library-values.ts';
import {
  isOwnWordsClaim, ownWordsClaimType, saveOwnWordsTakeawayCommand, withdrawOwnWordsTakeawayCommand,
} from './takeaway-values.ts';
import { readActivityHelpEvents, readActivitySubmissionBirth } from './evidence-read.ts';
import { projectHelpExposure } from './help-exposure.ts';
import { workbookAttempt, workbookAttemptType } from './workbook-values.ts';
import type { HelpTarget } from './help-exposure-values.ts';

export type TakeawayReject = (status: number, message: string) => Error;
export type TakeawayScope = {
  learner: LearnerId;
  query<Row>(sql: string, params: readonly (string | number | null | readonly string[])[]): Promise<{ rows: readonly Row[] }>;
};
type Read = { fact(...args: Parameters<ReadContext['fact']>): Promise<FactSnapshot> };
/** Host-bound command executor; the shell supplies learner/actor and returns the receipt. */
type Handle = (request: { id: CommandId; type: string; input: unknown; purpose: string }) => Promise<CommandReceipt>;
export type Sign = (scope: unknown) => string;
export type Stable = (...parts: string[]) => string;

type Deps = {
  scope: TakeawayScope;
  read: Read;
  handle: Handle;
  reject: TakeawayReject;
  sign: Sign;
  stable: Stable;
  unavailable(error: unknown): boolean;
};

function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) throw new Error('口诀请求标识无效。');
  return value;
}
function revOf(value: unknown): Revision {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('版本无效。');
  return value as Revision;
}
function textOf(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > 60)
    throw new Error('口诀须为 60 字以内的文字。');
  return value;
}
function itemIdOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) throw new Error('口诀题位无效。');
  return value;
}
function refOf(value: unknown): { id: FactId; rev: Revision } {
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { id: factId(typeof r.id === 'string' ? r.id : ''), rev: revOf(r.rev) };
}
function conceptOf(value: unknown): { id: FactId; rev: Revision; accessEpoch: Tick } | undefined {
  if (value === undefined || value === null) return undefined;
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const id = typeof r.id === 'string' ? factId(r.id) : undefined;
  if (!id || typeof r.accessEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(r.accessEpoch))
    throw new Error('口诀概念锚点无效。');
  return { id, rev: revOf(r.rev), accessEpoch: r.accessEpoch as Tick };
}
function row(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? input as Record<string, unknown> : {};
}

/** Same-slot own-words takeaway save; binds (paperId, attempt, itemId, text, requestId); idempotent. */
export async function takeawaySave(deps: Deps, paperId: FactId, attemptId: FactId, input: unknown) {
  const value = row(input);
  let parsed;
  try {
    parsed = { requestId: requestId(value.requestId), attemptRev: revOf(value.attemptRev), itemId: itemIdOf(value.itemId), text: textOf(value.text), concept: conceptOf(value.concept) };
  } catch (error) { throw deps.reject(400, error instanceof Error ? error.message : '口诀请求无效。'); }
  const binding = { paperId, attempt: { id: attemptId, rev: parsed.attemptRev }, itemId: parsed.itemId, requestId: parsed.requestId, text: parsed.text };
  const id = factId(deps.stable('own-words-takeaway', parsed.requestId, paperId, attemptId, parsed.itemId));
  const command = commandId(deps.stable('save-own-words-takeaway', id));
  const receipt = await deps.handle({ id: command, type: saveOwnWordsTakeawayCommand,
    input: parsed.concept === undefined ? { id, binding } : { id, binding, concept: parsed.concept }, purpose: storagePurpose });
  if (receipt.state !== 'done' && !receipt.wrote.some(w => w.id === id)) throw deps.reject(409, '口诀保存未完成。');
  return { id, rev: receipt.wrote.find(w => w.id === id)?.rev ?? 1, undo_token: command, sticky: true, purpose: storagePurpose };
}

/** Withdraw by the exact undo_token (the save command id); revocation is live on later reads. */
export async function takeawayUndo(deps: Deps, input: unknown) {
  const token = typeof row(input).undo_token === 'string' ? row(input).undo_token as string : '';
  if (!token) throw deps.reject(400, '撤回凭据无效。');
  const { rows } = await deps.scope.query<{ fact: FactId }>(
    `SELECT r.fact_id AS fact FROM commands c JOIN fact_revs r ON (r.learner_id,r.command_id)=(c.learner_id,c.id)
     WHERE c.learner_id=$1 AND c.id=$2 AND c.type=$3 AND c.state='done' AND r.rev=1`,
    [deps.scope.learner, token, saveOwnWordsTakeawayCommand]);
  const id = rows[0]?.fact;
  if (!id) throw deps.reject(404, '找不到可撤回的口诀。');
  const current = await deps.read.fact(id, { mode: 'following' });
  if (current.type !== ownWordsClaimType || !isOwnWordsClaim(current.value)) throw deps.reject(404, '找不到可撤回的口诀。');
  const receipt = await deps.handle({ id: commandId(deps.stable('withdraw-own-words-takeaway', token)), type: withdrawOwnWordsTakeawayCommand, input: { id, token }, purpose: storagePurpose });
  if (receipt.state !== 'done') throw deps.reject(409, '口诀已撤回或版本已变化。');
  return { status: 'withdrawn', id };
}

type Mount = {
  paperId: FactId; paperRev: Revision; itemId: string;
  issuance: { id: FactId; rev: Revision };
  source: { paperId: FactId; attempt: { id: FactId; rev: Revision }; itemId: string };
};

function mountOf(input: unknown, paperId: FactId, reject: TakeawayReject): Mount {
  const value = row(input);
  const issuanceRow = value.issuance === undefined ? undefined : refOf(value.issuance);
  try {
    if (issuanceRow !== undefined && issuanceRow.id !== paperId) throw reject(400, '口诀发放与本次试卷不匹配。');
    return {
      paperId, paperRev: revOf(value.paperRev), itemId: itemIdOf(value.itemId),
      // Ordinary workbook content is frozen at revision 1; later revisions only
      // carry purpose grants, so the issuance anchor is always the first revision.
      issuance: { id: paperId, rev: 1 as Revision },
      source: {
        paperId: factId(typeof value.sourcePaperId === 'string' ? value.sourcePaperId : ''),
        attempt: refOf(value.sourceAttempt), itemId: itemIdOf(value.sourceItemId),
      },
    };
  } catch (error) { throw reject(400, error instanceof Error ? error.message : '口诀发放请求无效。'); }
}

/** Find the sticky own-words claim bound to this exact paper slot and source attempt. */
async function findTakeaway(deps: Deps, mount: Mount): Promise<FactSnapshot | undefined> {
  const { rows } = await deps.scope.query<{ id: FactId }>(
    `SELECT f.id FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,1)
     WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.kind='value'
       AND r.data->'scope'->'anchor'->>'paperId'=$3 AND r.data->'scope'->'anchor'->>'itemId'=$4
       AND r.data->'scope'->'basis' @> $5::jsonb`,
    [deps.scope.learner, ownWordsClaimType, mount.source.paperId, mount.source.itemId,
      JSON.stringify([{ id: mount.source.attempt.id }])]);
  for (const record of rows) {
    try {
      const fact = await deps.read.fact(record.id, { mode: 'following' });
      if (fact.type === ownWordsClaimType && isOwnWordsClaim(fact.value, undefined, mount.source.attempt.id, mount.source.paperId, mount.source.itemId))
        return fact;
    } catch (error) { if (!deps.unavailable(error)) throw error; }
  }
  return undefined;
}

function presentation(found: FactSnapshot, mount: Mount, kind: 'opened' | 'displayed'): HelpPresentation & { kind: 'opened' | 'displayed' } {
  return {
    kind,
    mount: { activityId: mount.issuance.id, issuance: mount.issuance, item: { itemId: mount.itemId } },
    alsoAppliesTo: [],
    // The sticky own-words claim is content-frozen at revision 1; later
    // revisions only carry purpose grants, so the recorded content anchor is rev 1.
    content: { id: found.ref.id, rev: 1 as Revision },
    step: { kind: 'hint_l0', order: 0 },
    learnerRequested: true,
  };
}

function openingId(deps: Deps, found: FactSnapshot, mount: Mount): FactId {
  return factId(deps.stable('own-words-open', found.ref.id, '1', mount.issuance.id, String(mount.issuance.rev), mount.itemId));
}

/** Learner taps 给点方向: resolve the own-words claim on the frozen slot and record an `opened` witness. */
export async function takeawayOpen(deps: Deps, paperId: FactId, input: unknown) {
  const mount = mountOf(input, paperId, deps.reject);
  const found = await findTakeaway(deps, mount);
  if (!found) throw deps.reject(404, '本题位没有本人自留口诀。');
  const openId = openingId(deps, found, mount);
  const receipt = await deps.handle(helpExposureRequest(openId, presentation(found, mount, 'opened')));
  if (receipt.state !== 'done') throw deps.reject(409, '口诀当前不可重开。');
  const text = (found.value as { text?: string }).text;
  return { kind: 'own-words', text: typeof text === 'string' ? text : '', displayRef: deps.sign(openId) };
}

/** After the frontend actually rendered it: verify displayRef + same issuance/slot, record `displayed`. */
export async function takeawayDisplay(deps: Deps, paperId: FactId, input: unknown) {
  const mount = mountOf(input, paperId, deps.reject);
  const expected = typeof row(input).displayRef === 'string' ? row(input).displayRef as string : '';
  const found = await findTakeaway(deps, mount);
  if (!found) throw deps.reject(404, '本题位没有本人自留口诀。');
  const openId = openingId(deps, found, mount);
  if (expected !== deps.sign(openId)) throw deps.reject(403, '口诀回执与本次发放不匹配。');
  const opened = await deps.read.fact(openId, { mode: 'following' }).catch((error: unknown) => {
    if (deps.unavailable(error)) return undefined;
    throw error;
  });
  const openedValue = opened?.value as (HelpPresentation & { kind: string }) | undefined;
  if (!opened || openedValue?.kind !== 'opened' || openedValue.mount.item.itemId !== mount.itemId ||
      openedValue.mount.issuance.id !== mount.issuance.id || openedValue.mount.issuance.rev !== mount.issuance.rev ||
      openedValue.content.id !== found.ref.id)
    throw deps.reject(403, '口诀回执与本次发放不匹配。');
  const displayId = factId(deps.stable('own-words-display', openId));
  const receipt = await deps.handle(helpExposureRequest(displayId, presentation(found, mount, 'displayed')));
  if (receipt.state !== 'done') throw deps.reject(409, '口诀展示见证未完成。');
  return { recorded: true, displayRef: expected };
}

/** Post-submission feedback read: reopen the learner's takeaway + scoring basis for (attempt, item).
 * `displayed` strictly before the recorded submission tick counts as `hinted`; opened/saved/post-submit
 * echoes never back-attribute pre-submit help. Revoked or unauthorized evidence is honestly omitted. */
export async function takeawayFeedback(deps: Deps, paperId: FactId, attemptId: FactId, itemId: string) {
  const submission = await deps.read.fact(attemptId, { mode: 'following' }).catch((error: unknown) => {
    if (deps.unavailable(error)) return undefined;
    throw error;
  });
  if (!submission || submission.type !== workbookAttemptType) throw deps.reject(404, '找不到这份作答。');
  const attempt = workbookAttempt(submission.value);
  if (attempt.paperId !== paperId) throw deps.reject(404, '作答与试卷不匹配。');
  const feedback = attempt.feedback.find(item => item.questionId === itemId);
  if (!feedback) throw deps.reject(404, '本题位没有评分依据。');
  const birth = await readActivitySubmissionBirth(deps.scope, submission.ref, workbookAttemptType);
  const mount: HelpTarget = {
    // Ordinary workbook content is frozen at revision 1; purpose grants add
    // later revisions without changing the issued questions.
    activityId: paperId, issuance: { id: paperId, rev: 1 as Revision }, item: { itemId },
  };
  let helpLevel: 'independent' | 'hinted' | 'unknown' = 'unknown';
  if (birth) {
    const { events, omitted } = await readActivityHelpEvents(deps.scope, deps.read, {
      activities: [paperId], cutoff: birth.tick, mode: 'following',
    }, undefined, deps.unavailable);
    const observed = projectHelpExposure({ submission: { ref: submission.ref, target: mount, cutoff: birth.tick }, events, coverage: null });
    // S11 fail-closed: only a proven exposure earns 'hinted', and only a proven
    // complete observation earns 'independent'; every other outcome stays 'unknown'.
    helpLevel = observed.kind === 'exposed' ? 'hinted'
      : observed.kind === 'unexposed' && !omitted ? 'independent' : 'unknown';
  }
  const claim = await findTakeaway(deps, {
    paperId, paperRev: submission.ref.rev, itemId, issuance: mount.issuance,
    source: { paperId, attempt: { id: attemptId, rev: submission.ref.rev }, itemId },
  });
  const text = claim === undefined ? undefined : (claim.value as { text?: string }).text;
  const conceptId = claim === undefined ? undefined : (claim.value as { scope?: { object?: string } }).scope?.object;
  return {
    itemId, result: feedback.result, expected: feedback.expected, explanation: feedback.explanation,
    helpLevel, ...(text === undefined ? {} : { text, takeawayRev: claim!.ref.rev, ...(conceptId ? { conceptId } : {}) }),
  };
}
