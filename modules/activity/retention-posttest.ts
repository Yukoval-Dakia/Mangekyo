import { derivationId, factId, type DerivationId, type ReadContext, type Tick } from '@mangekyo/kernel';
import { helpRef } from './help-exposure-values.ts';
import { object } from './values.ts';
import {
  sameWorkbookJson, workbookGradingVersion, workbookPaper, workbookRequestId, workbookRubricGradingVersion,
  type WorkbookAttempt, type WorkbookPaper, type WorkbookSourceQuestionRef,
} from './workbook-values.ts';

export const retentionPaperType = 'activity.retentionPaper';
export const posttestIssuanceType = 'activity.retentionPosttest';
export const posttestSubmissionType = 'activity.retentionPosttestSubmission';
export const issuePosttestCommand = 'activity.issueRetentionPosttest';
export const retentionTeachingPurpose = 'teaching';
export const closedPosttest = 'studio-closed-workbook-v1';

export function retentionPaper(input: unknown) {
  const paper = workbookPaper(input);
  const [item] = paper.questions;
  if (paper.questions.length !== 1 || !item || item.kind === 'rubric' ||
      (item.kind === 'exact' && item.selfCheck) || paper.materialId !== null || paper.assessmentRelease) {
    throw new Error('受控后测须使用一题可确定性正式判分的冻结卷。');
  }
  return paper;
}

function tick(value: unknown): Tick {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('后测刻度无效。');
  return value as Tick;
}

export function retentionDeadline(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      new Date(value).toISOString() !== value) throw new Error('需要 UTC 截止时间。');
  return value;
}

export function posttestIssuance(input: unknown) {
  const row = object(input);
  const startedAt = retentionDeadline(row.startedAt);
  const through = retentionDeadline(row.through);
  if (row.condition !== closedPosttest || row.gradingVersion !== workbookGradingVersion ||
      typeof row.itemId !== 'string' || startedAt >= through) throw new Error('后测发放条件无效。');
  return {
    condition: row.condition, gradingVersion: row.gradingVersion,
    forecastId: derivationId(String(row.forecastId)), forecastKey: factId(String(row.forecastKey)),
    effectiveTick: tick(row.effectiveTick), paper: helpRef(row.paper), paperEpoch: tick(row.paperEpoch),
    itemId: row.itemId, startedAt, through,
  };
}

export function matchesCurrentPosttest(issuance: ReturnType<typeof posttestIssuance>,
  current: { frozen: {derivationId: DerivationId; effectiveTick: Tick}; window: RetentionWindow;
    opened: { sealed: boolean; accessEpoch: Tick; target: {paper: ReturnType<typeof helpRef>; itemId: string; gradingVersion: string} } },
) {
  const { opened, frozen, window } = current;
  const { target } = opened;
  return opened.sealed && issuance.forecastId === frozen.derivationId &&
    issuance.effectiveTick === frozen.effectiveTick && issuance.paperEpoch === opened.accessEpoch &&
    issuance.paper.id === target.paper.id && issuance.paper.rev === target.paper.rev &&
    issuance.itemId === target.itemId && issuance.gradingVersion === target.gradingVersion &&
    issuance.through === window.through && issuance.startedAt >= posttestOpensAt(window);
}

export function matchesControlledSubmission(
  attempt: WorkbookAttempt,
  admittedAt: Tick,
  released: { issuance: ReturnType<typeof posttestIssuance>; tick: Tick },
  frozen: { sealed: boolean; accessEpoch: Tick; paper: WorkbookPaper; target: {
    paper: ReturnType<typeof helpRef>; itemId: string; gradingVersion: string;
  } },
  expectedForecast: DerivationId | undefined,
) {
  const { issuance, tick } = released;
  const { target } = frozen;
  return frozen.sealed && issuance.paper.id === target.paper.id && issuance.paper.rev === target.paper.rev &&
    issuance.paperEpoch === frozen.accessEpoch && issuance.itemId === target.itemId &&
    issuance.gradingVersion === target.gradingVersion && attempt.gradingVersion === target.gradingVersion &&
    sameWorkbookJson(attempt.paper, frozen.paper) && BigInt(tick) < BigInt(admittedAt) &&
    attempt.submittedAt >= issuance.startedAt && attempt.submittedAt <= issuance.through &&
    (expectedForecast === undefined || issuance.forecastId === expectedForecast);
}

export type RetentionWindow = { requestedAt: string; scheduledAt?: string; through: string };

export function posttestOpensAt(window: RetentionWindow) {
  return window.scheduledAt ?? window.requestedAt;
}

export function insideFrozenPosttestWindow(
  observation: { admittedAt: Tick; submittedAt: string }, window: RetentionWindow, effectiveTick: Tick,
) {
  return BigInt(observation.admittedAt) > BigInt(effectiveTick) &&
    observation.submittedAt >= posttestOpensAt(window) && observation.submittedAt <= window.through;
}

export function retentionFreezeRequest(input: Record<string, unknown>) {
  const { requestId, itemId, priorAttemptIds = [], through, condition = 'same-item' } = input;
  if (typeof itemId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(itemId) ||
      (condition !== 'same-item' && condition !== 'variant') ||
      !Array.isArray(priorAttemptIds) || priorAttemptIds.length > 10 ||
      new Set(priorAttemptIds).size !== priorAttemptIds.length) throw new Error('保持预测请求格式无效。');
  const ids = priorAttemptIds.map(id => {
    if (typeof id !== 'string') throw new Error('需要记录标识。');
    return factId(id);
  }).sort();
  return {
    requestId: workbookRequestId(requestId), itemId, priorAttemptIds: ids, through: retentionDeadline(through),
    condition: condition === 'variant' ? 'variant' as const : 'same-item' as const,
  };
}

export function retentionFollowupRequest(input: Record<string, unknown>) {
  if (Object.keys(input).length !== 2) throw new Error('保持预测请求格式无效。');
  const scheduledAt = retentionDeadline(input.scheduledAt);
  return {
    requestId: workbookRequestId(input.requestId), scheduledAt,
    through: retentionDeadline(new Date(Date.parse(scheduledAt) + 24 * 60 * 60 * 1000).toISOString()),
  };
}

export function workbookRetentionTarget(paper: WorkbookPaper, source: ReturnType<typeof helpRef>, itemId: string) {
  return {
    activity: 'frozen-workbook-item' as const,
    paper: source,
    itemId,
    condition: 'same-item' as const,
    gradingVersion: paper.questions.some(item => item.kind === 'rubric')
      ? workbookRubricGradingVersion : workbookGradingVersion,
  };
}

export function workbookVariantItem(
  paper: WorkbookPaper, source: WorkbookSourceQuestionRef | undefined,
  edges: readonly { from: { fact: { id: string; rev: number } }; to: { fact: { id: string; rev: number } };
    variant?: { spoilsNext: string } }[],
) {
  const matches = paper.questions.flatMap(item => edges.flatMap(edge => {
    const other = edge.from.fact.id === source?.id ? edge.to.fact : edge.from.fact;
    return item.sourceQuestionRef?.id === other.id && item.sourceQuestionRef.rev === other.rev &&
      edge.variant?.spoilsNext === 'none' ? [item] : [];
  }));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function issuedPosttestPaper(read: ReadContext, issued: ReturnType<typeof posttestIssuance>) {
  const source = await read.fact(issued.paper.id, { mode: 'following' });
  if (source.type !== retentionPaperType || source.ref.rev !== issued.paper.rev || source.accessEpoch !== issued.paperEpoch) {
    throw new Error('后测冻结卷版本或授权已变化。');
  }
  const paper = retentionPaper(source.value);
  const item = paper.questions[0]!;
  if (item.id !== issued.itemId) throw new Error('后测题项不匹配。');
  if (item.sourceQuestionRef) {
    await read.fact(factId(item.sourceQuestionRef.id), { mode: 'pinned', rev: item.sourceQuestionRef.rev });
  }
  return paper;
}
