import {
  createCommandReadContext, factId, FactNotFoundError, FactReadDeniedError,
  type FactId, type FactSnapshot, type ReadContext, type ReadTransaction, type Revision,
} from '@mangekyo/kernel';
import { knowledgeEdgeType } from '@mangekyo/module-content/facts/knowledge-edge';
import {
  historicalWorkbookMount as readHistory, memoWorkbookFacts, memoWorkbookRead,
  workbookCapsuleLinkCandidates, verifyWorkbookQuestionPermit, type BoundWorkbookMount as BoundMount,
} from './workbook-context-read.ts';
import { helpExposureRequest, helpExposureType, type HelpPresentation, type HelpRef } from './help-exposure-values.ts';
import { storagePurpose as purpose } from './library-values.ts';
import { posttestIssuanceType } from './retention-posttest.ts';
import { workbookReadingContext, workbookReadingMount } from './workbook-presentation.ts';
import {
  sameWorkbookJson, WorkbookSourceMismatch, workbookAttempt, workbookAttemptType, workbookPaper,
  workbookPaperType, workbookQuestionView, type WorkbookPaper, type WorkbookQuestion, type WorkbookQuestionView,
} from './workbook-values.ts';
import { readFrozenWorkbookBank } from './workbook-bank.ts';
import { workspaceEntryType } from './workspace-values.ts';
import { workbookCapsuleHandles } from './workbook-context-handles.ts';
import type { WorkbookTraceProof } from './workbook-backtrace-values.ts';
import { discoverWorkbookCapsules, type CapsuleHandle } from './workbook-capsules.ts';
import type { FactReadChecks } from './evidence-read.ts';
type Reader = Pick<ReadContext, 'fact'>;
export type WorkbookQuestionWithContext = WorkbookQuestionView & { readingContext?: CapsuleHandle[] };
export type WorkbookContextAuthority = {
  activePosttest?: (tx: ReadTransaction, id: FactId) => Promise<{ mount: BoundMount; paper: WorkbookPaper } | undefined>;
  backtrace?: (tx: ReadTransaction, local: Reader, facts: any) =>
    (target: { paper: HelpRef; itemId: string; question: HelpRef; attemptRef?: HelpRef }) => Promise<readonly WorkbookTraceProof[] | null>;
};
export type StudioWorkbookContextDeps = FactReadChecks & {
  readonly retentionPurpose: string; readonly stableId: (...parts: string[]) => string;
  readonly canonicalJsonString: (value: unknown) => string; readonly sign: (...scope: unknown[]) => string;
  readonly equal: (a: Uint8Array, b: Uint8Array) => boolean; readonly fail: (status: number, message: string) => never;
  readonly isNotionReadUnchecked: (error: unknown) => boolean;
  readonly isWorkbookNotionSource: (fact: { type: string; value: unknown }) => boolean;
  readonly selectedWorkbookRead: (tx: ReadTransaction, purpose: string, sourceRead: Reader, check?: unknown) => Reader;
  readonly snapshotFactReaders: (tx: ReadTransaction) => (purpose: string, maySend: (fact: FactSnapshot) => boolean) => Reader;
  readonly resolveSource: (tx: ReadTransaction, input: unknown, access: unknown) => Promise<any>;
  readonly notionReadScope: (options: { signal: AbortSignal }) => {
    read<T>(run: (tx: ReadTransaction, check: any) => Promise<T>): Promise<T>;
    publishAfterChecks<T, P>(prepare: (tx: ReadTransaction, check: any, collect: boolean) => Promise<P>,
      publish: (tx: ReadTransaction, prepared: P) => Promise<T>): Promise<T>;
  };
  readonly createCommandHandler: (tx: any, modules: any) => (request: any) => Promise<any>;
  readonly withinLearnerTransaction: (db: any, tx: ReadTransaction) => any;
  readonly activity: unknown; readonly hooks: unknown;
  readonly db: unknown; readonly learner: ReadTransaction['learner'];
};
const unavailable = (deps: Pick<StudioWorkbookContextDeps, 'isFactNotFound' | 'isFactReadDenied'>, error: unknown) =>
  deps.isFactNotFound(error) || deps.isFactReadDenied(error) ||
  error instanceof WorkbookSourceMismatch || error instanceof FactNotFoundError || error instanceof FactReadDeniedError;
export const historicalWorkbookMount = (tx: ReadTransaction, id: FactId, fact: FactSnapshot, read: ReadContext,
  isUnavailable: (error: unknown) => boolean = error =>
    error instanceof WorkbookSourceMismatch || error instanceof FactNotFoundError || error instanceof FactReadDeniedError) =>
  readHistory(tx, id, fact, read, isUnavailable);
export function openStudioWorkbookContext(deps: StudioWorkbookContextDeps, authority: WorkbookContextAuthority) {
  const denied = () => deps.fail(403, '本题帮助的发放、授权或呈现许可已失效。');
  const capsuleHandles = workbookCapsuleHandles(deps.sign, deps.equal);
  function capsuleReads(tx: ReadTransaction) {
    const facts = deps.snapshotFactReaders(tx);
    const sourceFor = (use: string) => memoWorkbookFacts(facts(use, () => true).fact);
    const backtraceFor = memoWorkbookRead(async (use: string) => {
      const local = memoWorkbookFacts(deps.selectedWorkbookRead(tx, use, sourceFor(use)).fact);
      return { local, project: authority.backtrace?.(tx, local, facts as never) };
    });
    return { sourceFor, backtraceFor,
      edgesFor: memoWorkbookRead((question: HelpRef, use: string) => workbookCapsuleLinkCandidates(tx, question, knowledgeEdgeType, use)) };
  }
  function discover(tx: ReadTransaction, { sourceFor, backtraceFor, edgesFor }: ReturnType<typeof capsuleReads>,
    mount: BoundMount, item: WorkbookQuestion, check?: any,
    requested?: string, collectPages?: any) {
    const use = mount.issuance ? deps.retentionPurpose : purpose;
    return discoverWorkbookCapsules(tx.learner, use, capsuleHandles, {
      read: (confirm: any) => memoWorkbookFacts(deps.selectedWorkbookRead(tx, use, sourceFor(use), confirm).fact),
      edges: (question: HelpRef) => edgesFor(question, use), backtrace: () => backtraceFor(use),
      isRemote: deps.isWorkbookNotionSource, unavailable: error => unavailable(deps, error),
      unchecked: deps.isNotionReadUnchecked,
      async reopenQuestion(reader: Reader, ref: any) {
        const sources: [FactSnapshot, 'pinned' | 'following' | undefined][] = [];
        const value = await deps.resolveSource(tx, { v: 1, fact: { ...ref, type: workspaceEntryType }, anchor: { kind: 'whole' } }, {
          recipient: 'learner', track: (fact: FactSnapshot, mode: 'pinned' | 'following' | undefined) => sources.push([fact, mode]),
        });
        if (value?.kind !== 'question') return;
        let root;
        for (const [fact, mode] of sources) {
          const checked = await reader.fact(fact.ref.id, mode === 'following' ? { mode } : { mode: 'pinned', rev: fact.ref.rev });
          if (checked.ref.id === ref.id && checked.ref.rev === ref.rev) root = checked;
        }
        return root && { ...ref, accessEpoch: root.accessEpoch };
      },
    }, mount, item, check, requested, collectPages);
  }
  async function issuedMount(tx: ReadTransaction, id: FactId) {
    const bound = await authority.activePosttest?.(tx, id);
    if (!bound) denied();
    return bound!;
  }
  async function resolveMount(tx: ReadTransaction, read: ReadContext, id: FactId, paperRev: number, attemptRef?: HelpRef):
      Promise<{ mount: BoundMount; paper: WorkbookPaper }> {
    const surface = await read.fact(id, { mode: 'following' });
    if (surface.type === posttestIssuanceType && !attemptRef) {
      const bound = await issuedMount(tx, id);
      if (bound.mount.paper.rev === paperRev) return bound;
    }
    if (surface.type === workbookPaperType) {
      if (!attemptRef && surface.ref.rev === paperRev) {
        const paper = workbookPaper(surface.value);
        await readFrozenWorkbookBank(read, paper);
        return { mount: { paper: { id, rev: surface.ref.rev }, epoch: surface.accessEpoch }, paper };
      }
      if (attemptRef) {
        const submitted = await read.fact(attemptRef.id, { mode: 'pinned', rev: attemptRef.rev });
        if (submitted.type !== workbookAttemptType) denied();
        const mount = await readHistory(tx, id, submitted, read, error => unavailable(deps, error));
        if (mount?.paper.rev === paperRev) {
          const paper = workbookAttempt(submitted.value).paper;
          await readFrozenWorkbookBank(read, paper);
          return { mount, paper };
        }
      }
    }
    return denied();
  }
  const questions = (tx: ReadTransaction) => {
    const reads = capsuleReads(tx);
    return (paper: WorkbookPaper, mount: BoundMount) => Promise.all(paper.questions.map(async (item): Promise<WorkbookQuestionWithContext> => {
      const { handles } = await discover(tx, reads, mount, item);
      return { ...workbookQuestionView(item, paper.assessmentRelease), ...(handles.length ? { readingContext: handles } : {}) };
    }));
  };
  return { questions,
    async issued(tx: ReadTransaction, id: FactId) {
      const { mount, paper } = await issuedMount(tx, id);
      return { id, revision: mount.paper.rev, title: paper.title, savedAt: paper.savedAt, source: null, attempts: [],
        questions: await questions(tx)(paper, mount) };
    },
    async labels(id: FactId, query: URLSearchParams, signal: AbortSignal) {
      let target;
      try { target = workbookReadingMount(query); }
      catch { deps.fail(400, '帮助挂载格式无效。'); }
      try {
        return await deps.notionReadScope({ signal }).read(async (tx, check) => {
          const { mount, paper } = await resolveMount(tx, createCommandReadContext(tx, purpose), id, target.paperRev, target.attemptRef);
          const reads = capsuleReads(tx);
          const items = await Promise.all(paper.questions.map(async item => ({
            itemId: item.id, readingContext: (await discover(tx, reads, mount, item, check)).handles,
          })));
          return { ...target, items: items.filter(item => item.readingContext.length) };
        });
      } catch (error) {
        if (unavailable(deps, error)) denied();
        throw error;
      }
    },
    async event(id: FactId, input: Record<string, unknown>, signal: AbortSignal) {
      let event: ReturnType<typeof workbookReadingContext>;
      try { event = workbookReadingContext(input); }
      catch { deps.fail(400, '帮助请求格式无效。'); }
      const prepare = async (tx: ReadTransaction, check: any, collect: boolean) => {
        const read = createCommandReadContext(tx, purpose);
        const { mount, paper } = await resolveMount(tx, read, id, event.paperRev, event.attemptRef);
        const item = paper.questions.find(question => question.id === event.itemId);
        if (!item) denied();
        if (event.phase === 'opened' && !await verifyWorkbookQuestionPermit(tx, read, event.permit, mount, item!.id)) denied();
        const { card } = await discover(tx, capsuleReads(tx), mount, item!, collect ? undefined : check, event.ref, collect ? check : undefined);
        if (!card) return null;
        const witness = mount.issuance ? deps.canonicalJsonString(card.basis) : '';
        const openingId = factId(deps.stableId('paper-capsule-open', event.ref, witness));
        const displayRef = deps.sign('display', event.ref, openingId);
        const presentation: HelpPresentation = { mount: { activityId: id, issuance: mount.issuance ?? mount.paper, item: { itemId: item!.id } },
          content: card.content, alsoAppliesTo: [], step: { kind: 'hint', order: 1 },
          ...(mount.issuance ? { controlledBasis: card.basis } : {}) };
        if (event.phase === 'displayed') {
          if (event.displayRef !== displayRef) denied();
          const opened = await read.fact(openingId, { mode: 'pinned', rev: 1 as Revision });
          if (opened.type !== helpExposureType || !sameWorkbookJson(opened.value, { ...presentation, kind: 'opened' })) denied();
        }
        return { openingId, displayRef, presentation, card, purpose: mount.issuance ? deps.retentionPurpose : purpose };
      };
      try {
        return await deps.notionReadScope({ signal }).publishAfterChecks(prepare, async (tx, prepared) => {
          if (!prepared) denied();
          const { openingId, displayRef, presentation, card } = prepared!;
          const handle = deps.createCommandHandler(deps.withinLearnerTransaction(deps.db, tx), { modules: [deps.activity], hooks: deps.hooks });
          const eventId = event.phase === 'opened' ? openingId : factId(deps.stableId('paper-capsule-display', openingId));
          signal.throwIfAborted();
          const receipt = await handle({ learner: deps.learner, actor: 'learner',
            ...helpExposureRequest(eventId, { ...presentation, kind: event.phase }), purpose: prepared!.purpose });
          if (receipt.state !== 'done' || receipt.wrote[0]?.id !== eventId) denied();
          return event.phase === 'opened' ? { kind: card.kind, text: card.text, displayRef } : { recorded: true };
        });
      } catch (error) {
        if (unavailable(deps, error)) denied();
        throw error;
      }
    },
  };
}
