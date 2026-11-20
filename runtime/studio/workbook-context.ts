import { createHmac, randomBytes } from 'node:crypto';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { BusWitness } from '../../kernel/src/pipeline-contracts.ts';
import type { FactSnapshot, ReadContext } from '../../kernel/src/declarations/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import {
  historicalWorkbookMount as readHistory, memoWorkbookFacts, workbookCapsuleLinkCandidates, verifyWorkbookQuestionPermit, type BoundWorkbookMount as BoundMount,
} from '../../modules/activity/workbook-context-read.ts';
import { helpExposureRequest, helpExposureType, helpRef, type HelpRef, type HelpPresentation } from '../../modules/activity/help-exposure-values.ts';
import { storagePurpose as purpose } from '../../modules/activity/library-values.ts';
import { posttestIssuanceType } from '../../modules/activity/retention-posttest.ts';
import { workbookReadingContext, workbookReadingMount } from '../../modules/activity/workbook-presentation.ts';
import { sameWorkbookJson, WorkbookSourceMismatch, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType, workbookQuestionView, type WorkbookQuestion, type WorkbookPaper } from '../../modules/activity/workbook-values.ts';
import { readFrozenWorkbookBank } from '../../modules/activity/workbook-bank.ts';
import { workspaceEntryType } from '../../modules/activity/workspace-values.ts';
import { workbookWitnessReader } from '../../modules/activity/workbook-backtrace-values.ts';
import { notionReadScope, NotionReadUnchecked, type CheckNotionRead } from './notion.ts';
import type { openRetention } from './retention.ts';
import { selectedWorkbookRead, retentionPurpose } from './retention-workbook.ts';
import { knowledgeEdgeType } from '../../modules/content/knowledge-edge.ts';
import { listPaperCapsules, openPaperCapsule, type PaperCapsuleBinding } from '../../modules/content/paper-capsules.ts';
import { stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';
import { resolveSource } from './source-read.ts';

type Reader = Pick<ReadContext,'fact'>;
export type WorkbookContextAuthority = {
  activePosttest?: ReturnType<typeof openRetention>['activePosttest'];
  backtrace?: (tx: ReadTransaction, target: {paper: HelpRef; itemId: string; question: HelpRef; attemptRef?: HelpRef}, read: Reader) =>
    Promise<null | {text: string; content: HelpRef; witnesses: readonly BusWitness[]}>;
};
type Kind = 'notion' | 'archetype' | 'backtrace';
const scope = {learner: studioLearner};
const unavailable = (error: unknown) => error instanceof WorkbookSourceMismatch || error instanceof FactNotFoundError || error instanceof FactReadDeniedError;
const denied = () => new RequestError(403, '本题帮助的发放、授权或呈现许可已失效。');
const localKinds = ['archetype','backtrace'] as const;
const allKinds = [...localKinds,'notion'] as const;
const pinned = {mode: 'pinned' as const, rev: 1 as Revision};

export const historicalWorkbookMount = (tx: ReadTransaction, id: FactId, fact: FactSnapshot, read: ReadContext) =>
  readHistory(tx,id,fact,read,unavailable);

export function openWorkbookContext(db: Db, activity: LoadedModule, hooks: CommandHooks, authority: WorkbookContextAuthority) {
  const key = randomBytes(32);
  const sign = (...scope: unknown[]) => createHmac('sha256', key).update(canonicalJsonString(scope)).digest('base64url');
  async function discover(tx: ReadTransaction, mount: BoundMount, item: WorkbookQuestion, check?: CheckNotionRead,
    requested?: string, collectPages?: CheckNotionRead) {
    if (!item.sourceQuestionRef) return { handles: [] };
    const question = helpRef(item.sourceQuestionRef);
    const use = mount.issuance ? retentionPurpose : purpose;
    const source = memoWorkbookFacts(createCommandReadContext(tx,use).fact);
    const edges = await workbookCapsuleLinkCandidates(tx,question,knowledgeEdgeType,use);
    // Buffer preflight pages so an unrelated remote category never delays a local opening.
    const pages = new Set<FactSnapshot>();
    const handles: {kind: Kind; ref:string}[] = [];
    for (const kind of check || collectPages ? allKinds : localKinds) {
      let pending = false;
      const selected = selectedWorkbookRead(tx,use,source,async fact => {
        if (!check) { pending = true; pages.add(fact); return; }
        try { await check(fact); } catch (error) {
          if (error instanceof NotionReadUnchecked) pending = true;
          throw error;
        }
      });
      const read = memoWorkbookFacts(selected.fact);
      if (kind === 'backtrace') {
        const trace = await authority.backtrace?.(tx,{paper:mount.paper,itemId:item.id,question,
          ...(mount.attemptRef ? {attemptRef:mount.attemptRef} : {})},read);
        if (!trace || pending) continue;
        const ref = sign('backtrace',mount,item.id,question,trace.content,trace.witnesses);
        handles.push({kind,ref});
        if (ref === requested) return {handles,card:{kind,text:trace.text,content:trace.content,basis:trace.witnesses}};
        continue;
      }
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
      const [label] = await listPaperCapsules(access,question,edges,kind === 'notion' ? 'notion-block' : kind);
      if (pending || !label) continue;
      handles.push({kind,ref:label.ref});
      if (label.ref !== requested) continue;
      if (collectPages) return {handles};
      const binding = bindings.get(label.ref)!;
      const proof = workbookWitnessReader(read,tx);
      const matched = await openPaperCapsule({...access,read:proof.read},label.ref,binding.trail.map(step=>step.edge.id),question);
      if (!matched || pending) continue;
      const {id,rev} = binding.trail.at(-1)!.endpoint.sourceUse;
      return {handles,card:{kind,text:matched.kind === 'notion-block' ? matched.text : matched.title,
        content:{id,rev},basis:proof.witnesses()}};
    }
    if (collectPages) for (const fact of pages) await collectPages(fact);
    return {handles};
  }

  async function issuedMount(tx: ReadTransaction, id: FactId) {
    const bound = await authority.activePosttest?.(tx,id);
    if (!bound) throw denied();
    return bound;
  }

  async function resolveMount(tx: ReadTransaction, read: ReadContext, id: FactId, paperRev: number, attemptRef?: HelpRef) {
    const surface = await read.fact(id,{mode:'following'});
    if (surface.type === posttestIssuanceType && !attemptRef) {
      const bound = await issuedMount(tx,id);
      if (bound.mount.paper.rev === paperRev) return bound;
    }
    if (surface.type === workbookPaperType) {
      if (!attemptRef && surface.ref.rev === paperRev) {
        const paper = workbookPaper(surface.value);
        await readFrozenWorkbookBank(read, paper);
        return {mount:{paper:{id,rev:surface.ref.rev},epoch:surface.accessEpoch},paper};
      }
      if (attemptRef) {
        const submitted = await read.fact(attemptRef.id,{mode:'pinned',rev:attemptRef.rev});
        if (submitted.type !== workbookAttemptType) throw denied();
        const mount = await readHistory(tx,id,submitted,read,unavailable);
        if (mount?.paper.rev === paperRev) {
          const paper = workbookAttempt(submitted.value).paper;
          await readFrozenWorkbookBank(read, paper);
          return {mount,paper};
        }
      }
    }
    throw denied();
  }

  const questions = (tx: ReadTransaction, paper: WorkbookPaper, mount: BoundMount) =>
    Promise.all(paper.questions.map(async item => {
      const {handles} = await discover(tx,mount,item);
      return {...workbookQuestionView(item,paper.assessmentRelease), ...(handles.length ? {readingContext:handles} : {})};
    }));

  return {questions,
    async issued(tx: ReadTransaction, id: FactId) {
      const {mount,paper} = await issuedMount(tx,id);
      return {id,revision:mount.paper.rev,title:paper.title,savedAt:paper.savedAt,source:null,attempts:[],
        questions:await questions(tx,paper,mount)};
    },
    async labels(id: FactId, query: URLSearchParams, signal: AbortSignal) {
      let target;
      try { target = workbookReadingMount(query); }
      catch { throw new RequestError(400,'帮助挂载格式无效。'); }
      try {
        return await notionReadScope(db,studioLearner,signal).read(async (tx,check) => {
          const {mount,paper} = await resolveMount(tx,createCommandReadContext(tx,purpose),id,target.paperRev,target.attemptRef);
          const items = await Promise.all(paper.questions.map(async item => ({
            itemId:item.id,readingContext:(await discover(tx,mount,item,check)).handles,
          })));
          return {...target,items:items.filter(item=>item.readingContext.length)};
        });
      } catch (error) {
        if (unavailable(error)) throw denied();
        throw error;
      }
    },
    async event(id: FactId, input: Record<string, unknown>) {
      let event: ReturnType<typeof workbookReadingContext>;
      try { event = workbookReadingContext(input); }
      catch { throw new RequestError(400, '帮助请求格式无效。'); }
      const prepare = async (tx: ReadTransaction, check: CheckNotionRead, collect?: boolean) => {
        const read = createCommandReadContext(tx,purpose);
        const {mount,paper} = await resolveMount(tx,read,id,event.paperRev,event.attemptRef);
        const item = paper.questions.find(question=>question.id===event.itemId);
        if (!item) throw denied();
        if (event.phase === 'opened' && !await verifyWorkbookQuestionPermit(tx,read,event.permit,mount,item.id)) throw denied();
        const {card} = await discover(tx,mount,item,collect ? undefined : check,event.ref,collect ? check : undefined);
        if (!card) return null;
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
        return {openingId, displayRef, presentation, card, purpose:mount.issuance ? retentionPurpose : purpose};
      };
      try { return await notionReadScope(db,studioLearner).read((tx,check) => prepare(tx,check,true), async (tx,check) => {
        const prepared = await prepare(tx,check);
        if (!prepared) throw denied();
        const {openingId, displayRef, presentation, card} = prepared;
        const handle = createCommandHandler(withinLearnerTransaction(db,tx),{modules:[activity],hooks});
        const eventId = event.phase === 'opened' ? openingId : factId(stableId('paper-capsule-display',openingId));
        const receipt = await handle({...scope,actor:'learner',...helpExposureRequest(eventId,{...presentation,kind:event.phase}),
          purpose:prepared.purpose});
        if (receipt.state !== 'done' || receipt.wrote[0]?.id !== eventId) throw denied();
        return event.phase === 'opened' ? {kind:card.kind,text:card.text,displayRef} : {recorded:true};
      }); } catch (error) {
        if (unavailable(error)) throw denied();
        throw error;
      }
    },
  };
}
