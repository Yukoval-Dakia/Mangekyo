import { factId, type FactId, type Revision, type Tick } from '@mangekyo/kernel';

export const claimType = 'companion.claim';
export const applyClaimCommand = 'companion.applyExplicitClaim';
export class ClaimTargetError extends Error {}
type ClaimAction = { action: 'remember' | 'correct'; text: string; teaching: boolean; target?: FactId } |
  { action: 'forget'; target: FactId };

// This syntax denotes a direct learner action. Embedded or reported speech stays in conversation.
export function explicitClaimRequest(quote: string): ClaimAction | undefined {
  if (!quote.isWellFormed() || quote.includes('\0') || quote.length > 900) return;
  const remember = /^记住(并用于教学)?[：:][ \t]*(\S[^\r\n]*)$/u.exec(quote);
  if (remember) return { action: 'remember', text: remember[2]!.trim(), teaching: Boolean(remember[1]) };
  const correct = /^纠正(并用于教学)? +([0-9A-HJKMNP-TV-Z]{26})[：:][ \t]*(\S[^\r\n]*)$/u.exec(quote);
  if (correct) return { action: 'correct', text: correct[3]!.trim(), teaching: Boolean(correct[1]), target: factId(correct[2]!) };
  const forget = /^忘掉 +([0-9A-HJKMNP-TV-Z]{26})$/u.exec(quote);
  if (forget) return { action: 'forget', target: factId(forget[1]!) };
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claim 格式无效。');
  return value as Record<string, unknown>;
}

function idOf(value: unknown): FactId {
  if (typeof value !== 'string') throw new Error('Claim 标识无效。');
  return factId(value);
}

function refOf(value: unknown) {
  const ref = record(value);
  if (typeof ref.rev !== 'number' || !Number.isSafeInteger(ref.rev) || ref.rev < 1 ||
      typeof ref.accessEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(ref.accessEpoch)) throw new Error('Claim 缺少来源见证。');
  return { id: idOf(ref.id), rev: ref.rev as Revision, accessEpoch: ref.accessEpoch as Tick };
}

export function claimInput(input: unknown) {
  const { id, source, quote } = record(input);
  if (typeof quote !== 'string' || !explicitClaimRequest(quote)) throw new Error('Claim 缺少本人原话。');
  return { id: idOf(id), source: refOf(source), quote };
}

export function claimValue(input: unknown) {
  const { quote, source, supersedes } = record(input);
  const action = typeof quote === 'string' ? explicitClaimRequest(quote) : undefined;
  if (!action || typeof quote !== 'string') throw new Error('Claim 缺少本人原话。');
  const predecessor = supersedes === null ? null : refOf(supersedes);
  if ((predecessor?.id ?? null) !== (action.target ?? null)) throw new Error('Claim 的 supersedes 与原话不符。');
  return { quote, source: refOf(source), supersedes: predecessor };
}
