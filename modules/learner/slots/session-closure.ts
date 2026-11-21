import { defineSlot } from '@mangekyo/kernel';
import { sessionClosureType, type SessionClosureScope } from '../session-closure.ts';

export default defineSlot({
  type: sessionClosureType,
  key: (scope: SessionClosureScope) => scope.kind === 'today'
    ? JSON.stringify([scope.kind, scope.day, scope.timeZone])
    : JSON.stringify([scope.kind, scope.id, scope.rev]),
  triggers: [{ kind: 'always' }],
  policy: 'lazy',
});
