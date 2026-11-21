import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { ReadState, useResource } from '../workspace';
import { UndoPageWrite } from './UndoPageWrite';
import { BodyView } from './blocks';
import { link, type Block } from './contract';
import './proposal-review.css';

type Reference = { id: string; rev: number };
type Position = { block: Block; siblingIndex: number };
const states = { proposed: '待确认', applied: '已应用', rejected: '已拒绝', conflict: '版本冲突' };
type Summary = { proposalId: string; base: Reference; status: keyof typeof states };
const editLabels = { rewrite: '改写', insert: '新增', move: '移动', insert_after: '插入', replace_anchor: '替换片段', delete_block: '删除' };
type Item = { edit: { kind: keyof typeof editLabels; blockId: string }; before: Position | null } & (
  { state: 'ready'; after: Position | null } | { state: 'invalid'; reason: string }
);
type Proposal = Summary & { items: Item[]; blockIds: string[]; result: (Reference & {undo_token?: string}) | null };

function proposalsPath(id: string) { return '/textbooks/' + encodeURIComponent(id) + '/proposals'; }

function Version({ title, position }: { title: string; position: Position | null }) {
  const body = position?.block.body;
  const source = body?.kind === 'image' ? body.source : body?.kind === 'reference' ? body.target : null;
  return <div className="proposal-version"><small>{title}</small>
    {position ? <>
      <BodyView body={position.block.body} />
      {source && <small>{source.fact.id} · 第 {source.fact.rev} 版 · {
        source.anchor.kind === 'block' ? source.anchor.blockId : source.anchor.kind === 'path' ? source.anchor.path.join(' / ') : '全文'}</small>}
      <small>{position.block.parentId ? '父块 ' + position.block.parentId : '页内顶层'} · 第 {position.siblingIndex + 1} 项</small>
    </> : <p>无此块</p>}
  </div>;
}

type Props = { id: string; rev: number; proposalId: string; onDecision?: () => void };
function ProposalReview({ id, rev, proposalId, onDecision }: Props) {
  const path = proposalsPath(id) + '/' + encodeURIComponent(proposalId);
  const [data, show] = useState<Proposal>();
  const [selected, select] = useState<string[]>([]);
  const [version, refresh] = useState(0);
  const [busy, pending] = useState(false);
  const [error, report] = useState('');
  function check(value: Proposal) {
    if (value.proposalId !== proposalId || value.base.id !== id || value.base.rev !== rev ||
      !Object.hasOwn(states, value.status) || !Array.isArray(value.items) || !Array.isArray(value.blockIds) ||
      (value.status === 'applied' && (value.result?.id !== id || !(value.result.rev > rev))))
      throw new Error('提议回执与教材版本不符。');
    return value;
  }
  useEffect(() => {
    const abort = new AbortController();
    show(undefined);
    report('');
    api<Proposal>(path, { signal: abort.signal, cache: 'no-store' }).then(check).then(value => {
      if (!abort.signal.aborted) show(value);
    }).catch(() => { if (!abort.signal.aborted) report('无法读取这份教材建议。'); });
    return () => abort.abort();
  }, [path, rev, version]);

  async function decide() {
    if (busy || data?.status !== 'proposed') return;
    pending(true);
    report('');
    try {
      const result = check(await api<Proposal>(path, { method: 'POST', body: { blockIds: selected } }));
      show(result);
      onDecision?.();
    } catch (cause) {
      if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
        onDecision?.();
        show(undefined);
        refresh(v => v + 1);
      } else report(cause instanceof ApiError ? cause.message : '无法确认处理结果，请重新读取。');
    } finally {
      pending(false);
    }
  }
  const final = data?.status === 'applied' || data?.status === 'rejected';
  const checked = final ? data.blockIds : selected;
  return <section className="proposal-review" aria-label="教材块差异">
    {error && <p role="alert">{error} <button className="text-button" onClick={() => refresh(v => v + 1)}>重新读取</button></p>}
    {!data && !error && <p role="status">正在读取建议…</p>}
    {data && <>
      <div role="status"><strong>{states[data.status]}</strong> · 基于第 {rev} 版</div>
      {data.status === 'conflict' && <p>教材已有更新，请对照<a href={'/textbooks/page' + link({ id })}>当前版</a>查看原建议。</p>}
      {data.items.map(item => {
        const key = item.edit.blockId;
        return <section className="proposal-item" key={key}>
          <label><input type="checkbox" checked={checked.includes(key)} disabled={busy || item.state !== 'ready' || data.status !== 'proposed'}
            onChange={event => select(event.target.checked ? [...selected, key] : selected.filter(id => id !== key))} />
            <strong>{editLabels[item.edit.kind]}块 · {key}</strong></label>
          <div className="proposal-diff"><Version title="原文" position={item.before} />
            {item.state === 'ready' ? <Version title="建议" position={item.after} /> :
              <div className="proposal-version"><small>无法应用</small><p>{item.reason}</p></div>}
          </div>
        </section>;
      })}
      {data.status === 'proposed' && <button className="primary-button" disabled={busy} onClick={decide}>
        {busy ? '正在提交…' : selected.length ? '接受选中的 ' + selected.length + ' 项' : '拒绝全部建议'}</button>}
      {data.status === 'applied' && data.result && typeof data.result.undo_token === 'string' && data.result.undo_token &&
        <UndoPageWrite id={id} rev={data.result.rev} token={data.result.undo_token} />}
      {data.status === 'applied' && data.result && <a className="tonal-button" href={'/textbooks/page' + link(data.result)}>
        打开已更新的第 {data.result.rev} 版</a>}
    </>}
  </section>;
}

export function ProposalDetails({ label = '查看教材修改建议', ...props }: Props & { label?: string }) {
  const [open, toggle] = useState(false);
  return <details className="proposal-details" onToggle={event => toggle(event.currentTarget.open)}>
    <summary>{label}</summary>
    {open && <ProposalReview {...props} />}
  </details>;
}

export function PageProposals({ id }: { id: string }) {
  const list = useResource<{ proposals: Summary[] }>(proposalsPath(id));
  if (list.error || !list.data) return <ReadState resource={list} />;
  if (!list.data.proposals.length) return null;
  return <section className="page-proposals"><h2>同伴修改建议</h2>
    {list.data.proposals.map(p => <ProposalDetails key={p.proposalId} id={id} rev={p.base.rev} proposalId={p.proposalId}
      label={states[p.status] + ' · 基于第 ' + p.base.rev + ' 版'} onDecision={list.reload} />)}
  </section>;
}
