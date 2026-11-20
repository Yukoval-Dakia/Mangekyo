import {fileURLToPath} from 'node:url';
import {createCommandHandler, readCommandProposals} from '../../kernel/src/commands/handle.ts';
import {createAuthorizedFactReader, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import {commandId, factId} from '../../kernel/src/declarations/ids.ts';
import type {Db, ReadTransaction} from '../../kernel/src/db/types.ts';
import {loadModuleDirectory, type LoadedModule} from '../../kernel/src/loader.ts';
import {openLearningLimit} from '../../executors/teaching/workspace-tools.ts';
import {isSourceFactId, type SourceRefV1} from '../../modules/activity/source-values.ts';
import {
  createKnowledgeEdgeCommand, createVerifiedKnowledgeEdgeCommand, withdrawKnowledgeEdgeCommand,
  knowledgeEdgeEvidenceType, knowledgeEdgeType, knowledgeEndpointKind, knowledgeUseKey,
  KnowledgeEdgeBasisError, KnowledgeEdgeEvidenceError, parseEdgeClaim, parseEdgeWrite, sourceUse,
} from '../../modules/content/knowledge-edge.ts';
import {createStudioCommandHooks} from './command-hooks.ts';
import {purpose, stableId, studioLearner} from './identity.ts';
import {readKnowledgeSources} from './knowledge-graph.ts';
import {RequestError} from './sessions.ts';
import type {WorkspaceSourceRecipient} from './source-read.ts';
import type {WorkspaceWitness} from './workspace-agent.ts';
import {learningToolError, parseLearningReference} from './workspace-open.ts';

const scope = {learner:studioLearner};
const whole = {kind:'whole'} as const;
const owner = {recipient:'learner'} as const;
let content: Promise<LoadedModule> | undefined;
export type OpenedRelationSource = {ref:SourceRefV1; witness:WorkspaceWitness};
const sourceKey = (ref:SourceRefV1) => `${ref.fact.id}:${ref.fact.rev}`;
const reopen = (refs: string | string[]) =>
  ({tool:'open_learning' as const,args:{refs},why:'打开并核对这次写入所用的固定来源。'});
const retry = {tool:'save_relation' as const,args:{},why:'使用已打开的 from、to，填写 kind 与 scope。'};
const search = {tool:'search_workspace' as const,args:{},why:'选择当前获准的端点和来源。'};

export function openWorkspaceRelation(options: {
  db:Db; turn:string;
  opened:ReadonlyMap<string, OpenedRelationSource>;
  maySend:WorkspaceSourceRecipient;
  authorize(tx:ReadTransaction):Promise<void>;
}) {
  const {db,opened} = options;
  const access = {recipient:'workspace',maySend:options.maySend} as const;

  return async (args: Record<string, unknown>, step: number) => {
    const {kind,from,to,scope:relationScope,sources = [],verification,variant} = args;
    if (!Array.isArray(sources) || sources.length > openLearningLimit - 2)
      return learningToolError('invalid_args','sources','请传至多 6 个补充来源引用。',retry);
    const inputs = [['from',from],['to',to], ...sources.map(ref => ['sources',ref]),
      ...(verification === undefined ? [] : [['verification',verification]])] as [string,unknown][];
    const picked: OpenedRelationSource[] = [];
    for (const [field, raw] of inputs) {
      const ref = typeof raw === 'string' && raw.length <= 4096 ? parseLearningReference(raw) : undefined;
      if (!ref || (typeof ref !== 'string' && ref.anchor.kind !== 'whole'))
        return learningToolError('invalid_args',field,'请传整份记录的 id 或固定 sourceRef。',retry);
      const id = typeof ref === 'string' ? ref : ref.fact.id;
      const versions = [...opened.values()].filter(item => item.ref.fact.id === id);
      const source = typeof ref === 'string' ? versions.at(-1) : opened.get(sourceKey(ref));
      if (!source || (typeof ref !== 'string' && (source.ref.fact.type !== ref.fact.type ||
          JSON.stringify(source.ref.textFact) !== JSON.stringify(ref.textFact)))) {
        return versions.length
          ? learningToolError('version_conflict',field,'引用版本与本轮打开的版本不符。',reopen(id))
          : learningToolError('evidence_not_opened',field,'请先打开本轮要引用的记录。',reopen(typeof ref === 'string' ? ref : JSON.stringify(ref)));
      }
      if (source.ref.textFact)
        return learningToolError('invalid_args',field,'配对材料请把固定原件用作来源。',
          reopen(JSON.stringify({v:1,fact:source.ref.textFact,anchor:whole})));
      if ((field === 'verification') !== (source.ref.fact.type === knowledgeEdgeEvidenceType))
        return learningToolError('invalid_args',field,'核验证明只接受已打开的专用证明事实。',retry);
      picked.push(source);
    }
    const refs = [...new Set(picked.map(({ref}) => ref.fact.id))].slice(0,openLearningLimit);
    const uses = picked.map(({witness:w}) => sourceUse({id:w.id,rev:w.rev,accessEpoch:w.epoch}));
    const proof = verification === undefined ? undefined : uses.pop()!;
    const id = factId(stableId('knowledge-edge',options.turn,String(step)));
    const key = commandId(stableId('save-relation-command',options.turn,String(step)));
    const read = (tx:ReadTransaction) => createAuthorizedFactReader(tx,purpose,options.maySend);
    try {
      const endpoints = await db.snapshot(scope, async tx => {
        const reader = read(tx);
        return Promise.all([0,1].map(async index => {
          const use = uses[index]!;
          const root = picked[index]!.witness;
          const fact = await reader.reopen({...use,mode:'pinned',type:root.type});
          return {kind:knowledgeEndpointKind(fact),sourceUse:use};
        }));
      });
      let edge;
      try {
        edge = parseEdgeClaim({kind, from:endpoints[0], to:endpoints[1], scope:relationScope,
          sourceUses:[...new Map(uses.map(use => [knowledgeUseKey(use),use])).values()],
          ...(variant === undefined ? {} : {variant})});
      } catch (error) {
        return learningToolError('invalid_args','args',error instanceof Error ? error.message : '知识边参数无效。',retry);
      }
      const authorize = async (tx:ReadTransaction) => {
        await readKnowledgeSources(tx,edge,access);
        await readKnowledgeSources(tx,edge,owner);
        if (proof) await read(tx).reopen({...proof,mode:'pinned',type:knowledgeEdgeEvidenceType});
        await options.authorize(tx);
      };
      await db.snapshot(scope, authorize);
      const handle = createCommandHandler(db,{
        modules:[await (content ??= loadModuleDirectory(fileURLToPath(new URL('../../modules/content',import.meta.url))))],
        hooks:{...createStudioCommandHooks({afterFactsChanged:authorize}),beforeProposal:authorize},
      });
      const receipt = await handle({...scope,actor:'companion',purpose,id:key,
        type:proof ? createVerifiedKnowledgeEdgeCommand : createKnowledgeEdgeCommand,
        input:{id,purpose,edge,...(proof ? {verification:proof} : {})}});
      if (receipt.state === 'proposed') return {ok:true,status:'proposed',proposalId:key};
      const written = receipt.wrote[0]!;
      return {ok:true,status:'saved',ref:{v:1,fact:{id:written.id,rev:written.rev,type:knowledgeEdgeType},anchor:whole},
        rev:written.rev,undo_token:key};
    } catch (error) {
      if (error instanceof KnowledgeEdgeEvidenceError)
        return learningToolError('invalid_args','verification',error.message,{
          tool:'open_learning',args:{refs:proof!.id},why:'核对证明对应的有向边及来源，再决定是否使用这份证明。',
        });
      if (error instanceof KnowledgeEdgeBasisError || (error instanceof FactReadDeniedError && error.reason === 'changed'))
        return learningToolError('basis_stale','sources','写入依据已变化，请重新打开。',reopen(refs));
      if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError)
        return learningToolError('access_revoked','sources','本轮打开的依据当前不可用。',search);
      throw error;
    }
  };
}

export function openRelationReview(db:Db, contentModule:LoadedModule) {
  const handle = createCommandHandler(db,{modules:[contentModule],hooks:createStudioCommandHooks()});
  function translate(error:unknown): never {
    if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError || error instanceof KnowledgeEdgeBasisError)
      throw new RequestError(409,'知识边依据已变化或不可读。');
    if (error instanceof Error && error.message === 'Proposal not found')
      throw new RequestError(404,'找不到知识边提议。');
    if (error instanceof Error && (error.message === 'Proposal already decided' || error.message.startsWith('Fact revision conflict:')))
      throw new RequestError(409,'知识边状态已变化。');
    throw error;
  }
  return {
    async proposal(id:string) {
      return db.snapshot(scope,async tx => {
        const [proposal] = await readCommandProposals(tx,createKnowledgeEdgeCommand,{},commandId(id));
        if (!proposal) throw new RequestError(404,'找不到知识边提议。');
        const {edge} = parseEdgeWrite(proposal.input);
        const {from,to,sources} = await readKnowledgeSources(tx,edge,owner);
        return {proposalId:proposal.id,status:proposal.state,kind:edge.kind,scope:edge.scope,
          from:from.sourceRef,to:to.sourceRef,sources,...(edge.variant ? {variant:edge.variant} : {})};
      }).catch(translate);
    },
    async accept(id:string) {
      const proposalId = commandId(id);
      const key = commandId(stableId('accept-knowledge-edge',id));
      const receipt = await handle.decideProposal({...scope,id:key,type:createKnowledgeEdgeCommand,purpose,
        proposalId,selection:'accept'},async (tx,input) => {
        const {edge} = parseEdgeWrite(input);
        await readKnowledgeSources(tx,edge,{recipient:'workspace',maySend:()=>true});
        await readKnowledgeSources(tx,edge,owner);
        return input;
      }).catch(translate);
      const written = receipt.wrote[0]!;
      return {status:'saved',proposalId,commandId:key,ref:{v:1,fact:{id:written.id,rev:written.rev,type:knowledgeEdgeType},anchor:whole},
        rev:written.rev,undo_token:key};
    },
    async undo(id:string, input:Record<string,unknown>) {
      const token = input.undo_token;
      if (!isSourceFactId(token)) throw new RequestError(400,'撤回凭据无效。');
      const {rows:[birth]} = await db.query<{rev:number}>(
        `SELECT r.rev FROM fact_revs r JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
         JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
         WHERE r.learner_id=$1 AND r.fact_id=$2 AND c.id=$3 AND f.type=$4 AND r.rev=1 AND c.state='done'
           AND ((c.type=$5 AND r.author='companion') OR (c.type=$6 AND c.input->'input' ? 'proposalId'))`,
        [studioLearner,id,token,knowledgeEdgeType,createVerifiedKnowledgeEdgeCommand,createKnowledgeEdgeCommand]);
      if (!birth) throw new RequestError(404,'找不到可撤回的知识边。');
      const receipt = await handle({...scope,id:commandId(stableId('withdraw-knowledge-edge',token)),actor:'learner',
        type:withdrawKnowledgeEdgeCommand,purpose:'storage',input:{id,expectedRev:birth.rev}}).catch(translate);
      const written = receipt.wrote[0]!;
      return {status:'withdrawn',ref:{id:written.id,rev:written.rev}};
    },
  };
}
