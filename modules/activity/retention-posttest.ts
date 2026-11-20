import { derivationId, factId, type ReadContext, type Tick } from '@mangekyo/kernel';
import { helpRef } from './help-exposure-values.ts';
import { object } from './values.ts';
import { workbookGradingVersion, workbookPaper } from './workbook-values.ts';

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
      (item.kind === 'exact' && item.selfCheck) || item.sourceQuestionRef || paper.materialId !== null || paper.assessmentRelease) {
    throw new Error('受控后测须使用一题内嵌、可确定性正式判分的冻结卷。');
  }
  return paper;
}

function tick(value: unknown): Tick {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('后测刻度无效。');
  return value as Tick;
}

function time(value: unknown): string {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) throw new Error('后测时间无效。');
  return value;
}

export function posttestIssuance(input: unknown) {
  const row = object(input);
  const startedAt = time(row.startedAt);
  const through = time(row.through);
  if (row.condition !== closedPosttest || row.gradingVersion !== workbookGradingVersion ||
      typeof row.itemId !== 'string' || startedAt >= through) throw new Error('后测发放条件无效。');
  return {
    condition: row.condition, gradingVersion: row.gradingVersion,
    forecastId: derivationId(String(row.forecastId)), forecastKey: factId(String(row.forecastKey)),
    effectiveTick: tick(row.effectiveTick), paper: helpRef(row.paper), paperEpoch: tick(row.paperEpoch),
    itemId: row.itemId, startedAt, through,
  };
}

export async function issuedPosttestPaper(read: ReadContext, issued: ReturnType<typeof posttestIssuance>) {
  const source = await read.fact(issued.paper.id, { mode: 'following' });
  if (source.type !== retentionPaperType || source.ref.rev !== issued.paper.rev || source.accessEpoch !== issued.paperEpoch) {
    throw new Error('后测冻结卷版本或授权已变化。');
  }
  const paper = retentionPaper(source.value);
  if (paper.questions[0]!.id !== issued.itemId) throw new Error('后测题项不匹配。');
  return paper;
}
