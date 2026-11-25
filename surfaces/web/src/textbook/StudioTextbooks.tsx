import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RecordQuestionLink } from '../current-record';
import { api, describeAuthoringError, generatePersonalTextbook, requestId, type AuthoringUiError } from '../api';
import { AuthoringFeedback } from '../AuthoringFeedback';
import { Icon } from '../icons';
import { PageTitle, ReadState, useResource } from '../workspace';
import { TextbookWorkspace, textbookLink, type Page, type Transport } from './index';
import { normalizeKnowledgeGraphResponse } from '../knowledge-graph/normalize';
import type { KnowledgeGraphNode } from '../knowledge-graph/types';

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
  const [aiTopic, setAiTopic] = useState('');
  const [aiConceptId, setAiConceptId] = useState('');
  const [aiMode, setAiMode] = useState<'full' | 'cheatsheet'>('full');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<AuthoringUiError | null>(null);
  const [concepts, setConcepts] = useState<readonly KnowledgeGraphNode[]>([]);
  const intent = useRef<{ title: string; id: string } | null>(null);
  const aiIntent = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    if (editor) return;
    const controller = new AbortController();
    api<unknown>('/knowledge/graph', {signal: controller.signal, cache: 'no-store'})
      .then(result => {
        if (!controller.signal.aborted) setConcepts(normalizeKnowledgeGraphResponse(result).nodes);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [editor]);
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
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (aiBusy || (!aiTopic.trim() && !aiConceptId)) return;
    const topic = aiTopic.trim();
    const key = JSON.stringify({topic, conceptId: aiConceptId, mode: aiMode});
    if (aiIntent.current?.key !== key) aiIntent.current = {key, id: requestId()};
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await generatePersonalTextbook({
        requestId: aiIntent.current.id,
        ...(aiConceptId ? {conceptId: aiConceptId} : {}),
        ...(topic ? {topic} : {}),
        mode: aiMode,
      });
      if (!result.href) throw new Error('教材生成回执未包含可打开的地址。');
      location.assign(result.href);
    } catch (failure) {
      setAiError(describeAuthoringError(failure));
      setAiBusy(false);
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
    <form className="tb-ai-create" onSubmit={generate}>
      <div className="tb-ai-create-heading">
        <strong>AI 生成个人活教材</strong>
        <span>按一个主题或概念，生成带讲解与练习的教材。</span>
      </div>
      <div className="tb-ai-create-fields">
        <label className="tb-create-field">
          <span>学习主题</span>
          <input
            maxLength={240}
            value={aiTopic}
            disabled={aiBusy}
            placeholder="例如：函数的单调性与导数"
            onChange={event => { setAiTopic(event.target.value); setAiError(null); }}
          />
        </label>
        {concepts.length > 0 && (
          <label className="tb-create-field tb-ai-concept">
            <span>或选择概念</span>
            <select
              value={aiConceptId}
              disabled={aiBusy}
              onChange={event => {
                const node = concepts.find(item => item.id === event.target.value);
                setAiConceptId(event.target.value);
                if (node) setAiTopic(node.title);
                setAiError(null);
              }}
            >
              <option value="">从知识图谱选择（可选）</option>
              {concepts.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="tb-ai-create-actions">
        <div className="m3e-btn-group" role="group" aria-label="教材生成模式">
          <button type="button" className="tonal-button" aria-pressed={aiMode === 'full'} disabled={aiBusy} onClick={() => setAiMode('full')}>
            完整精讲
          </button>
          <button type="button" className="tonal-button" aria-pressed={aiMode === 'cheatsheet'} disabled={aiBusy} onClick={() => setAiMode('cheatsheet')}>
            考前速查页
          </button>
        </div>
        <button className="primary-button" disabled={aiBusy || (!aiTopic.trim() && !aiConceptId)}>
          <span>{aiBusy ? '正在生成…' : '生成个人活教材'}</span>
        </button>
      </div>
      {aiBusy && <p className="tb-ai-create-status" role="status">正在依据你的学习资料生成教材，请稍候，勿重复点击。</p>}
      {aiError && <AuthoringFeedback error={aiError} className="tb-ai-create-error" linkClassName="text-button" />}
    </form>
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
