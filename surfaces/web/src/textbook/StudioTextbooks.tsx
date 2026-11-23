import { useRef, useState, type FormEvent } from 'react';
import { RecordQuestionLink } from '../current-record';
import { api, requestId } from '../api';
import { Icon } from '../icons';
import { PageTitle, ReadState, useResource } from '../workspace';
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

export default function StudioTextbooks({ editor, embedded = false }: { editor: boolean; openAccess?: () => void; embedded?: boolean }) {
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
          : <p className="field-help">尚未进入伴学范围。可在「学习设置 → 访问与授权」统一核对学习记录开放状态。</p>}} />}
  </>;
  return <>
    {!embedded && <PageTitle title="个人教材" />}
    <form className="tb-create-bar" onSubmit={create}>
      <label className="tb-create-field">
        <span>{embedded ? '新教材页主题' : '教材页标题'}</span>
        <input
          required
          maxLength={240}
          value={title}
          disabled={busy}
          placeholder="输入新教材主题，例如：洛伦兹力与带电粒子运动"
          onChange={event => setTitle(event.target.value)}
        />
      </label>
      <button className="primary-button" disabled={busy || !title.trim()}>
        <Icon name="plus" />
        <span>{busy ? '创建中…' : '创建教材页'}</span>
      </button>
    </form>
    {error && <p className="tb-create-error" role="alert">{error}</p>}
    <ReadState resource={index} />
    {index.data && (
      index.data.pages.length ? (
        <div className="tb-page-grid">
          {index.data.pages.map(page => (
            <a key={page.id} className="tb-page-card" href={pagePath(page.id)}>
              <span className="tb-page-icon" aria-hidden="true"><Icon name="book" /></span>
              <strong>{page.title}</strong>
              <span>打开当前版本</span>
            </a>
          ))}
        </div>
      ) : (
        <section className="tb-empty">
          <h2>先建一页个人教材</h2>
          <p>写下你最想弄清的主题；教材页会沉淀章节、微探针与考前急救卡。</p>
        </section>
      )
    )}
  </>;
}
