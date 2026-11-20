import { defineCommand, factId, isJson } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { textMaterial } from '../library-values.ts';
import {
  workspaceEntry,
  workspaceEntryType,
} from '../workspace-values.ts';
import { closedPosttest, retentionPaper, retentionPaperType, retentionTeachingPurpose } from '../retention-posttest.ts';
import { creation, object } from '../values.ts';
import { freezeWorkbookBank } from '../workbook-bank.ts';
import {
  saveWorkbookPaperCommand,
  workbookAssessmentPurpose,
  workbookPaper,
  WorkbookSourceMismatch,
  workbookPaperType,
  type WorkbookQuestion,
} from '../workbook-values.ts';

function matchesWorkspaceQuestion(
  entry: ReturnType<typeof workspaceEntry>,
  question: WorkbookQuestion,
): boolean {
  if (entry.kind !== 'question' || question.kind === 'bank') return false;
  if (entry.body !== question.prompt) return false;
  if (question.kind === 'numeric') {
    const answer = typeof entry.answer === 'string' ? entry.answer.trim() : '';
    return answer !== '' && Number(answer) === question.answer;
  }
  if (question.kind === 'exact') {
    const answer = typeof entry.answer === 'string' ? entry.answer.trim() : '';
    return question.answers.length === 1 && question.answers[0] === answer;
  }
  return typeof entry.rubric === 'string' && entry.rubric.trim() === question.rubric;
}

export default defineCommand({
  type: saveWorkbookPaperCommand,
  destructive: false,
  schema: { parse(input: unknown) {
    const row = object(input);
    const sealed = row.condition === closedPosttest;
    if (row.bankDraft !== undefined) {
      if (sealed || row.data !== undefined || typeof row.id !== 'string' || !isJson(row.bankDraft) ||
          typeof row.savedAt !== 'string' || new Date(row.savedAt).toISOString() !== row.savedAt)
        throw new Error('题库组卷输入无效。');
      return { id: factId(row.id), bankDraft: row.bankDraft, savedAt: row.savedAt, sealed };
    }
    return { ...creation(sealed ? retentionPaper : workbookPaper).parse(input), sealed };
  } },
  write: async (ctx, input) => {
    const { id, sealed } = input;
    const data = input.bankDraft === undefined ? input.data : await freezeWorkbookBank(ctx.read, id, input.bankDraft, input.savedAt);
    if (!data || (input.bankDraft === undefined && data.questions.some(question => question.kind === 'bank')))
      throw new WorkbookSourceMismatch('题库题项须由发放命令冻结。');
    if (data.materialId !== null) {
      const source = await ctx.read.fact(factId(data.materialId), { mode: 'following' });
      textMaterial(source.value);
    }
    for (const question of data.questions) {
      if (question.kind === 'bank') continue;
      const ref = question.sourceQuestionRef;
      if (!ref) continue;
      const source = await ctx.read.fact(factId(ref.id), { mode: 'pinned', rev: ref.rev });
      if (source.type !== workspaceEntryType) {
        throw new WorkbookSourceMismatch('来源题目引用类型无效。');
      }
      if (!matchesWorkspaceQuestion(workspaceEntry(source.value), question)) {
        throw new WorkbookSourceMismatch('引用的来源题目与冻结题项不一致。');
      }
    }
    return [
      {
        kind: 'create', id, factType: sealed ? retentionPaperType : workbookPaperType, data,
        purpose: sealed ? [storagePurpose, retentionTeachingPurpose]
          : data.assessmentRelease ? [storagePurpose, workbookAssessmentPurpose] : [storagePurpose],
      },
    ];
  },
});
