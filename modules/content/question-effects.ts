import type { DerivationId, EffectReceipt, EffectRequest, GatherInput, Json, JsonObject } from '@mangekyo/kernel';

export type SealedQuestionEffects = { readonly id: DerivationId; readonly plan: GatherInput<Json> };

/** The host takes the owner from the effect ledger. The sealed candidate is the ledger owner. */
export type QuestionEffectReceipt = EffectReceipt & { readonly ownerId: DerivationId };

/** Wrap the provider result inside the ledger callback with its actual invocation ID. */
export function questionEffectResult(invocationId: string, result: Json): JsonObject {
  return { invocationId, result };
}

export function jsonObject(value: Json | undefined): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function sameEffectInput(left: Json, right: Json): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameEffectInput(value, right[index]!));
  }
  return jsonObject(left) && jsonObject(right) && Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([key, value]) => Object.hasOwn(right, key) && sameEffectInput(value, right[key]!));
}

export function readQuestionEffect(ownerId: DerivationId, expected: EffectRequest, receipt: QuestionEffectReceipt | undefined) {
  if (!receipt?.request || receipt.ownerId !== ownerId || receipt.request.stepKey !== expected.stepKey ||
      receipt.request.label !== expected.label || !sameEffectInput(receipt.request.input, expected.input)) {
    return { kind: 'invalid' as const, reason: '效果回执与封存请求不一致。' };
  }
  if (receipt.state !== 'done' || !jsonObject(receipt.result)) {
    return { kind: 'invalid' as const, reason: '效果尚无确定回执。' };
  }
  const { invocationId, result } = receipt.result;
  if (typeof invocationId !== 'string' || !invocationId || invocationId.trim() !== invocationId || result === undefined) {
    return { kind: 'invalid' as const, reason: '效果缺少服务端调用身份或结果。' };
  }
  return { kind: 'done' as const, invocationId, result };
}
