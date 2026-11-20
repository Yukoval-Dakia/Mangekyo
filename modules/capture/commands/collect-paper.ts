import { FactNotFoundError, defineCommand, factId, type FactSnapshot } from '@mangekyo/kernel';
import { captureObject, captureRef, captureText } from '../parse.ts';
import { defaultPaperRunId, paperIssuance, paperIssuanceType, paperRun, paperRunType, projectIssuedPaper } from '../paper.ts';
import { captureSourceType, sourceEnvelope } from '../source.ts';

export default defineCommand({
  type: 'capture.collectPaper',
  destructive: true,
  schema: { parse(input: unknown) {
    const row = captureObject(input);
    return {
      issuanceId: factId(captureText(row.issuanceId, '发卷标识', 26)),
      source: captureRef(row.source),
      page: row.page,
      original: row.original,
      ...(row.retryId === undefined ? {} : { retryId: factId(captureText(row.retryId, '再做标识', 26)) }),
    };
  } },
  async write(ctx, { issuanceId, source, page, original, retryId }) {
    const issuance = await ctx.read.fact(issuanceId, { mode: 'following' });
    if (issuance.type !== paperIssuanceType) throw new Error('没有匹配的发卷。');
    const printed = await projectIssuedPaper(ctx.read, paperIssuance(issuance.value));
    if (printed.issuanceId !== issuanceId) throw new Error('发卷标识不匹配。');
    const fact = await ctx.read.fact(source.id, { mode: 'pinned', rev: source.rev });
    if (fact.type !== captureSourceType) throw new Error('回收图片必须来自原件。');
    const captured = sourceEnvelope(fact.value);
    if (captured.kind !== 'paper-return' || !printed.pages.some(p => p.number === page) ||
        typeof original !== 'number' || !Number.isSafeInteger(original) || original < 0 || !captured.originals[original])
      throw new Error('回收图片或页码无效。');
    const hash = captured.originals[original].sha256;
    const entry = { number: page, source, original, hash };
    const defaultId = await defaultPaperRunId(issuanceId);
    if (retryId === defaultId) throw new Error('再做须使用新的标识。');
    const id = retryId ?? defaultId;
    let run: FactSnapshot;
    try {
      run = await ctx.read.fact(id, { mode: 'following' });
    } catch (error) {
      if (!(error instanceof FactNotFoundError)) throw error;
      return [{ kind: 'create', id, factType: paperRunType, data: paperRun({ issuanceId, pages: [entry] }), purpose: ['storage'] }];
    }
    if (run.type !== paperRunType) throw new Error('回收标识已被使用。');
    const prior = paperRun(run.value);
    if (prior.issuanceId !== issuanceId) throw new Error('回收与发卷不匹配。');
    const priorPage = prior.pages.find(p => p.number === page || p.hash === hash);
    if (priorPage?.hash === hash && priorPage.number === page) return [];
    if (priorPage) throw new Error('回收页已存在，请确认原页或另起一次作答。');
    return [{ kind: 'correct', id, expectedRev: run.ref.rev, data: paperRun({ issuanceId, pages: [...prior.pages, entry] }) }];
  },
});
