import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { isFactUnavailable, storageRead } from './fact-read-helpers.ts';
import type { CommandHooks, CommandRequest } from '../../kernel/src/commands/contracts.ts';
import { lockLearner, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { assertUnburned } from '../../kernel/src/lifecycle.ts';
import { arithmeticQuestionId, openArithmeticPractice } from '../../modules/content/arithmetic-practice.ts';
import { assetType } from '../../modules/content/asset.ts';
import { saveQuestionCommand } from '../../modules/content/question-writes.ts';
import {
  arithmeticPracticePaperId, openSealedPractice, practiceCustodyId, readPracticeCustody, releasePracticeFeedbackCommand, sealedPracticePurpose,
} from '../../modules/activity/sealed-practice.ts';
import { saveWorkbookPaperCommand, workbookRequestId } from '../../modules/activity/workbook-values.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';
import { parsePracticeAdmission, resolveStudioPracticeAdmission as resolvePracticeAdmission } from './generated-practice.ts';
import {
  rejectDuplicateCommand, sealedPracticeAdmitInput, sealedPracticeReleaseFeedbackInput, sealedPracticeReservePaperInput,
  sealedPracticeSaveQuestionInput, sealedPracticeTeachingCommandInput, sealedPracticeTeachingInput,
  type SliceReject,
} from '../../modules/companion/facts/recall-practice-slice.ts';

const scope = {learner:studioLearner};
const unavailable = () => new RequestError(404,'找不到当前可用的封闭练习。');
const reject: SliceReject = (status, message) => new RequestError(status, message);

async function readPracticeTeaching(tx: ReadTransaction, paper: FactId) {
  try {
    const read = storageRead(tx);
    const custody = await readPracticeCustody(read,await practiceCustodyId(paper));
    if (!custody || custody.value.paper.id !== paper) throw unavailable();
    const source = await read.fact(custody.value.question.id,{mode:'following'});
    if (source.type !== assetType) throw unavailable();
    return {id:source.ref.id,rev:source.ref.rev,teaching:source.purpose.includes('teaching') || source.purpose.includes('all')};
  } catch (error) {
    if (isFactUnavailable(error)) throw unavailable();
    throw error;
  }
}

export async function isPracticeWorkbook(tx: ReadTransaction, paper: FactId) {
  const found = await readPracticeCustody(storageRead(tx),await practiceCustodyId(paper));
  return found?.value.paper.id === paper;
}

export async function sealedPracticePaper(tx: ReadTransaction, id: FactId) {
  try {
    return await openSealedPractice(storageRead(tx),id);
  } catch (error) {
    if (!isFactUnavailable(error)) throw error;
    return undefined;
  }
}

export function openPracticeAdmission(db: Db, content: LoadedModule, activity: LoadedModule, hooks: CommandHooks) {
  return {
    async admit(input: Record<string,unknown>, deletionWatermark: string) {
      const {requestId:raw,allowTeaching,deletionWatermark:_,...definition} = input;
      const {requestId,requested} = sealedPracticeAdmitInput(reject,raw,definition,
        workbookRequestId,(value) => parsePracticeAdmission(value));
      if (allowTeaching !== undefined && typeof allowTeaching !== 'boolean')
        throw new RequestError(400,'题面伴学用途无效。');
      return db.tx(scope,async tx => {
        await lockLearner(tx,tx.learner);
        const command = commandId(stableId(sealedPracticePurpose,'source-command',requestId));
        await assertUnburned(tx,'command',[command]);
        const practice = await resolvePracticeAdmission(tx,command,requested);
        const questionId = await arithmeticQuestionId(practice);
        const id = await arithmeticPracticePaperId(questionId);
        await assertUnburned(tx,'fact',[id,questionId,await practiceCustodyId(id)]);
        const read = storageRead(tx);
        const handle = createCommandHandler(withinLearnerTransaction(db,tx),{
          modules:[activity,content],hooks,
          // Keep the existing identity for retries of a previously authorized admission.
          bindCommandRead: (_tx, request, base) => request.type === saveQuestionCommand ? read : base,
        });
        const prior = await readPracticeCustody(read,await practiceCustodyId(id));
        try {
          await handle({...scope,actor:'learner',purpose:allowTeaching ? purpose : 'storage',
            deletionWatermark,type:saveQuestionCommand,id:command,
            input:sealedPracticeSaveQuestionInput(questionId,practice,allowTeaching === true)});
        } catch (error) {
          rejectDuplicateCommand(reject,error,'同一个请求标识已经用于不同练习。');
          throw error;
        }
        if (!prior) await handle({...scope,actor:'learner',purpose:'storage',deletionWatermark,type:saveWorkbookPaperCommand,
          id:commandId(stableId(sealedPracticePurpose,'reserve-paper',id)),
          input:sealedPracticeReservePaperInput(id,questionId,sealedPracticePurpose)});
        if (!await openArithmeticPractice(read,questionId,undefined,'storage')) throw unavailable();
        return {id,questionRef:{id:questionId,rev:prior?.value.question.rev ?? 1},path:'/papers/'+id};
      });
    },
    getTeaching(id: string) {
      return db.snapshot(scope,tx => readPracticeTeaching(tx,factId(id)));
    },
    async teaching(id: string, input: Record<string,unknown>) {
      const {allowed,expectedRev} = sealedPracticeTeachingInput(reject,input);
      return db.tx(scope,async tx => {
        await lockLearner(tx,tx.learner);
        const current = await readPracticeTeaching(tx,factId(id));
        if (current.rev !== expectedRev) throw new RequestError(409,'题面权限已在别处更新。请刷新后再试。');
        if (current.teaching === allowed) return current;
        const questionId = current.id;
        const handle = createCommandHandler(withinLearnerTransaction(db,tx),{modules:[content],hooks});
        const result = await handle({...scope,actor:'learner',purpose:'storage',type:'content.setQuestionTeaching',
          id:commandId(stableId(sealedPracticePurpose,'teaching',questionId,String(expectedRev),String(allowed))),
          input:sealedPracticeTeachingCommandInput(questionId,expectedRev,allowed)});
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
    const read = storageRead(tx);
    const custody = await readPracticeCustody(read,await practiceCustodyId(paperId));
    const handle = createCommandHandler(withinLearnerTransaction(db,tx),{modules:[activity],hooks});
    if (custody?.value.kind === 'sealed') {
      if (!await sealedPracticePaper(tx,paperId)) throw unavailable();
      await handle({...scope,actor:'learner',purpose:'storage',type:releasePracticeFeedbackCommand,
        id:commandId(stableId(sealedPracticePurpose,'release-feedback',paperId)),
        ...(request.deletionWatermark === undefined ? {} : {deletionWatermark:request.deletionWatermark}),
        input:sealedPracticeReleaseFeedbackInput({id:custody.fact.ref.id,rev:custody.fact.ref.rev},paperId)});
    }
    return handle(request);
  });
}
