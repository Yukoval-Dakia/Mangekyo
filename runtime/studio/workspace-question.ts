import { fileURLToPath } from 'node:url';
import { toolFailure } from '../../executors/teaching/learning-tools.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { isFactUnavailable, purposeReader } from './fact-read-helpers.ts';
import { commandId, factId, type FactId, type Tick } from '../../kernel/src/declarations/ids.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import { parseSaveQuestion, QuestionAuthoringError } from '../../modules/content/question-authoring.ts';
import { questionAsset } from '../../modules/content/asset.ts';
import { saveQuestionCommand } from '../../modules/content/question-writes.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';
import { confirmNotionRead, checkStudioNotionFact } from './notion.ts';
import { purpose,stableId,studioLearner } from './identity.ts';

let content: ReturnType<typeof loadModuleDirectory> | undefined;

export type DraftWitness = {id:FactId;rev:number;epoch:Tick};
export function openWorkspaceQuestion(db: Db, turn: string, maySend: WorkspaceSourceRecipient,
  authorize: (tx: ReadTransaction) => Promise<void>, witnesses: () => DraftWitness[]) {
  return async (args: Record<string,unknown>, step: number) => {
    const schema = {tool:'find_tools',args:{query:'save_question'}};
    try {
      const parsed = parseSaveQuestion(args);
      if (parsed.kind !== 'create' || parsed.append_metadata) return toolFailure('invalid_args',
        '目前可保存新增题面草稿。题版修改或解法核验请使用题库。',schema);
      const {prompt,title,interaction,sources,shared_materials,...contract} = parsed.question;
      if (interaction || sources || shared_materials)
        return toolFailure('evidence_not_opened','带引用或交互的题目须在题库核验。',schema);
      const id = factId(stableId('learning-question',turn,String(step)));
      const pins = [...new Map(witnesses().map(w => [`${w.id}:${w.rev}`,w])).values()];
      const basis = await confirmNotionRead(db,studioLearner,async (tx,check) => {
        await authorize(tx);
        const read = purposeReader(tx,maySend);
        return Promise.all(pins.map(async w => {
          const fact = await read.reopen({id:w.id,rev:w.rev,accessEpoch:w.epoch,mode:'pinned'});
          await checkStudioNotionFact(tx,fact,purpose,maySend);
          await check(fact);
          return {...w,type:fact.type};
        }));
      });
      const asset = questionAsset({kind:'question',title,promptBlockId:'prompt',...contract,basis,
        blocks:[{id:'prompt',parentId:null,body:{kind:'text',text:prompt}}]});
      const handle = createCommandHandler(db,{
        modules:[await (content ??= loadModuleDirectory(fileURLToPath(new URL('../../modules/content',import.meta.url))))],
        hooks:createStudioCommandHooks({afterFactsChanged:authorize}),
      });
      await db.snapshot({learner:studioLearner},authorize);
      const receipt = await handle({learner:studioLearner,actor:'companion',purpose,
        id:commandId(stableId('learning-question-command',turn,String(step))),type:saveQuestionCommand,input:{id,asset}});
      return {ok:true as const,data:{status:'draft',ref:id,rev:receipt.wrote[0]!.rev,commandId:receipt.commandId}};
    } catch (error) {
      if (isFactUnavailable(error))
        return toolFailure('access_revoked','题目草稿的依据已不可用。',schema);
      if (error instanceof QuestionAuthoringError) return toolFailure(error.code,error.message,schema,error.field);
      if (error instanceof Error && /题目|评估|作答|题干|JSON/.test(error.message))
        return toolFailure('invalid_args','题面或评估契约无效。',schema);
      throw error;
    }
  };
}
