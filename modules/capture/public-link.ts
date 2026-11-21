import { commandId, learnerId, type EffectReceipt, type EffectRequest, type FactSnapshot,
  type GatherContext, type GatherInput, type Outcome, type ReadContext } from '@mangekyo/kernel';
import { captureObject, captureRef, captureText } from './parse.ts';
import { captureSourceType, sourceEnvelope } from './source.ts';

export const publicLinkSlot = 'capture.publicLink';
export const publicLinkDeriver = 'capture/public-link-v1';
export const publicLinkVersion = 'public-link-v1';
export const publicLinkEffect = 'capture.readPublicLink';
export const publicLinkTextLimit = 2_000_000;

function parseRequest(input: unknown) {
  const row = captureObject(input);
  if (row.intent !== 'read-link' || (row.purpose !== 'learning' && row.purpose !== 'teaching')) {
    throw new Error('读取链接须由学习者明确请求并获准学习使用。');
  }
  const accessEpoch = captureText(row.accessEpoch, '访问代次', 32);
  if (!/^(?:0|[1-9][0-9]*)$/.test(accessEpoch)) throw new Error('访问代次无效。');
  return {
    intent: row.intent,
    learner: learnerId(captureText(row.learner, '学习者标识', 26)),
    requestId: commandId(captureText(row.requestId, '读取请求标识', 26)),
    target: captureRef(row.target), accessEpoch, purpose: row.purpose,
    recipient: captureText(row.recipient, '链接接收方标识', 200),
  } as const;
}

export type PublicLinkReadRequest = ReturnType<typeof parseRequest>;
export type PublicLinkSourceResolver = (basis: PublicLinkReadRequest) => Promise<FactSnapshot | null>;

export function publicLinkWorkKey(input: PublicLinkReadRequest) {
  return parseRequest(input).requestId;
}

function sourceUrl(fact: FactSnapshot | null, request: PublicLinkReadRequest) {
  if (fact?.type !== captureSourceType || fact.ref.learner !== request.learner ||
      fact.ref.id !== request.target.id || fact.ref.rev !== request.target.rev ||
      fact.accessEpoch !== request.accessEpoch || !fact.purpose.includes(request.purpose)) return null;
  const source = sourceEnvelope(fact.value);
  return source.kind === 'url' ? source.url ?? null : null;
}

function effect(basis: PublicLinkReadRequest) {
  return { label: publicLinkEffect, stepKey: publicLinkVersion, input: basis };
}

export async function gatherPublicLink(ctx: GatherContext, input: PublicLinkReadRequest): Promise<GatherInput<PublicLinkReadRequest>> {
  const basis = parseRequest(input);
  if (ctx.learner !== basis.learner || !sourceUrl(await ctx.read.fact(basis.target.id, { mode: 'following' }), basis)) {
    throw new Error('链接原件版本或读取用途已变更。');
  }
  return { kind: 'input', data: basis, effects: [effect(basis)] };
}

export type PublicLinkResponse =
  | { readonly status: 'readable'; readonly text: string }
  | { readonly status: 'restricted' | 'unreadable' | 'failed' };

export type PublicLinkResult = PublicLinkResponse | { readonly status: 'unauthorized' | 'unavailable' };

export type PublicLinkTransport = {
  readonly recipient: string;
  // The host must screen the actual address at connection time, block redirects
  // and restricted destinations, and send an anonymous, bounded read only.
  // Start the send under the host's dispatch fence with a fresh check of the
  // explicit action, source, and recipient. Retry/replay uses the same effect ID.
  // `readable` means extracted body text from this response. Login, paywall,
  // and verification pages are `restricted`. A title alone is `unreadable`.
  readPublicText(url: string): Promise<PublicLinkResponse>;
};

function parseResult(value: unknown): PublicLinkResult {
  try {
    const row = captureObject(value);
    switch (row.status) {
      case 'readable':
        return typeof row.text !== 'string' || !row.text.trim() ? { status: 'unreadable' } :
          { status: 'readable', text: captureText(row.text, '链接正文', publicLinkTextLimit) };
      case 'restricted': case 'unreadable': case 'failed': case 'unauthorized': case 'unavailable':
        return { status: row.status };
      default: return { status: 'failed' };
    }
  } catch {
    return { status: 'failed' };
  }
}

function effectBasis(request: EffectRequest) {
  if (request.label !== publicLinkEffect || request.stepKey !== publicLinkVersion) throw new Error('链接读取请求无效。');
  return parseRequest(request.input);
}

async function authorizedUrl(basis: PublicLinkReadRequest, resolveAuthorizedSource: PublicLinkSourceResolver) {
  try { return sourceUrl(await resolveAuthorizedSource(basis), basis); }
  catch { return null; }
}

/** Invoke only through the host's effect runner. Resolve the original learner
 * action and actual recipient's live permission at dispatch and again after
 * the read. The resolver must consult the trusted user action, not the effect
 * input as proof of consent, and return the current authorized source fact. */
export async function consumePublicLink(
  request: EffectRequest,
  resolveAuthorizedSource: PublicLinkSourceResolver,
  transport?: PublicLinkTransport,
): Promise<PublicLinkResult> {
  const basis = effectBasis(request);
  if (transport && transport.recipient !== basis.recipient) return { status: 'unauthorized' };
  const url = await authorizedUrl(basis, resolveAuthorizedSource);
  if (!url) return { status: 'unauthorized' };
  if (!transport) return { status: 'unavailable' };
  const destination = new URL(url);
  destination.hash = '';
  let result: PublicLinkResult;
  try { result = parseResult(await transport.readPublicText(destination.href)); }
  catch { result = { status: 'failed' }; }
  return (await authorizedUrl(basis, resolveAuthorizedSource)) === url ? result : { status: 'unauthorized' };
}

export type PublicLinkValue = {
  readonly basis: PublicLinkReadRequest;
  readonly result: PublicLinkResult;
};

export function settlePublicLink(basis: PublicLinkReadRequest, receipts: readonly EffectReceipt[]): Outcome<PublicLinkValue> {
  const [receipt] = receipts;
  if (receipts.length !== 1 || receipt?.state !== 'done') return { kind: 'unknown', reason: '链接读取结果尚未确认。' };
  try {
    const expected = parseRequest(basis);
    if (JSON.stringify(effectBasis(receipt.request)) === JSON.stringify(expected)) {
      return { kind: 'value', value: { basis: expected, result: parseResult(receipt.result) } };
    }
  } catch { /* Invalid or mismatched receipt. */ }
  return { kind: 'unknown', reason: '链接读取回执与请求不匹配。' };
}

/** Both readers run in the current caller's authorized scope. The resolver
 * verifies the original action and the actual recipient, even on replay. */
export async function openPublicLink(read: ReadContext, request: PublicLinkReadRequest,
  resolveAuthorizedSource: PublicLinkSourceResolver) {
  const basis = parseRequest(request);
  const authorized = await authorizedUrl(basis, resolveAuthorizedSource);
  if (!authorized) throw new Error('无法确认读取链接的当前授权。');
  const fact = await read.fact(basis.target.id, { mode: 'following' });
  const url = sourceUrl(fact, basis);
  if (url !== authorized) throw new Error('链接原件版本或读取用途已变更。');
  const { outcome } = await read.slot<PublicLinkValue>(
    { learner: basis.learner, type: publicLinkSlot, key: publicLinkWorkKey(basis) }, { mode: 'following' },
  );
  if (outcome.kind === 'unknown') return outcome;
  if (JSON.stringify(parseRequest(outcome.value.basis)) !== JSON.stringify(basis)) {
    throw new Error('链接读取结果与请求不匹配。');
  }
  return { kind: 'value' as const, source: fact.ref, url, result: outcome.value.result };
}
