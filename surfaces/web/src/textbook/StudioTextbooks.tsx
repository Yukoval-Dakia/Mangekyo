import { useRef, useState, type FormEvent } from 'react';
import { RecordQuestionLink } from '../current-record';
import { api, requestId } from '../api';
import { ListLink, PageTitle, ReadState, useResource } from '../workspace';
import { TextbookWorkspace, textbookLink, type Page, type Transport } from './index';

import { pulseRows } from './pulse-projection';
import { PageProposals } from './ProposalReview';

const editorPath = '/textbooks/page';
const pagePath = (id: string) => editorPath + textbookLink({ id });
type WirePage = Omit<Page, 'pulse'> & {kind: string; masteryPulse?: unknown; pulse?: never};
const transport: Transport = {
  async read({ id, rev }) {
    const wire = await api<WirePage>('/textbooks/' + encodeURIComponent(id) +
      (rev === undefined ? '' : '?rev=' + encodeURIComponent(rev)), {cache: 'no-store'});
    const {masteryPulse, pulse: _unused, ...page} = wire;
    if (page.kind !== 'textbook') throw new Error('这是一份学习笔记，请从笔记入口打开。');
    if (rev !== undefined || !masteryPulse) return page;
    const initial = pulseRows(page, masteryPulse);
    return {...page, pulse: {initial, async read(signal: AbortSignal) {
      const current = await api<typeof wire>('/textbooks/' + encodeURIComponent(id), {signal, cache: 'no-store'});
      return current.kind === 'textbook' && current.id === id && current.rev === page.rev &&
        current.accessEpoch === page.accessEpoch ? pulseRows(current, current.masteryPulse) : new Map();
    }}};
  },
  async revise(request) {
    const { id, clientEditSeq } = request;
    const response = await fetch('/api/textbooks/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, requestId: id + '-' + clientEditSeq }),
    });
    const result = await response.json();
    if (response.status === 409 && result.current && result.originalEdit?.clientEditSeq === clientEditSeq)
      return { kind: 'conflict', clientEditSeq, page: result.current };
    if (!response.ok) throw new Error(result.error || '教材保存失败。');
    if (result.id !== id || result.clientEditSeq !== clientEditSeq || result.expectedRev !== request.expectedRev)
      throw new Error('教材保存回执与编辑不符。');
    const current = await transport.read({ id }).catch(() => null);
    const page = current && current.rev === result.rev ? current : await transport.read({ id, rev: result.rev });
    return { kind: 'saved', clientEditSeq, page };
  },
};

export default function StudioTextbooks({ editor, openAccess }: { editor: boolean; openAccess: () => void }) {
  const index = useResource<{ pages: { id: string; title: string }[] }>('/textbooks');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const intent = useRef<{ title: string; id: string } | null>(null);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || !title.trim()) return;
    if (intent.current?.title !== title) intent.current = { title, id: requestId() };
    setBusy(true);
    setError('');
    try {
      const { id } = await api<{ id: string }>('/textbooks', {
        method: 'POST', body: { requestId: intent.current.id, clientEditSeq: 0, page: { title, blocks: [] } },
      });
      location.assign(pagePath(id));
    } catch {
      setError('创建失败，请重试。');
      setBusy(false);
    }
  }
  if (editor) return <>
    <a className="back-link" href="/textbooks">‹ 教材列表</a>
    <ReadState resource={index} />
    {index.data && <TextbookWorkspace chapters={[{ title: '我的教材页', pages: index.data.pages }]}
      initialPage={index.data.pages[0]?.id ?? ''} draftScope="studio" transport={transport} slots={{review: page => <PageProposals key={page.id} id={page.id} />, practice: page =>
        page.purpose?.some(value => value === 'teaching' || value === 'all')
          ? <RecordQuestionLink kind="page" record={page} />
          : <button className="text-button" onClick={openAccess}>在学习记录访问中开放教材</button>}} />}
  </>;
  return <>
    <PageTitle title="个人教材" />
    <form className="study-actions" onSubmit={create}>
      <label className="field">教材页标题<input required maxLength={240} value={title}
        disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
      <button className="primary-button" disabled={busy || !title.trim()}>创建教材页</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <ReadState resource={index} />
    {index.data?.pages.map(page => <ListLink key={page.id} title={page.title}
      detail="打开当前版本" href={pagePath(page.id)} icon="book" />)}
  </>;
}
