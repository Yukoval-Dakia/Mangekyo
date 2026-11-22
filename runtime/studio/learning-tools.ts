import { memoryRetrieveQuery } from '../../modules/companion/belief.ts';
import { ClaimInputError } from '../../modules/companion/claim.ts';
import { adaptWorkspaceResult, learningHostDefinitions, learningToolFallback, toolFailure, workspaceToolAliases, type LearningTools } from '../../executors/teaching/learning-tools.ts';
import { executeNotionRead, notionReadDefinition, notionReadWriteKeys, type NotionReadHostPort, type NotionReadOutput } from '../../executors/teaching/notion-read-tool.ts';
import type { Tick } from '../../kernel/src/declarations/ids.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { isFactUnavailable, purposeReader } from './fact-read-helpers.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { recallRegions, type ContextBundle, type MemoryIntent, type RegionPage } from '../../modules/companion/recall-packet.ts';
import { captureSourceType } from '../../modules/capture/source.ts';
import { purpose, studioLearner } from './identity.ts';
import { checkStudioNotionFact, confirmNotionRead, type openStudioNotion } from './notion.ts';
import { readLearningSdk } from './learning-sdk.ts';
import { readRetentionBasis, type RetentionBasis } from './learner-radar.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';
import { workspaceInput, type openWorkspaceTools, type WorkspaceWitness } from './workspace-agent.ts';
import { learningPythonReadLabel, questionExposureReceiptVersion } from '../../executors/teaching/question-read-receipts.ts';
import { questionReceiptsCurrent } from './question-exposure.ts';

const scope = {learner:studioLearner};
const intents = ['tutoring','planning','execution','history'] as const satisfies readonly MemoryIntent[];
export function openLearningTools(options: {
  db: Db; turn: string; manageBeliefs: boolean; workspace: ReturnType<typeof openWorkspaceTools>; maySend: WorkspaceSourceRecipient;
  authorize(tx: ReadTransaction): Promise<void>; authorizeRemote(): Promise<boolean>;
  track(witness: WorkspaceWitness): void;
  trackRetention(basis: RetentionBasis): void;
  readContext(intent: MemoryIntent, step: number, expand?: RegionPage, query?: string): Promise<ContextBundle | undefined>;
  onDelivered: NonNullable<LearningTools['onDelivered']>;
  saveBelief(args: Record<string,unknown>, step: number): Promise<string>;
  notion?: Pick<ReturnType<typeof openStudioNotion>, 'readTool'>;
}): LearningTools {
  const {db,turn,workspace,maySend,authorize} = options;
  const allowedIntents: readonly MemoryIntent[] = options.manageBeliefs ? [...intents,'management'] : intents;
  const artifact = workspace.presentationTool;
  const pages = new Map<string,RegionPage>();
  const notionReadHost: NotionReadHostPort | undefined = options.notion && {
    read: (input, {step}) => options.notion!.readTool(input, step,
      {purpose, recipientId: maySend.notionRecipientId ?? '', maySend}, authorize),
  };
  const valid = async (facts: readonly WorkspaceWitness[], retention: readonly RetentionBasis[]) => confirmNotionRead(db,studioLearner,async (tx,check) => {
    await authorize(tx);
    const {rows:[clock]} = await tx.query<{tick:string}>('SELECT clock::text AS tick FROM learners WHERE id=$1',[tx.learner]);
    const manifest = parseManifest({version:1,learner:tx.learner,purpose,gatherTick:clock?.tick,inputs:facts.map(workspaceInput)});
    if ((await revalidateManifest(tx,manifest)).kind !== 'valid' || !await questionReceiptsCurrent(tx,turn,'dispatch')) return false;
    const read = purposeReader(tx,maySend);
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
    definitions:learningHostDefinitions(options.manageBeliefs,allowedIntents,artifact,notionReadHost && notionReadDefinition),
    async execute(name,args,{step,handles,receiveImage,priorRead}) {
      if (name === 'search_learning' || name === 'open_learning')
        return adaptWorkspaceResult(await workspace.executeRead(workspaceToolAliases[name],args,step,priorRead,receiveImage),name);
      if (name === 'notion_read') {
        if (!notionReadHost) return toolFailure('not_found','本轮没有此按需工具。',learningToolFallback(name));
        await priorRead;
        const result = await executeNotionRead(args, notionReadHost, {step});
        if (result.ok) {
          const read = result.data as NotionReadOutput;
          options.track({id:read.sourceId, rev:read.rev, type:captureSourceType, epoch:read.accessEpoch, mode:'pinned'});
        }
        return result;
      }
      if (name === 'save_page' && (Object.keys(handles).length || 'insert_artifacts' in args))
        return toolFailure('not_found','目前教材只接支持的正文和块，保存计算产物尚未接入。',learningToolFallback(name));
      if (name === 'save_page' || name === 'save_edge')
        return adaptWorkspaceResult(await workspace.execute(workspace.narrowSaves ? name : workspaceToolAliases[name],args,step),name);
      if (name === 'save_belief') {
        if (options.manageBeliefs && (args.action === 'update' || args.action === 'forget') && args.supersedes === undefined)
          return toolFailure('invalid_args','请先查找要更正或忘记的原条目。',{tool:'read_context',args:{intent:'management'}},'supersedes');
        return adaptWorkspaceResult(await options.saveBelief(args,step),name);
      }
      if (name === 'save_question') return workspace.saveQuestion?.(args,step)
        ?? toolFailure('not_found','当前回合没有题库写入绑定。',learningToolFallback(name));
      if (name === 'manage_activity' || name === 'mount_artifact') {
        const {action,...work} = args;
        if (!artifact || (name === 'manage_activity' && action !== 'mount_artifact'))
          return toolFailure('invalid_args','目前可在当前回合挂载作品。',learningToolFallback(name));
        return adaptWorkspaceResult(await workspace.execute('mount_artifact',name === 'manage_activity' ? work : args,step),name);
      }
      if (name === 'read_context') {
        await priorRead;
        const management = options.manageBeliefs && args.intent === 'management';
        if (Object.keys(args).some(key => !['intent','horizon_hours','expand'].includes(key) && !(management && key === 'query')) ||
            (args.horizon_hours !== undefined && args.intent !== 'radar') ||
            (args.expand !== undefined && args.intent === 'radar'))
          return toolFailure('invalid_args','此读取仅支持当前视点。',{tool:'read_context',args:{intent:'tutoring'}});
        if (args.intent === 'radar') return adaptWorkspaceResult(await workspace.execute('read_learner_radar',
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
      return toolFailure('not_found','本轮没有此按需工具。',learningToolFallback(name));
    },
    writeKeys:(name) => name === 'notion_read' ? notionReadWriteKeys() : [],
    async preparePython(reads,step) {
      if (!reads.length) return {ok:true,values:[]};
      // Question reads cannot replay across receipt formats. Other SDK effects keep their identity.
      const request = reads.some(read => read.method === 'questions') ? {reads,questionExposure:questionExposureReceiptVersion} : reads;
      const raw = await recordLocalRead(db,{...scope,ownerKind:'session',ownerId:turn,stepKey:String(step),
        label:learningPythonReadLabel,input:JSON.parse(canonicalJsonString(request))},async tx => {
        const {rows:[clock]} = await tx.query<{tick:Tick}>(
          'SELECT clock::text AS tick FROM learners WHERE id=$1',[tx.learner]);
        if (!clock) throw new Error('Learner clock missing');
        const witnesses: WorkspaceWitness[] = [];
        const retention = new Map<string,RetentionBasis>();
        const negatives = new Set<string>();
        const access = {turn,maySend,trackNegative:(id: string) => negatives.add(id),known:workspace.knows,trackRetention:(basis:RetentionBasis) =>
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
        return JSON.stringify({values,questionExposure:questionExposureReceiptVersion,questionNegatives:[...negatives],
          witnesses:[...new Map(witnesses.map(w => [canonicalJsonString(w),w])).values()],
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
    if (!isFactUnavailable(error)) throw error;
      }
      return toolFailure('access_revoked','该计算的原始读取已不再获准。',learningToolFallback('run_calculation'));
    },
    async authorizeHandles() {
      // Follow-up provider rounds contain earlier tool messages. Recheck their
      // cumulative basis even when the next call names only one of the handles.
      return await options.authorizeRemote() ? {ok:true}
        : toolFailure('access_revoked','结果句柄的依据已不再获准。',learningToolFallback('open_tool_result'));
    },
    writes:workspace.writes,
  };
}
