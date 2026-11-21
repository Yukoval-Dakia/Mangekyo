import { defineCommand, factId } from '@mangekyo/kernel';
import { openArithmeticPractice } from '@mangekyo/module-content/facts/arithmetic-practice';
import { storagePurpose } from '../library-values.ts';
import { textMaterial } from '../library-values.ts';
import {
  workspaceEntry,
  workspaceEntryType,
} from '../workspace-values.ts';
import { closedPosttest, retentionPaper, retentionPaperType, retentionTeachingPurpose } from '../retention-posttest.ts';
import { creation, object } from '../values.ts';
import { arithmeticPracticePaper, arithmeticPracticePaperId, practiceCustody, practiceCustodyId, practiceCustodyType, sealedPracticePurpose } from '../sealed-practice.ts';
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
  schema: { parse(input: unknown) {
    const row = object(input);
    if (row.condition === sealedPracticePurpose) return {
      id:factId(String(row.id)), practice:{question:factId(String(row.questionId)),savedAt:String(row.savedAt)},
    };
    const sealed = row.condition === closedPosttest;
    return { ...creation(sealed ? retentionPaper : workbookPaper).parse(input), sealed };
  } },
  write: async (ctx, input) => {
    if ('practice' in input && input.practice) {
      const {id, practice} = input;
      const question = await openArithmeticPractice(ctx.read,practice.question,undefined,storagePurpose);
      if (!question || id !== await arithmeticPracticePaperId(practice.question))
        throw new WorkbookSourceMismatch('来源题没有可发行的封闭练习版本。');
      const {id:sourceId,rev} = question.source.ref;
      arithmeticPracticePaper(question,practice.savedAt);
      return [{kind:'create',id:await practiceCustodyId(id),factType:practiceCustodyType,
        data:practiceCustody({kind:'sealed',question:{id:sourceId,rev},paper:{id,rev:1},savedAt:practice.savedAt}),
        purpose:[storagePurpose,'teaching']}];
    }
    const {id,data,sealed} = input;
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
        kind: 'create', id, factType: sealed ? retentionPaperType : workbookPaperType, data,
        purpose: sealed ? [storagePurpose, retentionTeachingPurpose]
          : data.assessmentRelease ? [storagePurpose, workbookAssessmentPurpose] : [storagePurpose],
      },
    ];
  },
});
