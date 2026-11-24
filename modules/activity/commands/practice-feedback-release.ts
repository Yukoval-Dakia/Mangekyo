import { defineCommand } from '@mangekyo/kernel';
import { helpRef } from '../help-exposure-values.ts';
import { storagePurpose } from '../library-values.ts';
import { openSealedPractice, releasePracticeFeedbackCommand } from '../sealed-practice.ts';
import { object } from '../values.ts';
import { workbookPaperType } from '../workbook-values.ts';

export default defineCommand({
  type:releasePracticeFeedbackCommand, destructive:false,
  schema:{parse(input: unknown) {
    const {custody, paper} = object(input);
    return {custody:helpRef(custody), paper:helpRef(paper)};
  }},
  async write(ctx,{custody,paper}) {
    const opened = await openSealedPractice(ctx.read,paper.id);
    if (!opened || opened.custody.fact.ref.id !== custody.id || opened.custody.fact.ref.rev !== custody.rev ||
        opened.custody.value.paper.rev !== paper.rev)
      throw new Error('封闭练习或反馈授权已变化。');
    // An old Studio cannot access the reserved logical paper ID before this transaction.
    return [
      {kind:'correct',id:custody.id,expectedRev:custody.rev,data:{...opened.custody.value,kind:'possible'}},
      {kind:'create',id:paper.id,factType:workbookPaperType,data:opened.paper,purpose:[storagePurpose]},
    ];
  },
});
