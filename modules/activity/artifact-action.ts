import { factId, isJson } from '@mangekyo/kernel';

export function artifactActionRecord(input: unknown) {
  if (
    !isJson(input) ||
    !input ||
    typeof input !== 'object' ||
    !('mountId' in input) ||
    typeof input.mountId !== 'string' ||
    typeof input.sessionId !== 'string' ||
    typeof input.turnId !== 'string' ||
    typeof input.requestId !== 'string' ||
    typeof input.stateRev !== 'number' ||
    !Number.isSafeInteger(input.stateRev) ||
    input.stateRev < 1 ||
    !input.action ||
    typeof input.action !== 'object' ||
    !('intent' in input.action)
  )
    throw new Error('作品操作记录无效。');
  return {
    ...input,
    mountId: factId(input.mountId),
    turnId: factId(input.turnId),
    sessionId: factId(input.sessionId),
  };
}
