import type { FactId, FactSnapshot, LearnerId, ReadContext } from '@mangekyo/kernel';
import { listPaperCapsules, openPaperCapsule, type PaperCapsuleBinding } from '@mangekyo/module-content/facts/paper-capsules';
import { helpRef, type HelpRef } from './help-exposure-values.ts';
import { selectWorkbookTrace, workbookWitnessReader, type WorkbookTraceProof } from './workbook-backtrace-values.ts';
import { localWorkbookCapsuleKinds as localKinds, workbookCapsuleKinds as allKinds, withWorkbookWorkspaceBasis, type BoundWorkbookMount } from './workbook-context-read.ts';
import type { workbookCapsuleHandles, WorkbookCapsuleKind } from './workbook-context-handles.ts';
import type { WorkbookQuestion } from './workbook-values.ts';
import { WorkspaceInputError } from './workspace-values.ts';

type ConfirmCapsuleFact = ((fact: FactSnapshot) => Promise<void>) & {
  choose?(proofs: readonly (readonly FactSnapshot[])[]): Promise<number | undefined>;
};
type Reader = Pick<ReadContext, 'fact'>;
export type CapsuleHandle = { kind: WorkbookCapsuleKind; ref: string };
type TraceTarget = {paper: HelpRef; itemId: string; question: HelpRef; attemptRef?: HelpRef};
type CapsuleReader = {
  read(check: ConfirmCapsuleFact): Reader;
  edges(ref: HelpRef): Promise<readonly FactId[]>;
  backtrace(): Promise<{local: Reader; project?: ((target: TraceTarget) => Promise<readonly WorkbookTraceProof[] | null>) | undefined}>;
  reopenQuestion(read: Reader, ref: HelpRef): Promise<(HelpRef & {accessEpoch: FactSnapshot['accessEpoch']}) | undefined>;
  isRemote(fact: FactSnapshot): boolean;
  unavailable(error: unknown): boolean;
  unchecked(error: unknown): boolean;
};

/** Match the requested capsule and retain the proofs needed to confirm it. */
export async function discoverWorkbookCapsules(
  learner: LearnerId, purpose: string, handlesFor: ReturnType<typeof workbookCapsuleHandles>, host: CapsuleReader,
  mount: BoundWorkbookMount, item: WorkbookQuestion, check?: ConfirmCapsuleFact, requested?: string, collectPages?: ConfirmCapsuleFact,
) {
  const category = requested && handlesFor.kind(requested,mount,item.id);
  if (!item.sourceQuestionRef || (requested && !category)) return { handles: [] };
  const question = helpRef(item.sourceQuestionRef);
  const edges = category === 'backtrace' ? [] : await host.edges(question);
  // Buffer preflight pages so an unrelated remote category never delays a local opening.
  const pages = new Set<FactSnapshot>();
  const choices: (readonly (readonly FactSnapshot[])[])[] = [];
  const handles: CapsuleHandle[] = [];
  for (const kind of category ? [category] : check || collectPages ? allKinds : localKinds) {
    let pending = false;
    const read = host.read(async fact => {
      if (!check) { pending = true; pages.add(fact); return; }
      try { await check(fact); } catch (error) {
        if (host.unchecked(error)) pending = true;
        throw error;
      }
    });
    if (kind === 'backtrace') {
      const {local,project} = await host.backtrace();
      const proofs = await project?.({paper:mount.paper,itemId:item.id,question,
        ...(mount.attemptRef ? {attemptRef:mount.attemptRef} : {})}) ?? [];
      const refFor = (trace: WorkbookTraceProof) => handlesFor.seal(kind,mount,item.id,[question,trace.content,trace.witnesses]);
      const trace = await selectWorkbookTrace(proofs,local,host.isRemote,async options=>{
        if (check?.choose) return check.choose(options);
        const index = options.findIndex(proof=>proof.length===0);
        if (index >= 0) return index;
        pending = true;
        choices.push(options);
        return undefined;
      },requested ? proof=>refFor(proof)===requested : undefined).catch(error=>{
        if (!host.unavailable(error)) throw error;
      });
      if (!trace || pending) continue;
      const ref = refFor(trace);
      handles.push({kind,ref});
      if (ref === requested) return {handles,card:{kind,text:trace.text,content:trace.content,basis:trace.witnesses}};
      continue;
    }
    const bindings = new Map<string, PaperCapsuleBinding>();
    const access = {
      learner, purpose, recipient:learner, read:withWorkbookWorkspaceBasis(read),
      isUnavailable: (error: unknown) => host.unavailable(error) || error instanceof WorkspaceInputError,
      async reopenLegacyQuestion(this: {read: Reader}, ref: HelpRef) {
        return host.reopenQuestion(this.read, ref);
      },
      async seal(binding: PaperCapsuleBinding) {
        const ref = handlesFor.seal(kind,mount,item.id,binding);
        bindings.set(ref,binding);
        return ref;
      },
      async unseal(ref: string) { return bindings.get(ref) ?? null; },
    };
    const [label] = await listPaperCapsules(access,question,edges,kind === 'notion' ? 'notion-block' : kind);
    if (pending || !label) continue;
    handles.push({kind,ref:label.ref});
    if (label.ref !== requested) continue;
    const binding = bindings.get(label.ref)!;
    const proof = workbookWitnessReader(read,{learner});
    const matched = await openPaperCapsule({...access,read:withWorkbookWorkspaceBasis(proof.read)},label.ref,binding.trail.map(step=>step.edge.id),question);
    if (!matched || pending) continue;
    const {id,rev} = binding.trail.at(-1)!.endpoint.sourceUse;
    return {handles,card:{kind,text:matched.kind === 'notion-block' ? matched.text : matched.title,
      content:{id,rev},basis:proof.witnesses()}};
  }
  if (collectPages) {
    for (const fact of pages) await collectPages(fact);
    for (const group of choices) await collectPages.choose?.(group);
  }
  return {handles};
}
