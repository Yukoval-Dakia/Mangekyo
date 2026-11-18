import { useRef, useState } from 'react';
import { api, ApiError, requestId, type Turn } from './api';
import { ReadState, useResource } from './workspace';

type Kit = NonNullable<Turn['studyKit']>;
type Discuss = (question: string, answer: string) => void;

function RecallCard({question, number, discuss}: {question: Kit['questions'][number]; number: number; discuss?: Discuss | undefined}) {
  const [answer, setAnswer] = useState('');
  return <article className="recall-card">
    <label className="field"><span>{number}. {question.prompt}</span>
      <input value={answer} maxLength={1000} onChange={event => setAnswer(event.target.value)} placeholder="先试着用自己的话回答" /></label>
    <div className="study-actions">
      <details><summary>核对参考答案</summary><p>{question.answer}</p></details>
      {discuss && <button type="button" className="text-button" disabled={!answer.trim()} onClick={() => discuss(question.prompt, answer.trim())}>带着我的回答追问</button>}
    </div>
  </article>;
}

export function StudyCards({ kit, materialId, discuss }: { kit: Kit; materialId?: string | undefined; discuss?: Discuss | undefined }) {
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  function editPaper() {
    try {
      sessionStorage.setItem('mangekyo:paper-proposal', JSON.stringify({ ...kit, materialId }));
      location.assign('/papers/new?proposal=1');
    } catch { setProblem('浏览器暂时无法保留草稿。你仍可在这次对话中查看讲义和题目。'); }
  }
  async function saveNote() {
    if (saving) return;
    setSaving(true);
    try {
      const markdown = [kit.lesson, ...kit.questions.map((q, i) => (i + 1) + '. ' + q.prompt + '\n\n' + q.answer)].join('\n\n');
      const payload = { title: kit.title, markdown, materialId: materialId ?? null };
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(location.search + JSON.stringify(payload)));
      const key = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
      const note = await api<{ id: string }>('/organizer/notes', { method: 'POST', body: { ...payload, requestId: 'kit-' + key } });
      location.assign('/notes?id=' + note.id);
    } catch { setSaving(false); setProblem('保存结果暂时无法确认，可以在这里重试。'); }
  }
  return <section className="study-cards" aria-label="同伴准备的练习">
    <h3>{kit.title}</h3>
    <p>先自己回答，再展开核对。可以把这些题编辑成一份单独作答的小卷。</p>
    {kit.questions.map((q, index) => <RecallCard key={q.prompt} question={q} number={index+1} discuss={discuss} />)}
    <div className="study-actions">
      <button className="primary-button" onClick={editPaper}>编辑并收进题库</button>
      <button className="tonal-button" disabled={saving} onClick={() => void saveNote()}>保存为笔记</button>
    </div>
    {problem && <p role="alert">{problem}</p>}
  </section>;
}

type Memory = { text: string; revision: number; endpoint: string };

export function LearningMemory({ endpoint }: { endpoint: string | undefined }) {
  const memory = useResource<Memory>('/memory');
  const [draft, setDraft] = useState<{ text: string; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const intent = useRef({ key: '', id: '' });
  async function save() {
    if (!draft || !endpoint || busy) return;
    const data = { ...draft, endpoint };
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
    {memory.data?.text && memory.data.endpoint !== endpoint && <p>这条备忘绑定了另一模型端点。重新保存后才会在当前端点使用。</p>}
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
