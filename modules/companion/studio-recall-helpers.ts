// Pure helpers extracted from runtime/studio/recall.ts.
// All tx, read context, command handle, notion scope stay in the runtime host;
// this module owns ids, mount validation, and error translation only.

import type { FactId, Revision } from '@mangekyo/kernel';

export const firstRecallRevision = 1 as Revision;

export type RecallRequestErrorCtor = new (status: number, message: string) => Error;

export type RecallErrorClassifier = {
  isReadDenied: (e: unknown) => boolean;
  isNotFound: (e: unknown) => boolean;
};

export function recallItemIdFor(
  factId: (v: string) => FactId,
  stableId: (...p: string[]) => string,
  turnId: string,
  version: string,
  position: number,
): FactId {
  return factId(stableId('recall-item', turnId, version, String(position)));
}

export function recallIssuanceRefFor(
  factId: (v: string) => FactId,
  stableId: (...p: string[]) => string,
  mount: { turnId: FactId; derivationId: unknown },
): { id: FactId; rev: Revision } {
  return {
    id: factId(stableId('recall-issuance', mount.turnId as string, mount.derivationId as string)),
    rev: firstRecallRevision,
  };
}

export function recallRevealIdFor(
  factId: (v: string) => FactId,
  stableId: (...p: string[]) => string,
  requestId: string,
): FactId {
  return factId(stableId('recall-reveal', requestId));
}

export function recallDisplayIdFor(
  factId: (v: string) => FactId,
  stableId: (...p: string[]) => string,
  revealId: FactId,
): FactId {
  return factId(stableId('recall-display', revealId));
}

export function recallSubmissionIdFor(
  factId: (v: string) => FactId,
  stableId: (...p: string[]) => string,
  requestId: string,
): FactId {
  return factId(stableId('recall-submission', requestId));
}

export function parseRecallInput<T>(RequestError: RecallRequestErrorCtor, parse: () => T): T {
  try { return parse(); }
  catch { throw new RequestError(400, '回忆题请求格式无效。'); }
}

export function mountedRecallItem<Issuance, Mount, Item>(
  RequestError: RecallRequestErrorCtor,
  recallMountedItem: (issuance: Issuance, mount: Mount) => Item | undefined,
  issuance: Issuance,
  mount: Mount,
): Item {
  const item = recallMountedItem(issuance, mount);
  if (!item) throw new RequestError(404, '回忆题与此回合版本不匹配。');
  return item;
}

export async function authorizedRecall<T>(
  RequestError: RecallRequestErrorCtor,
  classifier: RecallErrorClassifier,
  read: () => Promise<T>,
): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (classifier.isReadDenied(error)) throw new RequestError(403, '回忆题依据已不可读。');
    if (classifier.isNotFound(error)) throw new RequestError(404, '找不到回忆题记录。');
    throw error;
  }
}

export async function optionalPinnedFact<F>(
  classifier: Pick<RecallErrorClassifier, 'isNotFound'>,
  read: () => Promise<F>,
): Promise<F | null> {
  try { return await read(); }
  catch (error) {
    if (classifier.isNotFound(error)) return null;
    throw error;
  }
}

export function writtenRecallRef<Receipt extends { wrote: readonly unknown[]; state: string }>(
  RequestError: RecallRequestErrorCtor,
  receipt: Receipt,
): NonNullable<Receipt['wrote'][number]> {
  const ref = receipt.wrote[0];
  if (receipt.state !== 'done' || !ref) throw new RequestError(409, '此回忆题操作已失效。');
  return ref as NonNullable<Receipt['wrote'][number]>;
}

export function isRecallCommandIdentityConflict(error: unknown): boolean {
  return error instanceof Error && error.message === 'Command ID already used with a different command identity';
}

export function recallSourceUnavailable(E: RecallRequestErrorCtor) { return new E(404, '此回合没有可用的回忆题版本。'); }
export function recallTeachingBasisChanged(E: RecallRequestErrorCtor) { return new E(409, '回忆题的教学依据已变化。'); }
export function recallOriginalTurnChanged(E: RecallRequestErrorCtor) { return new E(409, '回忆题的原回合已变化。'); }
export function recallMaterialsAuthorizationChanged(E: RecallRequestErrorCtor) { return new E(403, '回忆题材料的授权已变化。'); }
export function recallNotIssuedYet(E: RecallRequestErrorCtor) { return new E(404, '这道回忆题尚未发放。'); }
export function recallCommandConflict(E: RecallRequestErrorCtor) { return new E(409, '同一请求标识已用于不同回忆题操作。'); }
export function recallNoStudyKit(E: RecallRequestErrorCtor) { return new E(404, '此回合没有可用的回忆题。'); }
export function recallAttachmentUnlinked(E: RecallRequestErrorCtor) { return new E(409, '本轮选段已无法对应到授权原文。'); }
export function recallSubmissionNotConfirmed(E: RecallRequestErrorCtor) { return new E(409, '回忆题交答尚未确认。'); }
export function recallDisplayWitnessMissing(E: RecallRequestErrorCtor) { return new E(403, '缺少可信的回忆题显示回执。'); }
export function recallDisplayMismatch(E: RecallRequestErrorCtor) { return new E(409, '显示回执与获准揭示的题项不匹配。'); }
export function recallIssuanceIdentityInvalid() { return new Error('Invalid Recall issuance identity'); }
