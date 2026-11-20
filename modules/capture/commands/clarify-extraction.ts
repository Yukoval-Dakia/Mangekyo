import { defineCommand } from '@mangekyo/kernel';
import { cropKey, extractionAnchor, extractionTarget } from '../extraction.ts';
import { captureText } from '../parse.ts';
import { captureSourceType, sourceEnvelope, type Block } from '../source.ts';

export default defineCommand({
  type: 'capture.clarifyExtraction',
  destructive: true,
  schema: { parse(input: unknown) {
    const { target, row } = extractionTarget(input);
    return { target, blockId: captureText(row.blockId, '块标识', 200), ...(row.anchor === undefined ? {} : { anchor: row.anchor }) };
  } },
  async write(ctx, { target: { id, rev }, blockId, anchor }) {
    const fact = await ctx.read.fact(id, { mode: 'following' });
    if (fact.type !== captureSourceType || fact.ref.rev !== rev) throw new Error('原件版本已变更。');
    const source = sourceEnvelope(fact.value);
    const block = extractionAnchor(source, blockId, anchor);
    if (!block || block.body.status !== 'unknown' || block.body.clarification === 'asked') return [];
    const key = cropKey(block);
    if (source.unit.blocks.some(entry => cropKey(entry) === key &&
        entry.body.status === 'unknown' && entry.body.clarification === 'asked')) return [];
    const entries = source.unit.blocks.some(entry => entry.id === blockId) ? source.unit.blocks : [...source.unit.blocks, block];
    const blocks: Block[] = entries.map(entry => cropKey(entry) === key && entry.body.status === 'unknown'
      ? { ...entry, body: { ...entry.body, clarification: 'asked' } } : entry);
    return [{ kind: 'correct', id, expectedRev: rev, data: { ...source, unit: { ...source.unit, blocks } } }];
  },
});
