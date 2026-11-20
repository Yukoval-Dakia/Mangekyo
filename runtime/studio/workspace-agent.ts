import {fileURLToPath} from 'node:url';
import {createCommandReadContext, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import {createCommandHandler} from '../../kernel/src/commands/handle.ts';
import {canonicalJsonString} from '../../kernel/src/commands/canonical.ts';
import {recordLocalRead} from '../../kernel/src/work/effects.ts';
import {commandId, factId, type Revision, type Tick} from '../../kernel/src/declarations/ids.ts';
import {isJson} from '../../kernel/src/declarations/define.ts';
import type {FactSnapshot} from '../../kernel/src/declarations/types.ts';
import type {Db, ReadTransaction} from '../../kernel/src/db/types.ts';
import {loadModuleDirectory} from '../../kernel/src/loader.ts';
import {TeachingError} from '../../executors/teaching/provider.ts';
import {openLearningLimit, workspaceDefinitions, type WorkspaceWriteReceipt} from '../../executors/teaching/workspace-tools.ts';
import type {SourceReadMode, SourceTrack} from './source-read.ts';
import {workspaceSearch, workspaceRead, workspaceSourceUnavailable, workspaceAssessmentBasis, type WorkspaceAssessmentBasis} from './workspace-read.ts';
import {learningToolError, openLearningBatch, parseLearningReference, parseOpenLearningArgs} from './workspace-open.ts';
import {readLearnerRadar, readRetentionBasis, type RetentionBasis} from './learner-radar.ts';
import {sourceRefV1} from '../../modules/activity/source-values.ts';
import {workbookAttemptType, workbookPaperType} from '../../modules/activity/workbook-values.ts';
import {goalType} from '../../modules/activity/library-values.ts';
import {organizerTaskType} from '../../modules/activity/organizer-values.ts';
import {WorkspaceInputError, workspaceAttemptTypes, workspaceEntry, workspaceEntryType, type WorkspaceEntryBasis} from '../../modules/activity/workspace-values.ts';
import {purpose, stableId, studioLearner} from './identity.ts';
import {createStudioCommandHooks} from './command-hooks.ts';

import {presentationCatalog} from '../../surfaces/shared/presentation/index.ts';
import type {Manifest} from '../../kernel/src/derivations/manifest.ts';
import {mountArtifact} from './presentation-store.ts';
import type { ReadArtifactAssessmentWitness } from './artifact-assessment.ts';

const presentationTool = {type:'function',function:{name:'mount_artifact',
  description:'用组件目录创作当前回合的互动作品。view 只含可向学生展示的题面，排除答案和评分依据。需要先冻结预测时提供 predictionPrompt。正式断句另传 sentenceBreaks（两套完整断点 ID），预测必填，题面和回复都不得包含断法。宿主独立核验后才正式发放。'+presentationCatalog.bindings,
  parameters:{type:'object',required:['view'],additionalProperties:false,properties:{
    view:presentationCatalog.schema,predictionPrompt:{type:'string',maxLength:160},
    sentenceBreaks:{type:'array',minItems:2,maxItems:2,items:{type:'array',minItems:1,maxItems:128,items:{type:'string'}}}
  }}}};
export type WorkspaceWitness = {id: string; rev: number; epoch: string; type: string; mode?: SourceReadMode};
type Seen = {id: string; title: string; text: string; workspace: true};
const activity = () => loadModuleDirectory(fileURLToPath(new URL('../../modules/activity', import.meta.url)));
let declarations: ReturnType<typeof activity> | undefined;

export function openWorkspaceTools(options: {
  db: Db; turn: string;
  authorize: (tx: ReadTransaction) => Promise<void>;
  maySend: (input: FactSnapshot) => boolean;
  track: (input: WorkspaceWitness) => void;
  trackAssessment?: (basis: WorkspaceAssessmentBasis) => void;
  trackRetention?: (basis: RetentionBasis) => void;
  trackDiagnosis?: () => void;
  presentationManifest?: (tx:ReadTransaction)=>Promise<Manifest>;
  readArtifactAssessmentWitness?: ReadArtifactAssessmentWitness | undefined;
  prior: WorkspaceWitness[];
}) {
  const {db, turn} = options;
  let publishedFormalArtifact = false;
  const sources = new Map(options.prior.map(input => [input.id, input]));
  const overviewBasis = new Map<string, WorkspaceWitness>();
  const opened = new Map<string, Seen>();
  const openedAnswers = new Map<string, WorkspaceWitness>();
  const produced = new Map<string, number>();
  const receipts = new Map<string,WorkspaceWriteReceipt>();
  async function read(name: string, args: Record<string, unknown>, step: number, priorRead?: Promise<unknown>) {
    if (!isJson(args)) return JSON.stringify({error:'请将查询字段放在一个 JSON 对象里。'});
    const raw = await recordLocalRead(db, {learner:studioLearner, ownerKind:'session', ownerId:turn,
      stepKey:String(step), label:'local:'+name, input:args}, async tx => {
      const witnesses = new Map<string, WorkspaceWitness>();
      const track: SourceTrack = (fact, mode) => {
        const key = `${fact.ref.id}:${fact.ref.rev}`;
        if (mode === 'pinned' && witnesses.has(key)) return;
        witnesses.set(key, {id:fact.ref.id, type:fact.type, rev:fact.ref.rev, epoch:fact.accessEpoch, ...(mode ? {mode} : {})});
      };
      const assessmentBasis: WorkspaceAssessmentBasis[] = [];
      const retentionBasis: RetentionBasis[] = [];
      const trackAssessment = options.trackAssessment ? (basis: WorkspaceAssessmentBasis) => assessmentBasis.push(basis) : undefined;
      let text;
      if (name === 'open_learning') {
        const parsed = parseOpenLearningArgs(args);
        text = JSON.stringify('ok' in parsed ? parsed : await openLearningBatch(tx,parsed,{
          known:id => sources.has(id), maySend:options.maySend, track, trackAssessment,
        }, (id, itemTrack) => workspaceRead(tx,{id},itemTrack,options.maySend,
          parsed.part.kind === 'assessment' ? trackAssessment : undefined)));
      } else if (name === 'read_workspace') {
        text = await workspaceRead(tx,args,track,options.maySend,trackAssessment);
      } else if (name === 'read_learner_radar') {
        text = JSON.stringify(await readLearnerRadar(tx,args,options.maySend,track,
          options.trackRetention ? basis => retentionBasis.push(basis) : undefined));
      } else text = await workspaceSearch(tx,args,track,options.maySend);
      return JSON.stringify({text,witnesses:[...witnesses.values()],assessmentBasis,
        ...(name === 'read_workspace' ? {workbookProjection: 1} : {}),
        ...(name === 'read_learner_radar' ? {retentionBasis} : {})});
    },options.authorize);
    if (priorRead) await priorRead;
    const {text, witnesses, assessmentBasis, workbookProjection, retentionBasis = []} = JSON.parse(raw) as {
      text:string; witnesses:WorkspaceWitness[]; assessmentBasis?: WorkspaceAssessmentBasis[]; workbookProjection?: number;
      retentionBasis?: RetentionBasis[];
    };
    const value = JSON.parse(text);
    const trackedBasis = assessmentBasis ?? [];
    const legacyWorkbookRead = name === 'read_workspace' && workbookProjection !== 1 && value.sourceRef?.anchor.kind === 'whole' &&
      [workbookPaperType, workbookAttemptType].includes(value.sourceRef.fact.type);
    const current = await db.snapshot({learner: studioLearner}, async tx => {
      if (legacyWorkbookRead) return false;
      const reader = createCommandReadContext(tx, purpose);
      try {
        for (const witness of witnesses) {
          const input = workspaceInput(witness);
          const fact = await reader.fact(input.id, input);
          if (fact.ref.rev !== witness.rev || fact.type !== witness.type ||
            fact.accessEpoch !== witness.epoch || !options.maySend(fact)) return false;
        }
      } catch (error) {
        if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return false;
        throw error;
      }
      if (trackedBasis.length && !options.trackAssessment) return false;
      for (const basis of trackedBasis) {
        const actual = await workspaceAssessmentBasis(tx, basis.slot, options.maySend);
        if (!actual || canonicalJsonString(actual) !== canonicalJsonString(basis)) return false;
      }
      if (retentionBasis.length && !options.trackRetention) return false;
      for (const basis of retentionBasis) {
        const actual = await readRetentionBasis(tx,basis.slot,{callerPurpose:purpose,maySend:options.maySend});
        if (!actual || canonicalJsonString(actual) !== canonicalJsonString(basis)) return false;
      }
      for (const witness of witnesses) options.track(witness);
      for (const basis of trackedBasis) options.trackAssessment?.(basis);
      for (const basis of retentionBasis) options.trackRetention?.(basis);
      await options.authorize(tx);
      return true;
    });
    if (!current) {
      if (retentionBasis.length) throw new TeachingError('evidence_scope', '保持依据已变化，本轮结果无法使用。');
      if (trackedBasis.length || legacyWorkbookRead) throw new TeachingError('evidence_scope', '作答依据已变化，本轮结果无法使用。');
      if (name === 'open_learning') return JSON.stringify(learningToolError('basis_stale','refs','读取依据在打开后已变化。',{
        tool:'open_learning',args,why:'重新读取当前获准的版本。',
      }));
      return workspaceSourceUnavailable;
    }
    const values: typeof value[] = name === 'open_learning' ? value.items ?? [] : [value];
    if (name === 'open_learning' && args.lens === 'diagnose' && values.some(item => item.lens === 'diagnose')) {
      options.trackDiagnosis?.();
      for (const witness of witnesses) overviewBasis.set(witness.id, witness);
    }
    const direct = new Set<string>([value.id,args.related,
      ...values.flatMap(item => [item.id, item.related, ...[...(item.results ?? []), ...(item.observations ?? []),
        ...(item.recentAttempts ?? [])].map(result => result.id)])].filter(id => typeof id === 'string'));
    for (const w of witnesses) if (direct.has(w.id)) sources.set(w.id,w);
    if (name === 'read_workspace' && args.id === 'learner') {
      for (const w of witnesses) if (w.type === goalType || w.type === organizerTaskType) overviewBasis.set(w.id, w);
    }
    if (name === 'read_learner_radar') for (const w of witnesses) overviewBasis.set(w.id,w);
    for (const item of name === 'search_workspace' || name === 'read_learner_radar' ? [] : values) {
      if (typeof item?.id === 'string' && witnesses.some(w => w.id === item.id)) {
        opened.set(item.id, {id:item.id, workspace:true, title:String(item.title ?? item.kind ?? '学习记录'), text:String(item.content ?? JSON.stringify(item)).slice(0,3000)});
        const ref = sourceRefV1(item.sourceRef);
        if (ref && typeof item.content === 'string' && item.content.length && workspaceAttemptTypes.includes(ref.fact.type) &&
            (ref.anchor.kind === 'whole' || ref.anchor.kind === 'answer-slot')) {
          const witness = witnesses.find(w => w.id === ref.fact.id && w.rev === ref.fact.rev && w.type === ref.fact.type);
          if (witness) openedAnswers.set(witness.id,witness);
        }
      }
    }
    return text;
  }
  async function save(args: Record<string, unknown>, step: number, observation?: WorkspaceWitness[]) {
    if (!isJson(args)) return JSON.stringify({error:'请将保存字段放在一个 JSON 对象里。'});
    const {id: target, rev: expected, ...fields} = args;
    if (target !== undefined && (typeof target !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(target))) return JSON.stringify({error:'新建时省略 id；修改时复制 search_workspace 结果或保存回执中的 id。'});
    const id = typeof target === 'string' ? target : stableId('workspace-entry', turn, String(step));
    const rev = target ? Math.max(produced.get(id) ?? 0, sources.get(id)?.rev ?? 0) : undefined;
    if (target && !rev) return JSON.stringify({error:'请用 read_workspace 打开要修改的 id。要新建条目时省略 id。'});
    if (expected !== undefined && expected !== rev)
      return JSON.stringify({error:'rev 与已读版本不符。请用 read_workspace 打开条目，再传 id 和要修改的字段；可省略 rev。'});
    let entry = fields;
    let previousBasis: readonly WorkspaceEntryBasis[] = [];
    if (rev) {
      const original = await db.snapshot({learner:studioLearner}, tx =>
        createCommandReadContext(tx,purpose).fact(factId(id),{mode:'pinned',rev:rev as Revision}));
      if (original.type !== workspaceEntryType) {
        const hint = workspaceAttemptTypes.includes(original.type)
          ? '要补充作答，请先用 read_workspace 打开原答，再新建 kind="annotation" 的批注。'
          : '要整理这份材料，请新建 kind="page" 的教材页。';
        return JSON.stringify({error:hint+' 省略 id，把原记录的 id 放入 links。'});
      }
      const {basis, ...savedFields} = workspaceEntry(original.value);
      previousBasis = basis;
      entry = {...savedFields,...fields};
    }
    const witnesses = observation ? new Map(observation.map(w => [w.id,w])) : new Map(sources);
    if (Array.isArray(entry.links)) {
      for (const link of entry.links) {
        if (typeof link !== 'string') continue; // The domain validator reports the exact item index.
        if (produced.has(link)) {
          const own = await db.snapshot({learner:studioLearner}, tx =>
            createCommandReadContext(tx,purpose).fact(factId(link),{mode:'pinned',rev:produced.get(link) as Revision}));
          witnesses.set(link,{id:link,rev:own.ref.rev,epoch:own.accessEpoch,type:own.type});
        }
      }
    }
    const changesEvidence = !rev || Object.hasOwn(fields, 'body') || Object.hasOwn(fields, 'links');
    if (changesEvidence && (entry.kind === 'observation' || entry.kind === 'annotation') &&
        (!Array.isArray(entry.links) || !entry.links.some(link => typeof link === 'string' &&
          opened.has(link) && workspaceAttemptTypes.includes(sources.get(link)?.type ?? ''))))
      return JSON.stringify({error:'请先用 read_workspace 打开原始作答，再把其 id 放入 links。'});
    // Fields retained by a patch still depend on the sources of the previous revision.
    const basisById = new Map<string,{id:string;rev:number;epoch:string}>(previousBasis.map(w => [w.id,w]));
    for (const w of witnesses.values()) if (w.id !== id && !basisById.has(w.id))
      basisById.set(w.id,{id:w.id,rev:w.rev,epoch:w.epoch});
    const basis = [...basisById.values()];
    const handle = createCommandHandler(db, {modules: [await (declarations ??= activity())],
      hooks: createStudioCommandHooks({afterFactsChanged: tx => options.authorize(tx)})});
    const key = commandId(stableId('workspace-command',turn,String(step)));
    // Readiness is checked again while holding the command transaction's learner lock.
    await db.snapshot({learner: studioLearner}, options.authorize);
    try {
      const receipt = await handle({learner: studioLearner, actor: 'companion', purpose, id: key,
        type: 'activity.saveWorkspaceEntry', input: {id, ...(rev === undefined ? {} : {expectedRev: rev}), entry, basis}});
      const written = receipt.wrote[0];
      if (written) {
        produced.set(written.id, written.rev);
        receipts.set(written.id, {id:written.id, rev:written.rev, title:String(entry.title),
          ...(observation ? {observation:{status:'saved',text:String(entry.body),undo_token:key}} : {})});
      }
      if (written && observation) return JSON.stringify({ok:true, status:'saved', kind:'inferred',
        ref:{id:written.id,rev:written.rev}, undo_token:key});
      return JSON.stringify(written ? {state: receipt.state, id: written.id, rev: written.rev} : {state: receipt.state, command: key});
    } catch (error) {
      if (error instanceof TeachingError) throw error;
      // Return domain validation feedback to the model; never return SQL/transport details.
      if (observation && (error instanceof FactReadDeniedError || error instanceof FactNotFoundError))
        return JSON.stringify(learningToolError('access_revoked','evidence_refs','原答当前不可读取。'));
      if (error instanceof WorkspaceInputError) return JSON.stringify(observation
        ? learningToolError(error.message.includes('来源版本') ? 'basis_stale' : 'invalid_args','evidence_refs',error.message,{
          tool:'open_learning',args:{refs:observation.map(w => w.id)},why:'重新核对作答和版本。',
        }) : {error:error.message});
      if (error instanceof Error && error.message.startsWith('Fact revision conflict:'))
        return JSON.stringify({error:'条目已更新。请用 read_workspace 打开当前版本，再传 id 和变动字段。'});
      if (error instanceof Error && error.message === 'Only an unedited companion draft can be revised')
        return JSON.stringify({error:'这条记录由学习者保留。请省略 id 新建一份，使用 links 关联原记录。'});
      throw error;
    }
  }
  async function recordObservation(args: Record<string, unknown>, step: number) {
    const {title, text, evidence_refs: refs} = args;
    if (typeof title !== 'string' || !title.trim() || typeof text !== 'string' || !text.trim())
      return JSON.stringify(learningToolError('invalid_args','text','请填写标题和作为推断的观察正文。'));
    if (!Array.isArray(refs) || !refs.length || refs.length > openLearningLimit ||
        !refs.every(ref => typeof ref === 'string' && ref.length <= 4096 && parseLearningReference(ref)))
      return JSON.stringify(learningToolError('invalid_args','evidence_refs','请提供 1–8 个原答引用。'));
    const evidence = new Map<string, WorkspaceWitness>();
    for (const input of refs as string[]) {
      const ref = parseLearningReference(input)!;
      const id = typeof ref === 'string' ? ref : ref.fact.id;
      const witness = openedAnswers.get(id);
      if (!witness || (typeof ref !== 'string' && (witness.rev !== ref.fact.rev || witness.type !== ref.fact.type))) {
        return JSON.stringify(learningToolError('evidence_not_opened','evidence_refs','请先打开这份原答。',{
          tool:'open_learning',args:{refs:id},why:'用本轮实际读到的原答支持观察。',
        }));
      }
      evidence.set(id,witness);
    }
    return save({kind:'observation',title,body:text,links:[...evidence.keys()]},step,[...evidence.values()]);
  }
  async function execute(name: string, args: Record<string, unknown>, step: number, priorRead?: Promise<unknown>) {
    if (name === 'mount_artifact' && options.presentationManifest) {
      if (Object.keys(args).some(key => !['view','predictionPrompt','sentenceBreaks'].includes(key))) return JSON.stringify({error:'仅支持 view、predictionPrompt 和 sentenceBreaks。'});
      const result = await mountArtifact(db,turn,step,args,async tx => {
        await options.authorize(tx);
        return options.presentationManifest!(tx);
      },options.readArtifactAssessmentWitness);
      if (args.sentenceBreaks !== undefined && result.state === 'done') publishedFormalArtifact = true;
      return JSON.stringify(result);
    }
    const tool = workspaceDefinitions.find(tool => tool.function.name === name);
    if (!tool) return JSON.stringify({error:'请从本轮提供的工作区工具中选择。'});
    const fields = tool.function.parameters.properties;
    const unknown = Object.keys(args).find(key => !Object.hasOwn(fields,key));
    if (unknown) return JSON.stringify(name === 'open_learning' || name === 'record_observation'
      ? learningToolError('invalid_args',unknown.slice(0,60),`可用字段为 ${Object.keys(fields).join('、')}。`,{
          tool:name,args:Object.fromEntries(Object.entries(args).filter(([key]) => Object.hasOwn(fields,key))),why:'仅传工具支持的字段。',
        })
      : {error:`${name} 不支持字段 ${unknown.slice(0,60)}。可用字段为 ${Object.keys(fields).join('、')}。`});
    if (name === 'record_observation') return recordObservation(args,step);
    return name === 'save_workspace' ? save(args, step) : read(name, args, step, priorRead);
  }
  return {
    ...(options.presentationManifest ? {presentationTool} : {}),
    execute,
    executeRead: (name: string, args: Record<string, unknown>, step: number, priorRead: Promise<unknown>) =>
      name === 'search_workspace' || name === 'read_workspace' || name === 'open_learning' || name === 'read_learner_radar'
        ? execute(name, args, step, priorRead)
        : execute(name, args, step),
    publishedFormalArtifact: () => publishedFormalArtifact,
    reads: () => [...opened.values()],
    writes: () => [...receipts.values()],
    basis: () => [...new Map([...sources, ...overviewBasis]).values()],
  };
}
export function workspaceInput(w: WorkspaceWitness) {
  return {kind: 'fact' as const, id: factId(w.id), rev: w.rev as Revision, accessEpoch: w.epoch as Tick,
    mode: w.mode ?? (w.type === 'activity.workspaceEntry' ? 'pinned' : 'following')};
}
