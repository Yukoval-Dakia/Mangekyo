import type { FactSnapshot } from '@mangekyo/kernel';
import { notionConfirmPageAccess, NotionSourceUnavailable, NotionTemporaryFailure } from './notion-api.ts';
import type { NotionSelection } from './notion-selection.ts';
import { captureSourceType, sourceEnvelope, type SourceEnvelope } from './source.ts';

export type NotionAuthority = 'authorized' | 'withdrawn' | 'unconfirmed' | 'temporary-failure';
export type CheckNotionRead = ((fact: FactSnapshot) => Promise<void>) & {
  choose?: (proofs: readonly (readonly FactSnapshot[])[]) => Promise<number | undefined>;
};
type Page = {key:string; witness:string; selectionKey:string};
type Describe<P> = (fact: FactSnapshot) => Promise<P | undefined>;
type Verify<P> = (page: P, signal: AbortSignal) => Promise<NotionAuthority | 'selection-withdrawn'>;
type Run<Tx> = <T>(project: (tx: Tx) => Promise<T>) => Promise<T>;
type Projection<T, Tx> = (tx: Tx, check: CheckNotionRead) => Promise<T>;
type PageAuthority = { selection: NotionSelection; pageId: string; watermark: string };

export function notionPageKey({selection,pageId,watermark}: PageAuthority) {
  return JSON.stringify([selection.id, selection.selectionEpoch, pageId, watermark]);
}

export function notionPageReadFence<View, Tx extends View>(
  resolvePage: (tx: View, source: SourceEnvelope) => Promise<PageAuthority>,
  read: (page: PageAuthority, stream: ReturnType<typeof notionConfirmPageAccess>, signal: AbortSignal) => Promise<unknown>,
  classifyHostFailure: (error: unknown) => 'withdrawn' | 'unconfirmed' | undefined,
  rejected: (status?: NotionAuthority) => Error,
  transactions: Parameters<typeof notionReadFence<View, Tx, Page>>[2],
) {
  async function describe(tx: View, fact: FactSnapshot) {
    if (fact.type !== captureSourceType) return;
    const source = sourceEnvelope(fact.value);
    if (source.kind !== 'notion') return;
    const page = await resolvePage(tx,source);
    const key = notionPageKey(page);
    const selectionKey = JSON.stringify([page.selection.id, page.selection.selectionEpoch]);
    return {...page, key, selectionKey, witness: JSON.stringify([key, fact.ref.id, fact.ref.rev, fact.accessEpoch])};
  }

  const planner = notionReadPlan<Page & PageAuthority>(async (page,abort) => {
    try {
      await read(page,notionConfirmPageAccess(page.selection.root,page.pageId),abort);
      return 'authorized';
    } catch (error) {
      abort.throwIfAborted();
      if (error instanceof NotionSourceUnavailable && error.invalidated)
        return error.invalidated.kind === 'selection' ? 'selection-withdrawn' : 'withdrawn';
      if (error instanceof NotionTemporaryFailure) return 'temporary-failure';
      const authority = classifyHostFailure(error);
      if (!authority) throw error;
      return authority;
    }
  },rejected,transactions.signal);
  return notionReadFence(planner,describe,transactions);
}

export function notionReadPlan<P extends Page>(verify: Verify<P>, rejected: (status?: NotionAuthority) => Error, signal?: AbortSignal) {
  const checked = new Map<string,NotionAuthority>();
  const pages = new Map<string,NotionAuthority>();

  const withdrawnSelections = new Set<string>();
  const authorityFor = (page: P) => withdrawnSelections.has(page.selectionKey) ? 'withdrawn' : checked.get(page.witness);

  function reader(describe: Describe<P>): CheckNotionRead {
    async function check(fact: FactSnapshot) {
      const page = await describe(fact);
      if (!page) return;
      const authority = authorityFor(page);
      if (authority !== 'authorized') throw rejected(authority);
    }
    return Object.assign(check,{async choose(proofs: readonly (readonly FactSnapshot[])[]) {
      let unchecked = false;
      for (const [index,proof] of proofs.entries()) {
        const alternatives = await Promise.all(proof.map(describe));
        const states = alternatives.map(page=>page ? authorityFor(page) : 'authorized');
        if (states.every(state=>state==='authorized')) return index;
        if (states.every(state=>state==='authorized'||state===undefined)) unchecked = true;
      }
      if (unchecked) throw rejected();
      return undefined;
    }});
  }

  function prepare(describe: Describe<P>) {
    const required = new Map<string,P>();
    const groups: P[][][] = [];
    const collect: CheckNotionRead = async fact => {
      const page = await describe(fact);
      if (page) required.set(page.witness,page);
    };
    collect.choose = async proofs => {
      const group = await Promise.all(proofs.map(async proof => (await Promise.all(proof.map(describe))).filter(page=>page!==undefined)));
      const local = group.findIndex(proof=>proof.length===0);
      if (local >= 0) return local;
      if (group.length) groups.push(group);
      return undefined;
    };
    const active = new Map<string,{users:number; controller:AbortController; task:Promise<NotionAuthority>}>();
    function acquire(page: P) {
      const done = withdrawnSelections.has(page.selectionKey) ? 'withdrawn' : pages.get(page.key);
      if (done) return {task:Promise.resolve(done), release() {}};
      let entry = active.get(page.key);
      if (!entry) {
        const controller = new AbortController();
        const abort = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
        const task = verify(page,abort).then(authority=>{
          abort.throwIfAborted();
          if (authority === 'selection-withdrawn') {
            withdrawnSelections.add(page.selectionKey);
            return 'withdrawn' as const;
          }
          pages.set(page.key,authority);
          return authority;
        }).finally(()=>{ if (active.get(page.key)?.controller===controller) active.delete(page.key); });
        entry = {users:0,controller,task};
        active.set(page.key,entry);
      }
      const leased = entry;
      leased.users++;
      let released = false;
      return {task:leased.task,release() {
        if (released) return;
        released = true;
        if (--leased.users===0 && active.get(page.key)===leased) {
          active.delete(page.key);
          leased.controller.abort();
        }
      }};
    }

    async function resolve() {
      const unavailable = Symbol('unavailable proof');
      async function group(proofs: P[][]) {
        const leases = proofs.map(proof=>proof.map(page=>({page,...acquire(page)})));
        try {
          await Promise.any(leases.map(async proof=>{
            try {
              await Promise.all(proof.map(async ({page,task})=>{
                const authority = await task;
                checked.set(page.witness,authority);
                if (authority!=='authorized') throw unavailable;
              }));
            } finally { for (const page of proof) page.release(); }
          }));
        } catch (error) {
          if (!(error instanceof AggregateError) || error.errors.some(cause=>cause!==unavailable)) throw error;
        } finally {
          // Losing proofs may still be waiting. Their leases are idempotently released below.
          for (const proof of leases) for (const page of proof) page.release();
        }
      }
      if (groups.length) await Promise.all([...required.values()].map(page=>group([[page]])).concat(groups.map(group)));
      else for (const page of required.values()) await group([[page]]);
      signal?.throwIfAborted();
    }
    return {collect,resolve,empty:()=>required.size===0&&groups.length===0};
  }
  return {reader,prepare};
}

/** Collect and resolve remote proofs outside the transaction that reopens and uses them. */
export function notionReadFence<View, Tx extends View, P extends Page>(
  planner: ReturnType<typeof notionReadPlan<P>>, describe: (tx: View, fact: FactSnapshot) => Promise<P | undefined>,
  { snapshot, locked, lockedReadOnly, signal }: {
    snapshot: Run<View>; locked: Run<Tx>; lockedReadOnly: Run<View> | undefined; signal: AbortSignal | undefined;
  },
) {
  const check = (tx: View) => planner.reader(fact => describe(tx, fact));
  const prepare = (tx: View) => planner.prepare(fact => describe(tx, fact));

  async function read<T>(project: Projection<T, View>): Promise<T>;
  async function read<P, T>(project: Projection<P, View>, publish: Projection<T, Tx>): Promise<T>;
  async function read<P, T>(project: Projection<P, View>, publish?: Projection<T, Tx>): Promise<P | T> {
    if (lockedReadOnly && publish) throw new Error('A read-only Notion scope cannot publish');
    signal?.throwIfAborted();
    const { initial, plan } = await snapshot(async tx => {
      const plan = prepare(tx);
      return { initial: await project(tx, plan.collect), plan };
    });
    signal?.throwIfAborted();
    if (plan.empty() && !publish) return initial;
    await plan.resolve();
    if (lockedReadOnly) return lockedReadOnly(tx => project(tx, check(tx)));
    return locked<P | T>(tx => {
      signal?.throwIfAborted();
      return publish ? publish(tx, check(tx)) : project(tx, check(tx));
    });
  }

  async function publishAfterChecks<P,T>(
    project: (tx: Tx, check: CheckNotionRead, collect: boolean) => Promise<P>, publish: (tx: Tx, prepared: P) => Promise<T>,
  ): Promise<T> {
    if (lockedReadOnly) throw new Error('A read-only Notion scope cannot publish');
    const first = await locked(async tx => {
      signal?.throwIfAborted();
      const plan = prepare(tx);
      const prepared = await project(tx, plan.collect, true);
      return plan.empty() ? { response: await publish(tx, prepared) } : { plan };
    });
    if (!first.plan) return first.response;
    signal?.throwIfAborted();
    await first.plan.resolve();
    return locked(async tx => {
      signal?.throwIfAborted();
      return publish(tx, await project(tx, check(tx), false));
    });
  }

  return { read, check, publishAfterChecks };
}
