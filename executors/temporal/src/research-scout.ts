const maxReplyBytes = 8192;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/;

/** Trusted host. The route versions both the recipient and its dispatch/pricing policy. */
export type ResearchScoutHost = Readonly<{
  route: string;
  reserveUsdMicros: number;
  retentionDays: number;
  /** Start one bounded dispatch synchronously. Enforce the quoted hard cap and do not retry. */
  sample(input: {
    providerEffectId: string;
    prompt: string;
    maxOutputTokens: number;
    reserveUsdMicros: number;
  }, signal: AbortSignal): Promise<{ reply: string; actualUsdMicros?: number; servedModel?: string }>;
}>;

export function validateResearchScoutHost(host: ResearchScoutHost) {
  if (!host || typeof host.route !== 'string' || !identifier.test(host.route) ||
      !Number.isSafeInteger(host.reserveUsdMicros) || host.reserveUsdMicros <= 0 ||
      typeof host.sample !== 'function')
    throw new Error('前哨宿主须声明版本化服务标识、正数 USD 微元硬上限、留存天数与采样函数。');
  // A previously installed host without a retention policy can keep serving local research.
  if (host.retentionDays === undefined) return undefined;
  if (!Number.isSafeInteger(host.retentionDays) || host.retentionDays < 0)
    throw new Error('前哨宿主的留存天数无效。');
  return host;
}

export function scoutReceipt(receipt: Awaited<ReturnType<ResearchScoutHost['sample']>>,
  reserveUsdMicros: number, parse: (reply: string) => string) {
  const reported = receipt?.actualUsdMicros;
  const cost = typeof reported === 'number' && Number.isSafeInteger(reported) && reported >= 0 ? reported : null;
  const decision = cost !== null && cost > reserveUsdMicros ? 'price_exceeded'
    : typeof receipt?.reply === 'string' && Buffer.byteLength(receipt.reply) <= maxReplyBytes
      ? parse(receipt.reply) : 'invalid_reply';
  return {
    decision,
    actualUsdMicros: cost,
    servedModel: typeof receipt?.servedModel === 'string' && identifier.test(receipt.servedModel)
      ? receipt.servedModel : null,
  };
}
