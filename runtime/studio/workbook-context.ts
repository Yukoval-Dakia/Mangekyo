import { createHmac, randomBytes } from 'node:crypto';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { lockLearner, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { BusWitness } from '../../kernel/src/pipeline-contracts.ts';
import type { FactSnapshot, ReadContext } from '../../kernel/src/declarations/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import {
  historicalWorkbookMount as readHistory, workbookCapsuleLinkCandidates, verifyWorkbookQuestionPermit, type BoundWorkbookMount as BoundMount,
} from '../../modules/activity/workbook-context-read.ts';
import { helpExposureRequest, helpExposureType, helpRef, type HelpRef, type HelpPresentation } from '../../modules/activity/help-exposure-values.ts';
import { storagePurpose as purpose } from '../../modules/activity/library-values.ts';
import { posttestIssuanceType } from '../../modules/activity/retention-posttest.ts';
import { workbookReadingContext } from '../../modules/activity/workbook-presentation.ts';
import { sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType, workbookQuestionView, type WorkbookQuestion } from '../../modules/activity/workbook-values.ts';
import { workspaceEntryType } from '../../modules/activity/workspace-values.ts';
import { workbookWitnessReader } from '../../modules/activity/workbook-backtrace-values.ts';
import type { openRetention } from './retention.ts';
import { selectedWorkbookRead, retentionPurpose, workbookNotionAccess } from './retention-workbook.ts';
import { captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { knowledgeEdgeType } from '../../modules/content/knowledge-edge.ts';
import { listPaperCapsules, openPaperCapsule, type PaperCapsuleBinding } from '../../modules/content/paper-capsules.ts';
import { stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';
import { resolveSource } from './source-read.ts';

type Reader = Pick<ReadContext,'fact'>;
export type WorkbookContextAuthority = {
  activePosttest?: ReturnType<typeof openRetention>['activePosttest'];
  readNotionSource?: (tx: ReadTransaction, id: FactId, options: Parameters<Reader['fact']>[1], access: ReturnType<typeof workbookNotionAccess>) => Promise<FactSnapshot>;
  backtrace?: (tx: ReadTransaction, target: {paper: HelpRef; itemId: string; question: HelpRef; attemptRef?: HelpRef}, read: Reader) =>
    Promise<null | {text: string; content: HelpRef; witnesses: readonly BusWitness[]}>;
};
type Kind = 'notion' | 'archetype' | 'backtrace';
const scope = {learner: studioLearner};
const unavailable = (error: unknown) => error instanceof FactNotFoundError || error instanceof FactReadDeniedError;
const denied = () => new RequestError(403, '本题帮助的发放、授权或呈现许可已失效。');
const pinned = {mode: 'pinned' as const, rev: 1 as Revision};

export const historicalWorkbookMount = (tx: ReadTransaction, id: FactId, fact: FactSnapshot, read: ReadContext) =>
  readHistory(tx,id,fact,read,unavailable);

export function openWorkbookContext(db: Db, activity: LoadedModule, hooks: CommandHooks, authority: WorkbookContextAuthority) {
  const key = randomBytes(32);
  const sign = (...scope: unknown[]) => createHmac('sha256', key).update(canonicalJsonString(scope)).digest('base64url');
  async function discover(tx: ReadTransaction, mount: BoundMount, item: WorkbookQuestion, requested?: string) {
    if (!item.sourceQuestionRef) return { handles: [] };
    const question = helpRef(item.sourceQuestionRef);
    const use = mount.issuance ? retentionPurpose : purpose;
    const selected = selectedWorkbookRead(tx,use,createCommandReadContext(tx,use));
    const read: Reader = {
      async fact<Value>(id: FactId, options: Parameters<Reader['fact']>[1]) {
        const fact = await selected.fact(id,options);
        if (authority.readNotionSource && fact.type === captureSourceType && sourceEnvelope(fact.value).kind === 'notion') {
          try { return await authority.readNotionSource(tx,id,options,workbookNotionAccess(tx,use)) as FactSnapshot<Value>; }
          catch (error) {
            if (!(error instanceof RequestError) || error.status !== 403) throw error;
            throw new FactReadDeniedError('recipient','本卷未授权此 Notion 选源。');
          }
        }
        return fact as FactSnapshot<Value>;
      },
    };
    const edges = await workbookCapsuleLinkCandidates(tx,question,knowledgeEdgeType,use);
    const bindings = new Map<string, PaperCapsuleBinding>();
    const access = {
      learner: tx.learner, purpose:use, recipient:tx.learner, read, isUnavailable: unavailable,
      async reopenLegacyQuestion(this: {read:Reader},ref: HelpRef) {
        const sources: [FactSnapshot, 'pinned' | 'following' | undefined][] = [];
        const value = await resolveSource(tx, {v:1,fact:{...ref,type:workspaceEntryType},anchor:{kind:'whole'}}, {
          recipient: 'learner', track: (fact,mode) => sources.push([fact,mode]),
        });
        if (value?.kind !== 'question') return;
        let root;
        for (const [fact,mode] of sources) {
          const checked = await this.read.fact(fact.ref.id,mode === 'following' ? {mode} : {mode:'pinned',rev:fact.ref.rev});
          if (checked.ref.id === ref.id && checked.ref.rev === ref.rev) root = checked;
        }
        return root && {...ref,accessEpoch:root.accessEpoch};
      },
      async seal(binding: PaperCapsuleBinding) {
        const ref = sign('capsule',mount,item.id,binding);
        bindings.set(ref,binding);
        return ref;
      },
      async unseal(ref: string) { return bindings.get(ref) ?? null; },
    };
    const handles: {kind: Kind; ref: string}[] = (await listPaperCapsules(access,question,edges))
      .map(({kind,ref})=>({kind:kind==='notion-block' ? 'notion' : kind,ref}));
    const backtrace = await authority.backtrace?.(tx, {paper:mount.paper,itemId:item.id,question,...(mount.attemptRef ? {attemptRef:mount.attemptRef} : {})},read);
    if (backtrace) {
      const ref = sign('backtrace',mount,item.id,question,backtrace.content,backtrace.witnesses);
      handles.push({kind:'backtrace',ref});
      if (ref === requested) return {handles, card:{kind:'backtrace' as const,text:backtrace.text,content:backtrace.content,basis:backtrace.witnesses}};
    }
    const binding = requested ? bindings.get(requested) : undefined;
    const proof = workbookWitnessReader(read,tx);
    const matched = binding && requested && await openPaperCapsule({...access,read:proof.read},requested,
      binding.trail.map(step=>step.edge.id),question);
    if (!matched || !binding) return {handles};
    const content = binding.trail.at(-1)!.endpoint.sourceUse;
    const card = matched.kind === 'notion-block'
      ? {kind:'notion' as const,text:matched.text,content:{id:content.id,rev:content.rev}}
      : {kind:'archetype' as const,text:matched.title,content:{id:content.id,rev:content.rev}};
    return {handles,card:{...card,basis:proof.witnesses()}};
  }

  const questions = (tx: ReadTransaction, items: readonly WorkbookQuestion[], mount?: BoundMount | null) =>
    Promise.all(items.map(async item => {
      const handles = mount ? (await discover(tx,mount,item)).handles : [];
      return {...workbookQuestionView(item), ...(handles.length ? {readingContext:handles} : {})};
    }));

  return {questions,
    async issued(tx: ReadTransaction, id: FactId) {
      const bound = await authority.activePosttest?.(tx,id);
      if (!bound) throw denied();
      const {mount,paper} = bound;
      return {id,revision:mount.paper.rev,title:paper.title,savedAt:paper.savedAt,source:null,attempts:[],
        questions:await questions(tx,paper.questions,mount)};
    },
    async event(id: FactId, input: Record<string, unknown>) {
      let event;
      try { event = workbookReadingContext(input); }
      catch { throw new RequestError(400, '帮助请求格式无效。'); }
      try { return await db.tx(scope, async tx => {
        await lockLearner(tx,tx.learner);
        const read = createCommandReadContext(tx,purpose);
        const surface = await read.fact(id,{mode:'following'});
        let mount: BoundMount | null = null;
        let paper;
        if (surface.type === posttestIssuanceType && !event.attemptRef) {
          const bound = await authority.activePosttest?.(tx,id);
          if (!bound) throw denied();
          ({mount,paper} = bound);
        } else if (surface.type === workbookPaperType) {
          if (event.attemptRef) {
            const submitted = await read.fact(event.attemptRef.id,{mode:'pinned',rev:event.attemptRef.rev});
            if (submitted.type !== workbookAttemptType) throw denied();
            mount = await readHistory(tx,id,submitted,read,unavailable);
            paper = workbookAttempt(submitted.value).paper;
          } else if (surface.ref.rev === event.paperRev) {
            mount = {paper:{id,rev:surface.ref.rev},epoch:surface.accessEpoch};
            paper = workbookPaper(surface.value);
          }
        }
        const item = paper?.questions.find(question=>question.id===event.itemId);
        if (!mount || !item || mount.paper.rev !== event.paperRev) throw denied();
        if (event.phase === 'opened' && !await verifyWorkbookQuestionPermit(tx,read,event.permit,mount,item.id)) throw denied();
        const {card} = await discover(tx,mount,item,event.ref);
        if (!card) throw denied();
        const witness = mount.issuance ? canonicalJsonString(card.basis) : '';
        const openingId = factId(stableId('paper-capsule-open',event.ref,witness));
        const displayRef = sign('display',event.ref,openingId);
        const presentation: HelpPresentation = {mount:{activityId:id,issuance:mount.issuance ?? mount.paper,item:{itemId:item.id}},
          content:card.content,alsoAppliesTo:[],step:{kind:'hint',order:1},
          ...(mount.issuance ? {controlledBasis:card.basis} : {})};
        if (event.phase === 'displayed') {
          if (event.displayRef !== displayRef) throw denied();
          const opened = await read.fact(openingId,pinned);
          if (opened.type !== helpExposureType || !sameWorkbookJson(opened.value,{...presentation,kind:'opened'})) throw denied();
        }
        const handle = createCommandHandler(withinLearnerTransaction(db,tx),{modules:[activity],hooks});
        const eventId = event.phase === 'opened' ? openingId : factId(stableId('paper-capsule-display',openingId));
        const receipt = await handle({...scope,actor:'learner',...helpExposureRequest(eventId,{...presentation,kind:event.phase}),
          purpose:mount.issuance ? retentionPurpose : purpose});
        if (receipt.state !== 'done' || receipt.wrote[0]?.id !== eventId) throw denied();
        return event.phase === 'opened' ? {kind:card.kind,text:card.text,displayRef} : {recorded:true};
      }); } catch (error) {
        if (unavailable(error)) throw denied();
        throw error;
      }
    },
  };
}
