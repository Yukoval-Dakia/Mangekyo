import { defineCommand } from '@mangekyo/kernel';
import { extractedBlocks, extractionTarget, mergeExtraction } from '../extraction.ts';
import { captureSourceType, sourceEnvelope } from '../source.ts';

export default defineCommand({
  type: 'capture.applyExtraction',
  destructive: true,
  schema: { parse(input: unknown) {
    const { target, row } = extractionTarget(input);
    if (!Array.isArray(row.blocks)) throw new Error('缺少分层抽取块。');
    return { target, blocks: row.blocks };
  } },
  async write(ctx, input) {
    const { id, rev } = input.target;
    const fact = await ctx.read.fact(id, { mode: 'following' });
    if (fact.type !== captureSourceType || fact.ref.rev !== rev) throw new Error('原件版本已变更。');
    if (!fact.purpose.some(purpose => purpose === 'teaching' || purpose === 'learning'))
      throw new Error('原件未获准学习使用。');
    const source = sourceEnvelope(fact.value);
    if (source.kind !== 'photo' && source.kind !== 'pdf' && source.kind !== 'paper-return')
      throw new Error('分层抽取需要卷面原件。');
    const blocks = mergeExtraction(source, extractedBlocks(source, input.blocks));
    if (JSON.stringify(blocks) === JSON.stringify(source.unit.blocks)) return [];
    return [{ kind: 'correct', id, expectedRev: rev, data: sourceEnvelope({ ...source, unit: { ...source.unit, blocks } }) }];
  },
});
