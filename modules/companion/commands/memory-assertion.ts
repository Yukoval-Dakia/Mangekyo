import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { manageMemoryAssertionCommand, memoryAssertionInput, memoryAssertionType } from '../memory-assertion.ts';

export default defineCommand({
  type: manageMemoryAssertionCommand,
  destructive: true,
  schema: { parse: memoryAssertionInput },
  async write(ctx, input): Promise<readonly FactWrite[]> {
    const { id, expectedRev } = input;
    if (expectedRev !== undefined) {
      const current = await ctx.read.fact(id, { mode: 'following' });
      if (current.type !== memoryAssertionType || current.ref.rev !== expectedRev)
        throw new Error('记忆类型或版本已变更。');
      if (input.action === 'retract') return [{ kind: 'retract', id, expectedRev }];
      if (input.action === 'teaching') {
        if (input.enabled === current.purpose.includes('teaching')) return [];
        return [{ kind: 'set_purpose', id, expectedRev,
          purpose: input.enabled ? ['storage', 'teaching'] : ['storage'] }];
      }
    }
    if (input.action !== 'save') throw new Error('管理记忆需要当前版本。');
    const evidence = [];
    for (const source of input.data.evidence) {
      const fact = await ctx.read.fact(source.id, { mode: 'following' });
      if (fact.type !== 'activity.workbookAttempt' || fact.ref.rev !== source.rev)
        throw new Error('记忆证据须使用当前原始作答版本。');
      evidence.push({ ...source, accessEpoch: fact.accessEpoch });
    }
    const data = { ...input.data, evidence };
    return [expectedRev === undefined ? { kind: 'create', id, factType: memoryAssertionType, data }
      : { kind: 'correct', id, expectedRev, data }];
  },
});
