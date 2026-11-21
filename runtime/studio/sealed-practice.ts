import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
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
import { parsePracticeAdmission, resolvePracticeAdmission } from './generated-practice.ts';

const scope = {learner:studioLearner};
const unavailable = () => new RequestError(404,'找不到当前可用的封闭练习。');

async function readPracticeTeaching(tx: ReadTransaction, paper: FactId) {
  try {
    const read = createCommandReadContext(tx,'storage');
    const custody = await readPracticeCustody(read,await practiceCustodyId(paper));
    if (!custody || custody.value.paper.id !== paper) throw unavailable();
    const source = await read.fact(custody.value.question.id,{mode:'following'});
    if (source.type !== assetType) throw unavailable();
    return {id:source.ref.id,rev:source.ref.rev,teaching:source.purpose.includes('teaching') || source.purpose.includes('all')};
  } catch (error) {
    if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) throw unavailable();
    throw error;
  }
}

export async function isPracticeWorkbook(tx: ReadTransaction, paper: FactId) {
  const found = await readPracticeCustody(createCommandReadContext(tx,'storage'),await practiceCustodyId(paper));
  return found?.value.paper.id === paper;
}

export async function sealedPracticePaper(tx: ReadTransaction, id: FactId) {
  try {
    return await openSealedPractice(createCommandReadContext(tx,'storage'),id);
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
      let requested;
      try {
        requestId = workbookRequestId(raw);
        requested = parsePracticeAdmission(definition);
      } catch (error) {
        throw new RequestError(400,error instanceof Error ? error.message : '练习参数无效。');
      }
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
        const read = createCommandReadContext(tx,'storage');
        const handle = createCommandHandler(withinLearnerTransaction(db,tx),{
          modules:[activity,content],hooks,
          // Keep the existing identity for retries of a previously authorized admission.
          bindCommandRead: (_tx, request, base) => request.type === saveQuestionCommand ? read : base,
        });
        const prior = await readPracticeCustody(read,await practiceCustodyId(id));
        try {
          await handle({...scope,actor:'learner',purpose:allowTeaching ? purpose : 'storage',
            deletionWatermark,type:saveQuestionCommand,id:command,
            input:{id:questionId,arithmeticPractice:practice,...(allowTeaching ? {} : {purpose:'storage'})}});
        } catch (error) {
          if (error instanceof Error && error.message === 'Command ID already used with a different command identity')
            throw new RequestError(409,'同一个请求标识已经用于不同练习。');
          throw error;
        }
        if (!prior) await handle({...scope,actor:'learner',purpose:'storage',deletionWatermark,type:saveWorkbookPaperCommand,
          id:commandId(stableId(sealedPracticePurpose,'reserve-paper',id)),
          input:{id,questionId,savedAt:new Date().toISOString(),condition:sealedPracticePurpose}});
        if (!await openArithmeticPractice(read,questionId,undefined,'storage')) throw unavailable();
        return {id,questionRef:{id:questionId,rev:prior?.value.question.rev ?? 1},path:'/papers/'+id};
      });
    },
    getTeaching(id: string) {
      return db.snapshot(scope,tx => readPracticeTeaching(tx,factId(id)));
    },
    async teaching(id: string, input: Record<string,unknown>) {
      if (typeof input.allowed !== 'boolean' || !Number.isSafeInteger(input.expectedRev) || Number(input.expectedRev) < 1)
        throw new RequestError(400,'教学用途设置无效。');
      const {allowed,expectedRev} = input;
      return db.tx(scope,async tx => {
        await lockLearner(tx,tx.learner);
        const current = await readPracticeTeaching(tx,factId(id));
        if (current.rev !== expectedRev) throw new RequestError(409,'题面权限已在别处更新。请刷新后再试。');
        if (current.teaching === allowed) return current;
        const questionId = current.id;
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
    const read = createCommandReadContext(tx,'storage');
    const custody = await readPracticeCustody(read,await practiceCustodyId(paperId));
    const handle = createCommandHandler(withinLearnerTransaction(db,tx),{modules:[activity],hooks});
    if (custody?.value.kind === 'sealed') {
      if (!await sealedPracticePaper(tx,paperId)) throw unavailable();
      await handle({...scope,actor:'learner',purpose:'storage',type:releasePracticeFeedbackCommand,
        id:commandId(stableId(sealedPracticePurpose,'release-feedback',paperId)),
        ...(request.deletionWatermark === undefined ? {} : {deletionWatermark:request.deletionWatermark}),
        input:{custody:{id:custody.fact.ref.id,rev:custody.fact.ref.rev},paper:{id:paperId,rev:1}}});
    }
    return handle(request);
  });
}
