import { factId, stableId, type FactId, type Json, type Revision } from '@mangekyo/kernel';

/** Injected error factory; the host binds its own request-error class. */
export type SliceReject = (status: number, message: string) => Error;

export const firstRevision = 1 as Revision;

const badInput = (reject: SliceReject) => reject(400, '回忆题请求格式无效。');

/** Existing StudyKits have positional questions. A position is meaningful only in its frozen version. */
export const recallItemId = (turnId: string, version: string, position: number): FactId =>
  factId(stableId('recall-item', turnId, version, String(position)));

export const recallIssuanceRef = (turnId: string, derivationId: string): { id: FactId; rev: Revision } =>
  ({ id: factId(stableId('recall-issuance', turnId, derivationId)), rev: firstRevision });

export const recallRevealId = (requestId: string): FactId => factId(stableId('recall-reveal', requestId));
export const recallDisplayId = (revealId: string): FactId => factId(stableId('recall-display', revealId));
export const recallSubmissionId = (requestId: string): FactId => factId(stableId('recall-submission', requestId));

export function parseBody<T>(reject: SliceReject, body: unknown, parse: (value: unknown) => T): T {
  try { return parse(body); } catch { throw badInput(reject); }
}

export const requireKit = <T>(reject: SliceReject, kit: T | null | undefined): T =>
  kit ?? (() => { throw reject(404, '此回合没有可用的回忆题。'); })();

export const requireMountedItem = <T>(reject: SliceReject, item: T | null | undefined): T =>
  item ?? (() => { throw reject(404, '回忆题与此回合版本不匹配。'); })();

export const requireIssued = <T>(reject: SliceReject, type: string | undefined, expected: string, value: T): T =>
  type === expected ? value : (() => { throw reject(404, '这道回忆题尚未发放。'); })();

/** Retry-preserving submission data: first admission's observation wins. */
export const recallSubmissionData = (
  issuance: { id: FactId; rev: Revision }, itemId: FactId, responseId: string,
  answer: string, priorObservation: string | undefined, observation: string) =>
  ({ issuance, itemId, responseId, answer, observation: priorObservation ?? observation });

export function rejectDuplicateCommand(reject: SliceReject, error: unknown, message: string): void {
  if (error instanceof Error && error.message === 'Command ID already used with a different command identity')
    throw reject(409, message);
  throw error;
}

export function writtenRefOr<T extends { state: string; wrote: readonly unknown[] }>(
  reject: SliceReject, receipt: T, message: string) {
  const ref = receipt.wrote[0];
  if (receipt.state !== 'done' || !ref) throw reject(409, message);
  return ref;
}

export function requireSessionTurnRows(reject: SliceReject,
  rootType: string | undefined, rootSession: string | undefined, rootParent: string | null | undefined,
  turnType: string | undefined, turnSession: string | undefined, sessionId: string,
  expectedType: string): void {
  if (rootType !== expectedType || turnType !== expectedType || rootSession !== sessionId ||
      rootParent !== null || turnSession !== sessionId) throw reject(404, '回忆题不属于该会话。');
}

/** Every archived feedback answer must match the resubmitted answers on a retry. */
export const practiceAnswersMatch = (
  feedback: readonly { questionId: string; answer: unknown }[], answers: Record<string, unknown>): boolean =>
  !feedback.some(({ questionId, answer }) => answers[questionId] !== answer);

export const practiceAttemptIds = (stable: (...parts: string[]) => string, request: string) => {
  const attemptId = factId(stable('starter-practice', 'riding', request));
  return { attemptId, submissionId: stable('submit-starter-practice', attemptId) };
};

/** Re-throws host request errors untouched; wraps anything else in the host's 400. */
export function wrapOrRethrow(reject: SliceReject, error: unknown,
  isRequestError: (error: unknown) => boolean): never {
  if (isRequestError(error)) throw error;
  throw reject(400, error instanceof Error ? error.message : '请求无效。');
}

/** Manifest must name the turn as a following-mode input (or pin its exact rev/epoch). */
export const manifestFollowsTurn = (
  manifest: { purpose: string; inputs: readonly Record<string, unknown>[] },
  turn: { ref: { id: FactId; rev: Revision }; accessEpoch: string }, purpose: string): boolean =>
  manifest.purpose === purpose && manifest.inputs.some(entry =>
    entry.kind === 'fact' && entry.id === turn.ref.id &&
    (entry.mode === 'following' || (entry.rev === turn.ref.rev && entry.accessEpoch === turn.accessEpoch)));

export const recallMounts = (turnId: string, derivationId: string, itemCount: number) =>
  Array.from({ length: itemCount }, (_, index) =>
    ({ turnId, derivationId, itemId: recallItemId(turnId, derivationId, index) }));

/** Splits the admit payload into request metadata and the practice definition. */
export function sealedPracticeAdmitInput<T>(
  reject: SliceReject, raw: unknown, definition: Record<string, unknown>,
  parseRequestId: (value: unknown) => string,
  parseDefinition: (value: Record<string, unknown>) => T) {
  try { return { requestId: parseRequestId(raw), requested: parseDefinition(definition) }; }
  catch (error) { throw reject(400, error instanceof Error ? error.message : '练习参数无效。'); }
}

export function sealedPracticeTeachingInput(reject: SliceReject, input: Record<string, unknown>) {
  if (typeof input.allowed !== 'boolean' || !Number.isSafeInteger(input.expectedRev) || Number(input.expectedRev) < 1)
    throw reject(400, '教学用途设置无效。');
  return { allowed: input.allowed as boolean, expectedRev: Number(input.expectedRev) };
}

export const sealedPracticeSaveQuestionInput = (questionId: FactId, practice: Json, allowTeaching: boolean) =>
  ({ id: questionId, arithmeticPractice: practice, ...(allowTeaching ? {} : { purpose: 'storage' }) });

export const sealedPracticeReservePaperInput = (id: FactId, questionId: FactId, condition: string) =>
  ({ id, questionId, savedAt: new Date().toISOString(), condition });

export const sealedPracticeReleaseFeedbackInput = (custodyRef: { id: FactId; rev: Revision }, paperId: FactId) =>
  ({ custody: custodyRef, paper: { id: paperId, rev: firstRevision } });

export const sealedPracticeTeachingCommandInput = (questionId: FactId, expectedRev: number, allowed: boolean) =>
  ({ id: questionId, expectedRev, allowed });
