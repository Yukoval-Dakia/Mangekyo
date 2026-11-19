import { defineCommand, factId } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { textMaterial } from '../library-values.ts';
import {
  workspaceEntry,
  workspaceEntryType,
} from '../workspace-values.ts';
import { creation } from '../values.ts';
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
  if (entry.kind !== 'question') return false;
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
  schema: creation(workbookPaper),
  write: async (ctx, { id, data }) => {
    if (data.materialId !== null) {
      const source = await ctx.read.fact(factId(data.materialId), { mode: 'following' });
      textMaterial(source.value);
    }
    for (const question of data.questions) {
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
        kind: 'create', id, factType: workbookPaperType, data,
        purpose: data.assessmentRelease ? [storagePurpose, workbookAssessmentPurpose] : [storagePurpose],
      },
    ];
  },
});
