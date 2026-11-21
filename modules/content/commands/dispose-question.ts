import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { assetType, questionAsset } from '../asset.ts';
import { fields, pageId, record, revision } from '../parse.ts';
import { parseQuestionDisposition, readQuestionState } from '../question-state.ts';

export default defineCommand({
  type: 'content.disposeQuestion',
  destructive: true,
  schema: { parse(input: unknown) {
    const value = record(input);
    fields(value, 'id', 'expectedRev', 'stateRev', 'disposition');
    return { id: pageId(value.id), expectedRev: revision(value.expectedRev),
      stateRev: revision(value.stateRev), disposition: parseQuestionDisposition(value.disposition),
    };
  } },
  async write(ctx, { id, expectedRev, stateRev, disposition }): Promise<readonly FactWrite[]> {
    const question = await ctx.read.fact(id, { mode: 'following' });
    if (question.type !== assetType || question.ref.rev !== expectedRev) throw new Error('题目基版已变化。');
    questionAsset(question.value);
    const { snapshot, state } = await readQuestionState(ctx.read, id);
    if (snapshot.ref.rev !== stateRev) throw new Error('题目处置基版已变化。');
    const restrictions = disposition.action === 'recheck' ? state.restrictions
      : state.restrictions.filter(entry => entry.scope !== disposition.scope);
    if (disposition.action === 'stop' || disposition.action === 'withdraw') restrictions.push(disposition);
    return [{ kind: 'correct', id: snapshot.ref.id, expectedRev: stateRev,
      data: { ...state, restrictions, last: disposition, recheck: state.recheck + Number(disposition.action === 'recheck') },
    }];
  },
});
