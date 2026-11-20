import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { editSequence, fields, list, pageId, record, text } from '../parse.ts';
import { checkTextbookBasis, parseTextbookPage, requireTextbookBodyBasis, textbookPageType, verifyTextbookBodyReference } from '../textbook-page.ts';

export default defineCommand({
  type: 'content.createTextbookPage',
  destructive: false,
  schema: {
    parse(input: unknown) {
      const value = record(input);
      fields(value, 'id', 'clientEditSeq', 'purpose', 'page');
      const purpose = value.purpose === undefined
        ? ['storage']
        : list(value.purpose).map(entry => text(entry, '用途'));
      if (!purpose.length || new Set(purpose).size !== purpose.length) throw new Error('教材用途无效。');
      return { id: pageId(value.id), clientEditSeq: editSequence(value.clientEditSeq), purpose, page: parseTextbookPage(value.page) };
    },
  },
  write: async (ctx, input): Promise<readonly FactWrite[]> => {
    if (input.page.basis) await checkTextbookBasis(ctx.read, input.page.basis);
    for (const block of input.page.blocks) {
      if (input.page.basis) requireTextbookBodyBasis(block.body, input.page.basis);
      await verifyTextbookBodyReference(ctx, block.body);
    }
    return [{ kind: 'create', id: input.id, factType: textbookPageType, data: input.page, purpose: input.purpose }];
  },
});
