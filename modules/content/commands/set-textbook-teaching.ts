import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { fields, pageId, record, revision } from '../parse.ts';
import { textbookPageType } from '../textbook-page.ts';

export default defineCommand({
  type: 'content.setTextbookTeaching',
  destructive: true,
  schema: {
    parse(input: unknown) {
      const value = record(input);
      fields(value, 'id', 'expectedRev', 'enabled');
      if (typeof value.enabled !== 'boolean') throw new Error('教材教学用途开关无效。');
      return { id: pageId(value.id), expectedRev: revision(value.expectedRev), enabled: value.enabled };
    },
  },
  async write(ctx, { id, expectedRev, enabled }): Promise<readonly FactWrite[]> {
    const current = await ctx.read.fact(id, { mode: 'following' });
    if (current.type !== textbookPageType) throw new Error('目标事实不是教材页。');
    if (current.ref.rev !== expectedRev) throw new Error(`Fact revision conflict: ${id}`);
    if (current.purpose.includes('all')) throw new Error('请先明确教材的其他用途。');
    if (current.purpose.includes('teaching') === enabled) return [];
    const purpose = enabled ? [...current.purpose, 'teaching'] : current.purpose.filter(value => value !== 'teaching');
    return [{ kind: 'set_purpose', id, expectedRev, purpose: purpose.length ? purpose : ['storage'] }];
  },
});
