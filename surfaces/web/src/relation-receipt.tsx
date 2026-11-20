import { useEffect, useState, type ComponentProps } from 'react';
import { api, ApiError, type RelationWrite } from './api';
import { fixedLink, Relation, type Reference } from './concept-reading';

type Description = {
  kind: ComponentProps<typeof Relation>['kind']; scope: string;
  from: Reference; to: Reference; fromTitle?: string; toTitle?: string;
};
type Saved = {status: 'saved'; ref: Reference; rev: number; undo_token: string};
type Result = Saved | {status: 'withdrawn' | 'changed'};
type Proposal = Partial<Description> & {
  proposalId: string; status: 'pending' | 'confirmed' | 'conflict' | 'rejected'; result?: Result;
};

function describes(value: Partial<Description>): value is Description {
  return Boolean(value.from?.fact?.id && value.to?.fact?.id && value.kind && value.scope);
}

function DescriptionView({from, to, fromTitle, toTitle, kind, scope}: Description) {
  const endpoint = (ref: Reference, title?: string) =>
    <a href={fixedLink(ref)}>{title || ref.fact.id} · 第 {ref.fact.rev} 版</a>;
  return <div>
    <Relation kind={kind} from={endpoint(from, fromTitle)} to={endpoint(to, toTitle)} />
    <p>适用范围：{scope}</p>
  </div>;
}

async function readDescription(ref: Reference, signal: AbortSignal) {
  function read<T>(source: Reference) {
    const query = new URLSearchParams({ref: JSON.stringify(source), view: 'preview'});
    return api<T>('/workspace/access/records/' + encodeURIComponent(source.fact.id) + '?' + query, {signal});
  }
  const edge = await read<Description>(ref);
  if (!describes(edge)) throw new Error('缺少关系端点。');
  const [fromTitle, toTitle] = await Promise.all([getTitle(edge.from, edge.fromTitle), getTitle(edge.to, edge.toTitle)]);
  return {...edge, fromTitle, toTitle};

  async function getTitle(source: Reference, title?: string) {
    return title || (await read<{title: string}>(source)).title;
  }
}

function SavedRelation({saved, accepted}: {saved: Saved; accepted: boolean}) {
  const {ref, rev} = saved;
  const [details, show] = useState<Description>();
  const [unavailable, setUnavailable] = useState(false);
  const [outcome, finish] = useState<'withdrawn' | 'changed'>();
  const [busy, setBusy] = useState(false);
  const [error, report] = useState('');
  useEffect(() => {
    if (outcome) return;
    const controller = new AbortController();
    readDescription(ref, controller.signal)
      .then(value => { if (!controller.signal.aborted) show(value); })
      .catch(() => { if (!controller.signal.aborted) setUnavailable(true); });
    return () => controller.abort();
  }, [ref.fact.id, rev, outcome]);

  async function undo() {
    if (busy) return;
    setBusy(true);
    report('');
    try {
      const receipt = await api<{status: string; ref: {id: string; rev: number}}>(
        '/workspace/relations/' + encodeURIComponent(ref.fact.id) + '/undo',
        {method: 'POST', body: {undo_token: saved.undo_token}});
      if (receipt.status !== 'withdrawn' || receipt.ref.id !== ref.fact.id || receipt.ref.rev !== rev + 1)
        throw new Error('unexpected receipt');
      finish('withdrawn');
    } catch (cause) {
      show(undefined);
      if (cause instanceof ApiError && [404, 409].includes(cause.status)) finish('changed');
      else report('暂时无法确认撤回结果，请重新读取回执。');
    } finally {
      setBusy(false);
    }
  }

  if (outcome) return <FinalStatus status={outcome} />;
  return <>
    <strong role="status">{accepted ? '已采纳关系' : '已保存关系'}</strong>
    {unavailable ? <span role="status">当前无法读取关系详情。</span> : details && <DescriptionView {...details} />}
    <button type="button" className="tonal-button" disabled={busy} onClick={undo}>{busy ? '正在撤回…' : '撤回关系'}</button>
    {error && <span role="alert">{error}</span>}
  </>;
}

function FinalStatus({status}: {status: 'withdrawn' | 'changed'}) {
  return <strong role="status">{status === 'withdrawn' ? '关系已撤回' : '关系已变更，无法撤回原版本。'}</strong>;
}

function Review({id}: {id: string}) {
  const path = '/workspace/relations/proposals/' + encodeURIComponent(id);
  const [proposal, show] = useState<Proposal>();
  const [busy, setBusy] = useState(false);
  const [error, report] = useState('');
  const [version, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<Proposal>(path, {signal: controller.signal}).then(value => {
      if (value.proposalId !== id || (value.status === 'pending' && !describes(value)))
        throw new Error('unexpected proposal');
      if (!controller.signal.aborted) show(value);
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) show({proposalId: id, status: 'conflict'});
      else report('暂时无法读取关系提议。');
    });
    return () => controller.abort();
  }, [path, version]);

  async function decide(decision: 'accept' | 'reject') {
    if (busy) return;
    setBusy(true);
    report('');
    try {
      const receipt = await api<{proposalId: string} & (Saved | {status: 'rejected'})>(path, {method: 'POST', body: {decision}});
      if (receipt.proposalId !== id || (decision === 'reject' ? receipt.status !== 'rejected' :
          receipt.status !== 'saved' || !receipt.undo_token || receipt.ref?.fact.rev !== receipt.rev))
        throw new Error('unexpected receipt');
      show(receipt.status === 'rejected' ? {proposalId: id, status: 'rejected'} :
        {proposalId: id, status: 'confirmed', result: receipt});
    } catch (cause) {
      show(undefined);
      if (cause instanceof ApiError && cause.status === 409) refresh(v => v + 1);
      else report('未能确认处理结果，请重新读取。');
    } finally {
      setBusy(false);
    }
  }
  if (!proposal) return error ? <div role="alert">{error} <button className="text-button" onClick={() => {
    report(''); refresh(v => v + 1);
  }}>重新读取</button></div> : <span role="status">正在读取关系提议…</span>;
  if (proposal.status === 'rejected') return <strong role="status">已拒绝关系提议</strong>;
  if (proposal.status === 'confirmed') {
    if (proposal.result?.status === 'saved') return <SavedRelation accepted saved={proposal.result} />;
    if (proposal.result) return <FinalStatus status={proposal.result.status} />;
    return <strong role="status">已采纳关系</strong>;
  }
  const ready = proposal.status === 'pending' && describes(proposal);
  return <>
    <strong role="status">{ready ? '待确认的关系提议' : '关系依据已变化或不可读取'}</strong>
    {ready && <DescriptionView {...proposal} />}
    <div className="study-actions">
      {ready && <button type="button" className="primary-button" disabled={busy} onClick={() => decide('accept')}>采纳关系</button>}
      <button type="button" className="tonal-button" disabled={busy} onClick={() => decide('reject')}>拒绝提议</button>
    </div>
  </>;
}

export function RelationReceipt({id, rev, relation}: {id: string; rev: number; relation: RelationWrite}) {
  return <li className="page-write">
    {relation.status === 'proposed' ? <Review id={relation.proposalId} /> : relation.status === 'saved' ?
      <SavedRelation accepted={false} saved={{...relation, rev, ref: {
        v: 1, fact: {id, rev, type: 'content.knowledgeEdge'}, anchor: {kind: 'whole'},
      }}} /> : <FinalStatus status={relation.status} />}
  </li>;
}
