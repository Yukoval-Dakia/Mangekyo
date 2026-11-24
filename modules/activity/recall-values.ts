import { derivationId, factId, type FactRef, type Revision, type Tick } from '@mangekyo/kernel';
import { sameHelpRef, sameHelpTarget, type HelpExposureEvent, type HelpRef, type HelpTarget } from './help-exposure-values.ts';
import { projectHelpExposure, type AdmittedHelpEvent } from './help-exposure.ts';
import { gradeWorkbook, workbookRequestId, type WorkbookQuestion } from './workbook-values.ts';
import { exactRecordParser, factIdParser, positiveRevision, recordParser, textValue } from './validation.ts';

export const recallIssuanceType = 'activity.recallIssuance';
export const recallSubmissionType = 'activity.recallSubmission';
export const issueRecallCommand = 'activity.issueRecall';
export const submitRecallCommand = 'activity.submitRecall';
export const recallResponseId = 'answer';

const record = recordParser(() => new Error('回忆题记录格式无效。'));

const id = factIdParser(() => new Error('回忆题缺少标识。'));

function ref(value: unknown): HelpRef {
  const row = record(value);
  return { id: id(row.id), rev: positiveRevision(row.rev, () => new Error('回忆题引用版本无效。')) };
}

function recallText(value: unknown, limit: number): string {
  return textValue(value, () => new Error('回忆题文本无效。'), { limit, preserveWhitespace: true });
}

export function recallIssuance(value: unknown) {
  const { turn, version, materials, items } = record(value);
  if (!Array.isArray(materials) || materials.length > 2 || !Array.isArray(items) ||
      items.length < 2 || items.length > 4 || typeof version !== 'string') {
    throw new Error('回忆题发放记录无效。');
  }
  const questions = items.map((item: unknown) => {
    const row = record(item);
    return {
      itemId: id(row.itemId), prompt: recallText(row.prompt, 500), answer: recallText(row.answer, 600),
      ...(row.rubric === undefined ? {} : { rubric: recallText(row.rubric, 2000) }),
    };
  });
  if (new Set(questions.map(item => item.itemId)).size !== questions.length) {
    throw new Error('回忆题题项重复。');
  }
  return {
    turn: ref(turn), version: derivationId(version),
    materials: materials.map((material: unknown) => {
      const row = record(material);
      if (typeof row.accessEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.accessEpoch)) {
        throw new Error('回忆题授权见证无效。');
      }
      return { ref: ref(row.ref), accessEpoch: row.accessEpoch as Tick };
    }),
    items: questions,
  };
}

export function recallSubmission(value: unknown) {
  const { issuance, itemId, responseId, answer, observation } = record(value);
  if (responseId !== recallResponseId || (observation !== 'complete' && observation !== 'unknown')) {
    throw new Error('回忆题作答位或观测状态无效。');
  }
  return {
    issuance: ref(issuance), itemId: id(itemId), responseId, answer: recallText(answer, 4000), observation,
  };
}

export function recallTarget(issuance: HelpRef, itemId: string): HelpTarget {
  return { activityId: issuance.id, issuance, item: { itemId, responseId: recallResponseId } };
}

function gradeRecallItem(item: ReturnType<typeof recallIssuance>['items'][number], answer: string) {
  const base = { id: item.itemId, prompt: item.prompt, explanation: null };
  const question: WorkbookQuestion = item.rubric
    ? { ...base, kind: 'rubric', rubric: item.rubric, rubricVersion: 'rubric-v1' }
    : { ...base, kind: 'exact', answers: [item.answer], selfCheck: false };
  const { feedback: [feedback] } = gradeWorkbook(
    { title: '回忆题', materialId: null, savedAt: '', questions: [question] },
    { [item.itemId]: answer },
  );
  if (!feedback) throw new Error('Missing Recall result');
  return feedback.result;
}

function recallFields(value: unknown, names: readonly string[]): Record<string, unknown> {
  return exactRecord(value, names);
}

const exactRecord = exactRecordParser(() => new Error('回忆题请求字段无效。'));

export function parseRecallMount(value: unknown) {
  const { turnId, derivationId: version, itemId } = recallFields(value, ['turnId', 'derivationId', 'itemId']);
  if (typeof turnId !== 'string' || typeof version !== 'string' || typeof itemId !== 'string') {
    throw new Error('回忆题挂载标识无效。');
  }
  return { turnId: factId(turnId), derivationId: derivationId(version), itemId: factId(itemId) };
}

export type RecallMount = ReturnType<typeof parseRecallMount>;
type RecallItem = ReturnType<typeof recallIssuance>['items'][number];

export function recallRevealInput(value: unknown) {
  const { mount, requestId } = recallFields(value, ['mount', 'requestId']);
  return { mount: parseRecallMount(mount), requestId: workbookRequestId(requestId) };
}

export function recallSubmitInput(value: unknown) {
  const { mount, requestId, answer } = recallFields(value, ['mount', 'requestId', 'answer']);
  return { mount: parseRecallMount(mount), requestId: workbookRequestId(requestId), answer: recallText(answer, 4000) };
}

export function recallMountedItem(issuance: Pick<ReturnType<typeof recallIssuance>, 'items'> & {
  turn: HelpRef; version: string;
}, mount: RecallMount) {
  if (issuance.turn.id === mount.turnId && issuance.version === mount.derivationId) {
    return issuance.items.find(item => item.itemId === mount.itemId);
  }
  return undefined;
}

export function recallItemView(mount: RecallMount, ref: HelpRef, item: RecallItem) {
  return { ...mount, issuanceId: ref.id, responseId: recallResponseId, prompt: item.prompt };
}

export function recallRevealView(revealId: FactRef['id'], item: RecallItem) {
  return { revealId, itemId: item.itemId, reference: item.answer, ...(item.rubric ? { rubric: item.rubric } : {}) };
}

export function recallDisplayEvent(reveal: HelpExposureEvent | null, ref: HelpRef, item: RecallItem) {
  if (reveal?.kind === 'opened' && sameHelpTarget(reveal.mount, recallTarget(ref, item.itemId)) &&
      sameHelpRef(reveal.content, ref) && reveal.step.kind === 'solution' &&
      reveal.step.order === 1 && reveal.alsoAppliesTo.length === 0) {
    return { ...reveal, kind: 'displayed' as const };
  }
  return undefined;
}

export function recallResultView(submission: ReturnType<typeof recallSubmission>, ref: FactRef, item: RecallItem,
  cutoff: Tick, review: { events: readonly AdmittedHelpEvent[]; omitted: boolean },
) {
  const target = recallTarget(submission.issuance, submission.itemId);
  const coverage = !review.omitted && submission.observation === 'complete' ? { submission: ref, target, through: cutoff } : null;
  return {
    submission: ref, itemId: item.itemId, responseId: recallResponseId,
    result: gradeRecallItem(item, submission.answer),
    exposure: projectHelpExposure({ submission: { ref, target, cutoff }, events: review.events, coverage }),
  };
}
