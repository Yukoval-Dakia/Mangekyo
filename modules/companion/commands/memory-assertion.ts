import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { manageMemoryAssertionCommand, memoryAssertionInput, memoryAssertionType } from '../memory-assertion.ts';

import { extractedUnderstanding } from '../understanding.ts';
import { claimId, claimRecord, claimRef, ClaimInputError, claimText } from '../claim.ts';

export default defineCommand({
  type: manageMemoryAssertionCommand,
  destructive: true,
  schema: { parse(value: unknown) {
    const input = claimRecord(value);
    if (input.action === 'undo-extracted') return {action: 'undo-extracted' as const,
      id: claimId(input.id), expectedRev: undefined, token: claimId(input.token)};
    if (input.action === 'forget-extracted') {
      const expected = claimRef(input);
      return {action: 'forget-extracted' as const, id: expected.id, expectedRev: expected.rev, accessEpoch: expected.accessEpoch};
    }
    if (input.action === 'correct-extracted') {
      const expected = claimRef(input);
      return {action: 'correct-extracted' as const, id: claimId(input.id), expectedRev: expected.rev,
        accessEpoch: expected.accessEpoch, text: claimText(input.text, 600).trim()};
    }
    return memoryAssertionInput(value);
  } },
  async write(ctx, input): Promise<readonly FactWrite[]> {
    const { id, expectedRev } = input;
    if (input.action === 'undo-extracted') {
      const current = await ctx.read.fact(id, {mode: 'following'});
      if (current.type !== memoryAssertionType) throw new ClaimInputError('理解类型已变化。');
      const data = extractedUnderstanding(current.value);
      if (data.sticky || data.undo_token !== input.token) throw new ClaimInputError('理解已由本人修改。');
      return [{kind: 'retract', id, expectedRev: current.ref.rev}];
    }
    if (expectedRev !== undefined) {
      const current = await ctx.read.fact(id, { mode: 'following' });
      if (current.type !== memoryAssertionType || current.ref.rev !== expectedRev)
        throw new ClaimInputError('记忆类型或版本已变更。');
      if (input.action === 'correct-extracted' || input.action === 'forget-extracted') {
        const prior = extractedUnderstanding(current.value);
        if (current.accessEpoch !== input.accessEpoch) throw new ClaimInputError('理解用途已变更。');
        if (input.action === 'forget-extracted') return [{kind: 'retract', id, expectedRev}];
        return [{kind: 'correct', id, expectedRev, data: {...prior, text: input.text, sticky: true}}];
      }
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
