import { useState } from 'react';
import type { PageWrite } from '../api';
import { ProposalDetails } from './ProposalReview';
import { UndoPageWrite } from './UndoPageWrite';
import { link } from './contract';

type Props = { id: string; rev: number; title: string; page: PageWrite };
export function PageWriteReceipt({ id, rev, title, page }: Props) {
  const [outcome, setOutcome] = useState<'withdrawn' | 'reverted'>();
  const status = page.status === 'saved' ? outcome ?? 'saved' : page.status;
  return <li className="page-write">
    <div><strong>{title}</strong> · 第 {rev} 版</div>
    {page.status === 'proposed'
      ? <ProposalDetails id={id} rev={rev} proposalId={page.proposalId} />
      : <span role="status">{{ saved: '已保存到个人教材', withdrawn: '新建教材页已撤回', reverted: '修改已撤回，已恢复先前内容',
          changed: '教材已变更，无法撤回原版本。', proposed: '' }[status]}</span>}
    {status !== 'withdrawn' && <a href={'/textbooks/page' + link({ id, rev })}>打开教材第 {rev} 版</a>}
    {status === 'saved' && page.status === 'saved' && <UndoPageWrite id={id} rev={rev} token={page.undo_token} onUndo={setOutcome} />}
  </li>;
}
