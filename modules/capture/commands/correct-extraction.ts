import { defineCommand } from '@mangekyo/kernel';
import { extractionAnchor, extractionTarget } from '../extraction.ts';
import { captureText } from '../parse.ts';
import { captureSourceType, sourceEnvelope, type Block } from '../source.ts';

export default defineCommand({
  type: 'capture.correctExtraction',
  destructive: true,
  schema: { parse(input: unknown) {
    const { target, row } = extractionTarget(input);
    return { target, blockId: captureText(row.blockId, '块标识', 200), ...(row.anchor === undefined ? {} : { anchor: row.anchor }), text: captureText(row.text, '更正文字', 2_000_000, true) };
  } },
  async write(ctx, { target: { id, rev }, blockId, anchor, text }) {
    const fact = await ctx.read.fact(id, { mode: 'following' });
    if (fact.type !== captureSourceType || fact.ref.rev !== rev) throw new Error('原件版本已变更。');
    const source = sourceEnvelope(fact.value);
    const block = extractionAnchor(source, blockId, anchor);
    if (!block || source.kind === 'notion') throw new Error('找不到可以更正的块。');
    const { kind, layer, itemId, slotId, crop_ref } = block.body;
    const correction: Block = { ...block, body: {
      kind, layer, ...(itemId ? { itemId } : {}), ...(slotId ? { slotId } : {}), ...(crop_ref ? { crop_ref } : {}),
      status: 'known', text, author: 'learner', sticky: true,
    } };
    const blocks = source.unit.blocks.some(entry => entry.id === blockId)
      ? source.unit.blocks.map(block => block.id === blockId ? correction : block)
      : [...source.unit.blocks, correction];
    return [{ kind: 'correct', id, expectedRev: rev, data: { ...source, unit: { ...source.unit, blocks } } }];
  },
});
