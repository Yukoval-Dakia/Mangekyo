import type { DerivationId, EffectReceipt, EffectRequest, GatherInput, Json, JsonObject } from '@mangekyo/kernel';

export type SealedQuestionEffects = { readonly id: DerivationId; readonly plan: GatherInput<Json> };

/** The host takes the owner from the effect ledger. The sealed candidate is the ledger owner. */
export type QuestionEffectReceipt = EffectReceipt & { readonly ownerId: DerivationId };

export const verificationSteps = [
  { stepKey: 'solve-1', label: 'question-independent-solve' },
  { stepKey: 'solve-2', label: 'question-independent-solve' },
  { stepKey: 'solve-3', label: 'question-independent-solve' },
  { stepKey: 'contract', label: 'question-contract-validation' },
] as const;

export type QuestionExecution = {
  readonly kind: 'local_wasm';
  readonly moduleDigest: string;
  readonly executableDigest: string;
  readonly feeMicroUsd: 0;
};

export function readQuestionExecution(value: Json | undefined): QuestionExecution | undefined {
  if (!jsonObject(value)) return undefined;
  const {kind, moduleDigest, executableDigest, feeMicroUsd} = value;
  const digest = (input: Json | undefined): input is string => typeof input === 'string' && /^[0-9a-f]{64}$/.test(input);
  if (Object.keys(value).length !== 4 || kind !== 'local_wasm' || feeMicroUsd !== 0 ||
      !digest(moduleDigest) || !digest(executableDigest)) return undefined;
  return {kind, moduleDigest, executableDigest, feeMicroUsd};
}

export function independentQuestionExecutions(values: readonly Json[] | undefined) {
  if (!Array.isArray(values) || values.length !== verificationSteps.length) return false;
  const parsed = values.map(readQuestionExecution);
  return parsed.every(Boolean) && new Set(parsed.map(value => value?.executableDigest)).size === values.length;
}

export function bindQuestionExecution(request: EffectRequest, execution: QuestionExecution): EffectRequest {
  if (!jsonObject(request.input)) throw new Error('验题请求格式无效。');
  return {...request, input: {...request.input, execution}};
}

export function matchesQuestionExecution(request: EffectRequest, execution: QuestionExecution) {
  return jsonObject(request.input) && request.input.execution !== undefined &&
    sameEffectInput(request.input.execution, execution);
}

/** Wrap the provider result inside the ledger callback with its actual invocation ID. */
export function questionEffectResult(invocationId: string, result: Json): JsonObject {
  return { invocationId, result };
}

/** The verification host records the module it invoked apart from the solver output. */
export function questionVerificationEffectResult(invocationId: string, result: Json, execution: QuestionExecution): JsonObject {
  return { ...questionEffectResult(invocationId, result), execution };
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
  return { kind: 'done' as const, invocationId, result, envelope: receipt.result };
}

export function readQuestionVerificationEffect(ownerId: DerivationId, expected: EffectRequest, receipt: QuestionEffectReceipt | undefined) {
  const checked = readQuestionEffect(ownerId, expected, receipt);
  if (checked.kind !== 'done') return checked;
  const execution = readQuestionExecution(checked.envelope.execution);
  if (!execution || !matchesQuestionExecution(expected, execution))
    return { kind: 'invalid' as const, reason: '效果回执未绑定封存的实际核验方。' };
  return { kind: 'done' as const, invocationId: checked.invocationId, result: checked.result, execution };
}
