import { useState } from 'react';
import { api, ApiError, type PageWrite } from '../api';
import { ProposalDetails } from './ProposalReview';
import { link } from './contract';

type Props = { id: string; rev: number; title: string; page: PageWrite };
export function PageWriteReceipt({ id, rev, title, page }: Props) {
  const [outcome, setOutcome] = useState<'withdrawn' | 'reverted'>();
  const [busy, pending] = useState(false);
  const [error, report] = useState('');
  const status = page.status === 'saved' ? outcome ?? 'saved' : page.status;

  async function undo() {
    if (page.status !== 'saved' || busy) return;
    pending(true);
    report('');
    try {
      const receipt = await api<{ status: 'withdrawn' | 'reverted'; ref: { id: string; rev: number } }>(
        '/textbooks/' + encodeURIComponent(id) + '/undo', { method: 'POST', body: { undo_token: page.undo_token } });
      if (!['withdrawn', 'reverted'].includes(receipt.status) || receipt.ref.id !== id || !Number.isSafeInteger(receipt.ref.rev) || receipt.ref.rev <= rev)
        throw new Error('教材撤回回执不符。');
      setOutcome(receipt.status);
    } catch (cause) {
      report(cause instanceof ApiError && cause.status === 409 ? '教材已变更。请刷新查看回执状态。' :
        '暂时无法确认撤回结果，请重试。');
    } finally {
      pending(false);
    }
  }
  return <li className="page-write">
    <div><strong>{title}</strong> · 第 {rev} 版</div>
    {page.status === 'proposed'
      ? <ProposalDetails id={id} rev={rev} proposalId={page.proposalId} />
      : <span role="status">{{ saved: '已保存到个人教材', withdrawn: '新建教材页已撤回', reverted: '修改已撤回，已恢复先前内容',
          changed: '教材已变更，无法撤回原版本。', proposed: '' }[status]}</span>}
    {status !== 'withdrawn' && <a href={'/textbooks/page' + link({ id, rev })}>打开教材第 {rev} 版</a>}
    {status === 'saved' && <button className="tonal-button" disabled={busy} onClick={undo}>{busy ? '正在撤回…' : '撤回教材写入'}</button>}
    {error && <span role="alert">{error}</span>}
  </li>;
}
