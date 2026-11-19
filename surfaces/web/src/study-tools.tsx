import type {Settings} from './api';
import {selectedRoute} from './model-route';
import { useRef, useState } from 'react';
import { api, ApiError, requestId, type Turn } from './api';
import { RecallCards, type RecallTransport } from './recall-cards';
import { ReadState, useResource } from './workspace';

type Kit = NonNullable<Turn['recall']>;
type Discuss = (question: string, answer: string) => void;

function recallTransport(sessionId: string): RecallTransport {
  const path = '/sessions/' + encodeURIComponent(sessionId) + '/recall/';
  return {
    readState: ({ mount }) => api(path + 'state?' + new URLSearchParams(mount)),
    submit: body => api(path + 'submit', { method: 'POST', body }),
    async requestReveal(body) {
      const response = await fetch('/api' + path + 'reveal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const token = response.headers.get('x-recall-display-token');
      if (!response.ok || !token) throw new Error('无法获取揭示回执。');
      return { ...await response.json(), token, requestId: body.requestId };
    },
    async confirmDisplay({ mount, grant }) {
      const response = await fetch('/api' + path + 'display', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-recall-display-token': grant.token },
        body: JSON.stringify({ mount, revealId: grant.revealId, requestId: grant.requestId, observed: 'mounted-visible' }),
      });
      if (!response.ok) throw new Error('无法确认显示。');
      return response.json();
    },
  };
}

export function StudyCards({ kit, sessionId, materialId, discuss }: {
  kit: Kit; sessionId: string; materialId?: string | undefined; discuss?: Discuss | undefined;
}) {
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  const transport = recallTransport(sessionId);
  // Export includes solutions only when the learner explicitly chooses that action.
  const questions = () => Promise.all(kit.items.map(async ({ turnId, derivationId, itemId, prompt }) => {
    const grant = await transport.requestReveal({ mount: { turnId, derivationId, itemId }, requestId: requestId() });
    return { prompt, answer: grant.reference, rubric: grant.rubric };
  }));
  async function editPaper() {
    if (saving) return;
    setSaving(true);
    try {
      sessionStorage.setItem('mangekyo:paper-proposal', JSON.stringify({ title: kit.title, questions: await questions(), materialId }));
      location.assign('/papers/new?proposal=1');
    } catch { setSaving(false); setProblem('浏览器暂时无法保留草稿。你仍可在这次对话中查看讲义和题目。'); }
  }
  async function saveNote() {
    if (saving) return;
    setSaving(true);
    try {
      const markdown = [kit.lesson, ...(await questions()).map((q, i) => (i + 1) + '. ' + q.prompt + '\n\n' + q.answer)].join('\n\n');
      const payload = { title: kit.title, markdown, materialId: materialId ?? null };
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(location.search + JSON.stringify(payload)));
      const key = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
      const note = await api<{ id: string }>('/organizer/notes', { method: 'POST', body: { ...payload, requestId: 'kit-' + key } });
      location.assign('/notes?id=' + note.id);
    } catch { setSaving(false); setProblem('保存结果暂时无法确认，可以在这里重试。'); }
  }
  return <section className="study-cards" aria-label="同伴准备的练习">
    <RecallCards title={kit.title} items={kit.items} scope={sessionId} transport={transport}
      {...discuss && { onDiscuss: ({ prompt, answer }) => discuss(prompt, answer) }} />
    <div className="study-actions">
      <button className="primary-button" disabled={saving} onClick={() => void editPaper()}>含参考答案编辑小卷</button>
      <button className="tonal-button" disabled={saving} onClick={() => void saveNote()}>含参考答案保存为笔记</button>
    </div>
    {problem && <p role="alert">{problem}</p>}
  </section>;
}

type Memory = { text: string; revision: number; endpoint: string; protocol?: string; providerId?: string };

export function LearningMemory({ settings }: { settings: Settings | undefined }) {
  const endpoint = settings?.baseUrl;
  const memory = useResource<Memory>('/memory');
  const [draft, setDraft] = useState<{ text: string; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const intent = useRef({ key: '', id: '' });
  async function save() {
    if (!draft || !endpoint || busy) return;
    const data = { text: draft.text, revision: draft.revision, endpoint, route: selectedRoute(settings) };
    const key = JSON.stringify(data);
    if (intent.current.key !== key) intent.current = { key, id: requestId() };
    setBusy(true);
    try {
      await api('/memory', { method: 'POST', body: { ...data, requestId: intent.current.id } });
      setDraft(null); memory.reload();
      setStatus(draft.text.trim() ? '备忘已保存。' : '已停止在后续回复中使用这条备忘。');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        memory.reload();
        setStatus('备忘或端点已有变化。你的草稿还在，请核对已保存内容后再修改。');
      } else setStatus('保存结果暂时无法确认，可以用原草稿重试。');
    } finally { setBusy(false); }
  }
  return <section className="goal-panel memory-panel">
    <div className="subhead"><h2>同伴备忘</h2>
      {!draft && memory.data && <button className="text-button" onClick={() => { setStatus(''); setDraft({ ...memory.data! }); }}>{memory.data.text ? '修改备忘' : '写一条备忘'}</button>}
    </div>
    <ReadState resource={memory} />
    {memory.data && <p className="preserve">{memory.data.text || '你可以告诉同伴，以后希望它怎样陪你学。'}</p>}
    {memory.data?.text && (memory.data.endpoint !== endpoint || (memory.data.providerId ?? 'default') !== settings?.activeProviderId || (memory.data.protocol ?? 'openai') !== settings?.protocol) && <p>这条备忘绑定了另一模型端点。重新保存后才会在当前端点使用。</p>}
    {draft && <form onSubmit={e => {e.preventDefault(); void save();}}>
      <label className="field"><span>希望同伴记住什么</span>
        <textarea rows={3} maxLength={800} disabled={busy} value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} /></label>
      <p className="field-help">保存后，普通同伴对话会把这段文字发送给 {endpoint ?? '当前模型端点'}。留空保存可停止后续使用。已经发送的对话仍可回看。</p>
      {memory.data && memory.data.revision !== draft.revision && <button className="text-button" type="button" onClick={() => setDraft({ ...draft, revision: memory.data!.revision })}>已核对当前版本，保留我的修改</button>}
      <div className="study-actions"><button className="primary-button" disabled={busy || !endpoint}>保存备忘</button><button type="button" className="text-button" disabled={busy} onClick={() => setDraft(null)}>取消</button></div>
    </form>}
    {status && <p role="status">{status}</p>}
  </section>;
}
