import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { CommandHooks, CommandRequest } from '../../kernel/src/commands/contracts.ts';
import { lockLearner, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { assertUnburned } from '../../kernel/src/lifecycle.ts';
import { arithmeticPractice, arithmeticQuestionId, openArithmeticPractice } from '../../modules/content/arithmetic-practice.ts';
import { saveQuestionCommand } from '../../modules/content/question-writes.ts';
import {
  arithmeticPracticePaperId, openSealedPractice, practiceCustodyId, readPracticeCustody, releasePracticeFeedbackCommand, sealedPracticePurpose,
} from '../../modules/activity/sealed-practice.ts';
import { saveWorkbookPaperCommand, workbookRequestId } from '../../modules/activity/workbook-values.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';

const scope = {learner:studioLearner};
const unavailable = () => new RequestError(404,'找不到当前可用的封闭练习。');

export async function isPracticeWorkbook(tx: ReadTransaction, paper: FactId) {
  const found = await readPracticeCustody(createCommandReadContext(tx,'storage'),await practiceCustodyId(paper));
  return found?.value.paper.id === paper;
}

export async function sealedPracticePaper(tx: ReadTransaction, id: FactId) {
  try {
    return await openSealedPractice(createCommandReadContext(tx,purpose),id);
  } catch (error) {
    if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
    return undefined;
  }
}

export function openPracticeAdmission(db: Db, content: LoadedModule, activity: LoadedModule, hooks: CommandHooks) {
  return {
    async admit(input: Record<string,unknown>, deletionWatermark: string) {
      const {requestId:raw,allowTeaching,deletionWatermark:_,...definition} = input;
      let requestId;
      let practice;
      try {
        requestId = workbookRequestId(raw);
        practice = arithmeticPractice(definition);
      } catch (error) {
        throw new RequestError(400,error instanceof Error ? error.message : '练习参数无效。');
      }
      if (allowTeaching !== true) throw new RequestError(400,'请允许普通伴学使用此练习的题面。');
      const questionId = await arithmeticQuestionId(practice);
      const id = await arithmeticPracticePaperId(questionId);
      return db.tx(scope,async tx => {
        await lockLearner(tx,tx.learner);
        await assertUnburned(tx,'fact',[id,questionId,await practiceCustodyId(id)]);
        const handle = createCommandHandler(withinLearnerTransaction(db,tx),{modules:[activity,content],hooks});
        const command = commandId(stableId(sealedPracticePurpose,'source-command',requestId));
        const read = createCommandReadContext(tx,purpose);
        const prior = await readPracticeCustody(read,await practiceCustodyId(id));
        try {
          await handle({...scope,actor:'learner',purpose,deletionWatermark,type:saveQuestionCommand,id:command,
            input:{id:questionId,arithmeticPractice:practice}});
        } catch (error) {
          if (error instanceof Error && error.message === 'Command ID already used with a different command identity')
            throw new RequestError(409,'同一个请求标识已经用于不同练习。');
          throw error;
        }
        if (!prior) await handle({...scope,actor:'learner',purpose,deletionWatermark,type:saveWorkbookPaperCommand,
          id:commandId(stableId(sealedPracticePurpose,'reserve-paper',id)),
          input:{id,questionId,savedAt:new Date().toISOString(),condition:sealedPracticePurpose}});
        if (!await openArithmeticPractice(read,questionId)) throw unavailable();
        return {id,questionRef:{id:questionId,rev:prior?.value.question.rev ?? 1},path:'/papers/'+id};
      });
    },
    async teaching(id: string, input: Record<string,unknown>) {
      if (typeof input.allowed !== 'boolean' || !Number.isSafeInteger(input.expectedRev) || Number(input.expectedRev) < 1)
        throw new RequestError(400,'教学用途设置无效。');
      const {allowed,expectedRev} = input;
      return db.tx(scope,async tx => {
        await lockLearner(tx,tx.learner);
        const paper = factId(id);
        const custody = await readPracticeCustody(createCommandReadContext(tx,'storage'),await practiceCustodyId(paper));
        if (!custody || custody.value.paper.id !== paper) throw unavailable();
        const questionId = custody.value.question.id;
        const handle = createCommandHandler(withinLearnerTransaction(db,tx),{modules:[content],hooks});
        const result = await handle({...scope,actor:'learner',purpose:'storage',type:'content.setQuestionTeaching',
          id:commandId(stableId(sealedPracticePurpose,'teaching',questionId,String(expectedRev),String(allowed))),
          input:{id:questionId,expectedRev:Number(expectedRev),allowed}});
        return {id:questionId,rev:result.wrote[0]?.rev ?? expectedRev,teaching:allowed};
      });
    },
  };
}

/** Older servers see no Workbook fact until the first official submission and its release commit. */
export function submitWithPracticeCustody(db: Db, activity: LoadedModule, hooks: CommandHooks,
  paperId: FactId, request: CommandRequest) {
  return db.tx(scope,async tx => {
    await lockLearner(tx,tx.learner);
    const read = createCommandReadContext(tx,purpose);
    const custody = await readPracticeCustody(read,await practiceCustodyId(paperId));
    const handle = createCommandHandler(withinLearnerTransaction(db,tx),{modules:[activity],hooks});
    if (custody?.value.kind === 'sealed') {
      if (!await sealedPracticePaper(tx,paperId)) throw unavailable();
      await handle({...scope,actor:'learner',purpose,type:releasePracticeFeedbackCommand,
        id:commandId(stableId(sealedPracticePurpose,'release-feedback',paperId)),
        ...(request.deletionWatermark === undefined ? {} : {deletionWatermark:request.deletionWatermark}),
        input:{custody:{id:custody.fact.ref.id,rev:custody.fact.ref.rev},paper:{id:paperId,rev:1}}});
    }
    return handle(request);
  });
}
