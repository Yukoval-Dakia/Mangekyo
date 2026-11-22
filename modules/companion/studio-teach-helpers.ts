// Pure helpers extracted from runtime/studio/teach.ts.
// All tx, db.snapshot, kernel effects stay in the runtime host;
// this module owns validation, payload shaping, and pure guards.

export function isTeachingDeriver(
  methodName: string,
  confirmedTeachingMethod: string,
  learningToolsMethod: string,
  deriver: string,
): boolean {
  return deriver === methodName || deriver === confirmedTeachingMethod || deriver === learningToolsMethod;
}

export function isCompanionCase(caseId: string): caseId is 'companion' | 'riding' {
  return caseId === 'companion' || caseId === 'riding';
}

export function isIntroCase(caseId: string): caseId is 'independent' | 'workedExample' {
  return caseId === 'independent' || caseId === 'workedExample';
}

export function unknownTeachingScopeError(): Error {
  return new Error('Unknown teaching scope');
}

export function unknownTeachingMethodError(): Error {
  return new Error('Unknown teaching method');
}

export function unknownTeachingCaseError(): Error {
  return new Error('Unknown teaching case');
}

export function buildTeachingFailurePayload(
  status: 'failed' | 'unknown',
  message: string,
): { status: 'failed' | 'unknown'; message: string } {
  return { status, message };
}

// Deterministic ids used inside a teaching turn.
export function teachFeedbackIdFor(
  stableIdFn: (...parts: string[]) => string,
  learner: string,
  workId: string,
  generation: number,
): string {
  return stableIdFn('feedback', learner, workId, String(generation));
}
