import { defineDeriver, factId, type GatherContext } from '@mangekyo/kernel';
import {
  activitySubmissionTypes, projectSessionClosure, sameClosureRef, SessionClosureConflict, sessionClosureType,
  type SessionClosureEvidence, type SessionClosureScope,
} from '../session-closure.ts';

type ReadClosure = (ctx: GatherContext, scope: SessionClosureScope) => Promise<SessionClosureEvidence>;

export default defineDeriver({
  name: 'learner/session-closure',
  version: '1',
  slot: sessionClosureType,
  async gather(ctx, { scope, read }: { scope: SessionClosureScope; read: ReadClosure }) {
    if (scope.kind !== 'today') {
      const root = await ctx.read.fact(factId(scope.id), { mode: 'following' });
      if (root.ref.rev !== scope.rev) throw new SessionClosureConflict('收场版本已变化。');
      if (scope.kind === 'attempt' && !activitySubmissionTypes.includes(root.type))
        throw new SessionClosureConflict('收场需要正式交卷记录。');
      if (scope.kind === 'classroom' && (root.type !== 'activity.classroom' || !root.value ||
        typeof root.value !== 'object' || !('status' in root.value) || root.value.status !== 'finished'))
        throw new SessionClosureConflict('收场需要已正式结束的课堂。');
    }
    // The host resolves classroom and daily membership and each source's purpose
    // before assembling the evidence. Classroom state itself is teaching-only.
    const evidence = await read(ctx, scope);
    if (scope.kind === 'attempt' && evidence.submissions?.some(({ ref }) => !sameClosureRef(scope, ref)))
      throw new SessionClosureConflict('交卷记录超出本场。');
    return { kind: 'input', data: projectSessionClosure(evidence), effects: [] };
  },
  derive(receipt) {
    return { kind: 'value', value: receipt };
  },
});
