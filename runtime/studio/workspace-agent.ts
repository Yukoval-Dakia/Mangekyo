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
import {workspaceDefinitions} from '../../executors/teaching/workspace-tools.ts';
import type {SourceReadMode, SourceTrack} from './source-read.ts';
import {workspaceSearch, workspaceRead, workspaceSourceUnavailable, workspaceAssessmentBasis, type WorkspaceAssessmentBasis} from './workspace-read.ts';
import {workbookAttempt, workbookAttemptType} from '../../modules/activity/workbook-values.ts';
import {WorkspaceInputError, workspaceAttemptTypes, workspaceEntry, workspaceEntryType, type WorkspaceEntryBasis} from '../../modules/activity/workspace-values.ts';
import {purpose, stableId, studioLearner} from './identity.ts';
import {createStudioCommandHooks} from './command-hooks.ts';

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
  prior: WorkspaceWitness[];
}) {
  const {db, turn} = options;
  const sources = new Map(options.prior.map(input => [input.id, input]));
  const opened = new Map<string, Seen>();
  const produced = new Map<string, number>();
  const receipts = new Map<string,{id:string;rev:number;title:string}>();
  async function read(name: string, args: Record<string, unknown>, step: number) {
    if (!isJson(args)) return JSON.stringify({error:'请将查询字段放在一个 JSON 对象里。'});
    const raw = await recordLocalRead(db, {learner:studioLearner, ownerKind:'session', ownerId:turn,
      stepKey:String(step), label:'local:'+name, input:args}, async tx => {
      const witnesses = new Map<string, WorkspaceWitness>();
      const track: SourceTrack = (fact, mode) => witnesses.set(fact.ref.id, {
        id:fact.ref.id, type:fact.type, rev:fact.ref.rev, epoch:fact.accessEpoch, ...(mode ? {mode} : {}),
      });
      const assessmentBasis: WorkspaceAssessmentBasis[] = [];
      const text = name === 'read_workspace'
        ? await workspaceRead(tx,args,track,options.maySend,options.trackAssessment ? basis => assessmentBasis.push(basis) : undefined)
        : await workspaceSearch(tx,args,track,options.maySend);
      return JSON.stringify({text,witnesses:[...witnesses.values()],assessmentBasis});
    },options.authorize);
    const {text, witnesses, assessmentBasis} = JSON.parse(raw) as {
      text:string; witnesses:WorkspaceWitness[]; assessmentBasis?: WorkspaceAssessmentBasis[];
    };
    const value = JSON.parse(text);
    const legacyWholeAttempt = !assessmentBasis && value.sourceRef?.fact.type === workbookAttemptType && value.sourceRef.anchor.kind === 'whole';
    const current = await db.snapshot({learner: studioLearner}, async tx => {
      const reader = createCommandReadContext(tx, purpose);
      try {
        for (const witness of witnesses) {
          const input = workspaceInput(witness);
          const fact = await reader.fact(input.id, input);
          if (fact.ref.rev !== witness.rev || fact.type !== witness.type ||
            fact.accessEpoch !== witness.epoch || !options.maySend(fact)) return false;
          // Old whole-attempt receipts could include the frozen rubric inside content.
          if (legacyWholeAttempt && fact.ref.id === value.id && workbookAttempt(fact.value).paper.questions.some(q => q.kind === 'rubric')) return false;
        }
      } catch (error) {
        if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return false;
        throw error;
      }
      if (assessmentBasis?.length && !options.trackAssessment) return false;
      for (const basis of assessmentBasis ?? []) {
        const actual = await workspaceAssessmentBasis(tx, basis.slot, options.maySend);
        if (!actual || canonicalJsonString(actual) !== canonicalJsonString(basis)) return false;
      }
      for (const witness of witnesses) options.track(witness);
      for (const basis of assessmentBasis ?? []) options.trackAssessment?.(basis);
      await options.authorize(tx);
      return true;
    });
    if (!current) {
      if (assessmentBasis?.length || legacyWholeAttempt) throw new TeachingError('evidence_scope', '作答依据已变化，本轮结果无法使用。');
      return workspaceSourceUnavailable;
    }
    const direct = new Set<string>([value.id,args.related,...[...(value.results ?? []), ...(value.observations ?? []),
      ...(value.recentAttempts ?? [])].map(item => item.id)].filter(id => typeof id === 'string'));
    for (const w of witnesses) if (direct.has(w.id)) sources.set(w.id,w);
    if (name === 'read_workspace' && typeof value.id === 'string' && witnesses.some(w => w.id === value.id)) {
      opened.set(value.id, {id: value.id, workspace:true, title: String(value.title ?? value.kind ?? '学习记录'), text: String(value.content ?? text).slice(0, 3000)});
    }
    return text;
  }
  async function save(args: Record<string, unknown>, step: number) {
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
    const witnesses = new Map(sources);
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
        receipts.set(written.id, {id:written.id, rev:written.rev, title:String(entry.title)});
      }
      return JSON.stringify(written ? {state: receipt.state, id: written.id, rev: written.rev} : {state: receipt.state, command: key});
    } catch (error) {
      if (error instanceof TeachingError) throw error;
      // Return domain validation feedback to the model; never return SQL/transport details.
      if (error instanceof WorkspaceInputError) return JSON.stringify({error:error.message});
      if (error instanceof Error && error.message.startsWith('Fact revision conflict:'))
        return JSON.stringify({error:'条目已更新。请用 read_workspace 打开当前版本，再传 id 和变动字段。'});
      if (error instanceof Error && error.message === 'Only an unedited companion draft can be revised')
        return JSON.stringify({error:'这条记录由学习者保留。请省略 id 新建一份，使用 links 关联原记录。'});
      throw error;
    }
  }
  return {
    async execute(name: string, args: Record<string, unknown>, step: number) {
      const tool = workspaceDefinitions.find(tool => tool.function.name === name);
      if (!tool) return JSON.stringify({error:'请从本轮提供的工作区工具中选择。'});
      const fields = tool.function.parameters.properties;
      const unknown = Object.keys(args).find(key => !Object.hasOwn(fields,key));
      if (unknown) return JSON.stringify({error:`${name} 不支持字段 ${unknown.slice(0,60)}。可用字段为 ${Object.keys(fields).join('、')}。`});
      return name === 'save_workspace' ? save(args, step) : read(name, args, step);
    },
    reads: () => [...opened.values()],
    writes: () => [...receipts.values()],
    basis: () => [...sources.values()],
  };
}
export function workspaceInput(w: WorkspaceWitness) {
  return {kind: 'fact' as const, id: factId(w.id), rev: w.rev as Revision, accessEpoch: w.epoch as Tick,
    mode: w.mode ?? (w.type === 'activity.workspaceEntry' ? 'pinned' : 'following')};
}
