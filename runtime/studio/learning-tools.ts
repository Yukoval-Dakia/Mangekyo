import { memoryRetrieveQuery } from '../../modules/companion/belief.ts';
import { ClaimInputError } from '../../modules/companion/claim.ts';
import { toolFailure, type HostedTool, type LearningTools, type LearningResult } from '../../executors/teaching/learning-tools.ts';
import { workspaceDefinitions } from '../../executors/teaching/workspace-tools.ts';
import type { Tick } from '../../kernel/src/declarations/ids.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { createAuthorizedFactReader, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { recallRegions, type ContextBundle, type MemoryIntent, type RegionPage } from '../../modules/companion/recall-packet.ts';
import { purpose, studioLearner } from './identity.ts';
import { checkStudioNotionFact, confirmNotionRead } from './notion.ts';
import { readLearningSdk } from './learning-sdk.ts';
import { readRetentionBasis, type RetentionBasis } from './learner-radar.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';
import { openWorkspaceQuestion, type DraftWitness } from './workspace-question.ts';
import { workspaceInput, type openWorkspaceTools, type WorkspaceWitness } from './workspace-agent.ts';

const scope = {learner:studioLearner};
const native = {search_learning:'search_workspace',open_learning:'open_learning',
  save_page:'save_page',save_edge:'save_relation'} as const;
function renamed<K extends keyof typeof native>(name: K) {
  const definition = workspaceDefinitions.find(tool => tool.function.name === native[name])!;
  return {...definition,function:{...definition.function,name}};
}
function tool<K extends string>(name: K, description: string, properties: object, required: string[] = []) {
  return {type:'function',function:{name,description,parameters:{type:'object',additionalProperties:false,properties,required}}};
}
const fallback = (name: string) => ({tool:'find_tools',args:{query:name}});
function existing(raw: string, name: HostedTool): LearningResult {
  const value = JSON.parse(raw);
  if (value?.ok !== false) return {ok:true,data:value};
  const code = value.code;
  const next = value.next?.tool;
  const redirect = next === 'read_workspace' ? 'open_learning' : next === 'search_workspace' ? 'search_learning' :
    next === 'save_relation' ? 'save_edge' : next;
  const args = next === 'read_workspace' ? {refs:value.next.args.id} : value.next?.args;
  const retry = redirect && args && ['open_learning','search_learning','save_page','save_edge','save_belief'].includes(redirect)
    ? {tool:redirect,args} : fallback(name);
  return toolFailure(code === 'budget_or_limit' ? 'limit_exceeded' :
    ['invalid_args','not_found','access_revoked','basis_stale','version_conflict','evidence_not_opened','limit_exceeded'].includes(code)
      ? code : 'invalid_args',String(value.message ?? '工具无法完成。'),retry,value.field);
}
const intents = ['tutoring','planning','execution','history'] as const satisfies readonly MemoryIntent[];
export function openLearningTools(options: {
  db: Db; turn: string; manageBeliefs: boolean; workspace: ReturnType<typeof openWorkspaceTools>; maySend: WorkspaceSourceRecipient;
  authorize(tx: ReadTransaction): Promise<void>; authorizeRemote(): Promise<boolean>;
  track(witness: WorkspaceWitness): void;
  trackRetention(basis: RetentionBasis): void;
  readContext(intent: MemoryIntent, step: number, expand?: RegionPage, query?: string): Promise<ContextBundle | undefined>;
  onDelivered: NonNullable<LearningTools['onDelivered']>;
  draftBasis(): DraftWitness[];
  saveBelief(args: Record<string,unknown>, step: number): Promise<string>;
}): LearningTools {
  const {db,turn,workspace,maySend,authorize} = options;
  const allowedIntents: readonly MemoryIntent[] = options.manageBeliefs ? [...intents,'management'] : intents;
  const question = openWorkspaceQuestion(db,turn,maySend,authorize,options.draftBasis);
  const artifact = workspace.presentationTool;
  const pages = new Map<string,RegionPage>();
  const valid = async (facts: readonly WorkspaceWitness[], retention: readonly RetentionBasis[]) => confirmNotionRead(db,studioLearner,async (tx,check) => {
    await authorize(tx);
    const {rows:[clock]} = await tx.query<{tick:string}>('SELECT clock::text AS tick FROM learners WHERE id=$1',[tx.learner]);
    const manifest = parseManifest({version:1,learner:tx.learner,purpose,gatherTick:clock?.tick,inputs:facts.map(workspaceInput)});
    if ((await revalidateManifest(tx,manifest)).kind !== 'valid') return false;
    const read = createAuthorizedFactReader(tx,purpose,maySend);
    for (const witness of facts) {
      const fact = await read.reopen({...workspaceInput(witness),type:witness.type});
      await checkStudioNotionFact(tx,fact,purpose,maySend);
      await check(fact);
    }
    for (const basis of retention) {
      const current = await readRetentionBasis(tx,basis.slot,{callerPurpose:purpose,maySend});
      if (!current || canonicalJsonString(current) !== canonicalJsonString(basis)) return false;
    }
    return true;
  });
  return {
    onDelivered: options.onDelivered,
    definitions:{
      search_learning:renamed('search_learning'),open_learning:renamed('open_learning'),
      read_context:tool('read_context','读取已授权学习上下文，intent 支持 radar、tutoring、conversation、planning、execution、history。从返回的 omitted.expand 可打开更多本轮已授权内容。当前只读当前视点。' +
        (options.manageBeliefs ? '更正或忘记记忆前，用 management 和可选 query 查找原条目。' : ''),{
        intent:{type:'string',enum:['radar','conversation',...allowedIntents]},
        ...(options.manageBeliefs ? {query:{type:'string',minLength:1,maxLength:120}} : {}),horizon_hours:{type:'integer',minimum:1,maximum:168},
        expand:{type:'object',additionalProperties:false,required:['region','start','basisDigest'],properties:{
          region:{type:'string'},start:{type:'integer',minimum:0},basisDigest:{type:'string',pattern:'^[0-9a-f]{64}$'},
        }},
      },['intent']),
      save_page:renamed('save_page'),save_edge:renamed('save_edge'),
      save_question:tool('save_question','保存独立题面草稿。题库核验前不可发放。',{
        title:{type:'string',maxLength:240},prompt:{type:'string',maxLength:8000},
        response_schema:{type:'array',items:{type:'object'},maxItems:32},
        assessment_contract:{type:'array',items:{type:'object'},maxItems:32},
      },['title','prompt']),
      manage_activity:tool('manage_activity','用正常挂载命令为当前回合发放作品。动作 mount_artifact。',{
        action:{const:'mount_artifact'},...((artifact?.function.parameters.properties ?? {}) as object),
      },['action','view']),
      ...(artifact ? {mount_artifact:{...artifact,function:{...artifact.function,name:'mount_artifact' as const}}} : {}),
    },
    async execute(name,args,{step,handles,receiveImage,priorRead}) {
      if (name === 'search_learning' || name === 'open_learning')
        return existing(await workspace.executeRead(native[name],args,step,priorRead,receiveImage),name);
      if (name === 'save_page' && (Object.keys(handles).length || 'insert_artifacts' in args))
        return toolFailure('not_found','目前教材只接支持的正文和块，保存计算产物尚未接入。',fallback(name));
      if (name === 'save_page' || name === 'save_edge')
        return existing(await workspace.execute(native[name],args,step),name);
      if (name === 'save_belief') {
        if (options.manageBeliefs && (args.action === 'update' || args.action === 'forget') && args.supersedes === undefined)
          return toolFailure('invalid_args','请先查找要更正或忘记的原条目。',{tool:'read_context',args:{intent:'management'}},'supersedes');
        return existing(await options.saveBelief(args,step),name);
      }
      if (name === 'save_question') return question(args,step);
      if (name === 'manage_activity' || name === 'mount_artifact') {
        const {action,...work} = args;
        if (!artifact || (name === 'manage_activity' && action !== 'mount_artifact'))
          return toolFailure('invalid_args','目前可在当前回合挂载作品。',fallback(name));
        return existing(await workspace.execute('mount_artifact',name === 'manage_activity' ? work : args,step),name);
      }
      if (name === 'read_context') {
        await priorRead;
        const management = options.manageBeliefs && args.intent === 'management';
        if (Object.keys(args).some(key => !['intent','horizon_hours','expand'].includes(key) && !(management && key === 'query')) ||
            (args.horizon_hours !== undefined && args.intent !== 'radar') ||
            (args.expand !== undefined && args.intent === 'radar'))
          return toolFailure('invalid_args','此读取仅支持当前视点。',{tool:'read_context',args:{intent:'tutoring'}});
        if (args.intent === 'radar') return existing(await workspace.execute('read_learner_radar',
          args.horizon_hours === undefined ? {} : {horizon_hours:args.horizon_hours},step),name);
        const intent = args.intent === 'conversation' ? 'tutoring' : allowedIntents.find(value => value === args.intent);
        if (!intent) return toolFailure('not_found','此上下文意图尚无授权的生产读取。',{tool:'read_context',args:{intent:'tutoring'}});
        let query: string | undefined;
        if (management) {
          try { query = memoryRetrieveQuery({query:args.query}); }
          catch (error) {
            if (!(error instanceof ClaimInputError)) throw error;
            return toolFailure('invalid_args',error.message,{tool:'read_context',args:{intent}},'query');
          }
        }
        const next = {tool:'read_context',args:{intent,...(query ? {query} : {})}};
        const expand = args.expand === undefined ? undefined : pages.get(canonicalJsonString(args.expand));
        if (args.expand !== undefined && !expand)
          return toolFailure('not_found','请传本轮已返回的展开位置。',next,'expand');
        if (expand) {
          try { recallRegions(intent,8192,expand); }
          catch { return toolFailure('invalid_args','展开位置与所选意图不符。',next,'expand'); }
        }
        const context = await options.readContext(intent,step,expand,query);
        if (!context || context.omitted.some(item => item.reason === 'basis_stale'))
          return toolFailure('basis_stale','上下文见证已变化。',next);
        for (const item of context.omitted) if (item.reason === 'budget')
          pages.set(canonicalJsonString(item.expand),item.expand);
        return {ok:true,data:context};
      }
      return toolFailure('not_found','本轮没有此按需工具。',fallback(name));
    },
    writeKeys:() => [],
    async preparePython(reads,step) {
      if (!reads.length) return {ok:true,values:[]};
      const raw = await recordLocalRead(db,{...scope,ownerKind:'session',ownerId:turn,stepKey:String(step),
        label:'local:learning-python-v1',input:JSON.parse(canonicalJsonString(reads))},async tx => {
        const {rows:[clock]} = await tx.query<{tick:Tick}>(
          'SELECT clock::text AS tick FROM learners WHERE id=$1',[tx.learner]);
        if (!clock) throw new Error('Learner clock missing');
        const witnesses: WorkspaceWitness[] = [];
        const retention = new Map<string,RetentionBasis>();
        const access = {maySend,known:workspace.knows,trackRetention:(basis:RetentionBasis) =>
          retention.set(basis.slot.derivationId,basis),track:(fact: Parameters<import('./source-read.ts').SourceTrack>[0],
          mode?: WorkspaceWitness['mode']) => witnesses.push({id:fact.ref.id,rev:fact.ref.rev,type:fact.type,epoch:fact.accessEpoch,
            ...(mode ? {mode} : {})})};
        const now = new Date().toISOString();
        const values = [];
        for (const request of reads) {
          const result = await readLearningSdk(tx,request,access,now,clock.tick);
          if ('ok' in result) return JSON.stringify({error:result,witnesses:[]});
          values.push(result.value);
        }
        return JSON.stringify({values,witnesses:[...new Map(witnesses.map(w => [canonicalJsonString(w),w])).values()],
          ...(retention.size ? {retentionBasis:[...retention.values()]} : {})});
      },authorize);
      const packet = JSON.parse(raw);
      if (packet.error) return packet.error;
      try {
        const retention = packet.retentionBasis ?? [];
        if (await valid(packet.witnesses,retention)) {
          for (const basis of retention) options.trackRetention(basis);
          for (const witness of packet.witnesses as WorkspaceWitness[]) options.track(witness);
          return {ok:true,values:packet.values};
        }
      } catch (error) {
        if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
      }
      return toolFailure('access_revoked','该计算的原始读取已不再获准。',fallback('run_calculation'));
    },
    async authorizeHandles() {
      // Follow-up provider rounds contain earlier tool messages. Recheck their
      // cumulative basis even when the next call names only one of the handles.
      return await options.authorizeRemote() ? {ok:true}
        : toolFailure('access_revoked','结果句柄的依据已不再获准。',fallback('open_tool_result'));
    },
    writes:workspace.writes,
  };
}
