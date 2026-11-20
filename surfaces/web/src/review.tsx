import { useRef, useState } from 'react';
import { api, deletedSubmission, submissionId } from './api';
import { PageTitle, ReadState, useResource } from './workspace';
import { Message } from './message';
import { useWorkbookPresentation } from './workbook-presentation';

export type ReviewEntry = {
  paperId: string; title: string; questionId: string; prompt: string;
  answer: string; expected: string; explanation: string | null;
};

export function Mistakes() {
  const items = useResource<ReviewEntry[]>('/review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const intent = useRef({text:'', id:''});
  const entries: string[] = [];
  for (const item of items.data ?? []) {
    const text = '《'+item.title+'》\n题目：'+item.prompt+'\n我的作答：'+item.answer+'\n参考答案：'+item.expected;
    if ([...entries,text].join('\n\n').length > 3000 || entries.length >= 5) break;
    entries.push(text);
  }
  async function discuss() {
    if (busy) return;
    const text = entries.join('\n\n');
    const title = '错题复习单 · '+new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric'}).format(new Date());
    if (intent.current.text !== text) intent.current = {text, id:submissionId()};
    setBusy(true);
    try {
      const {id} = await api<{id:string}>('/materials',{method:'POST',body:{requestId:intent.current.id,title,text}});
      location.assign('/companion?review=1&material='+id);
    } catch (error) {
      if (deletedSubmission(error)) {
        intent.current = {text:'',id:''};
        items.reload();
        setError('删除状态已变化，请核对当前错题后重新交入。');
      } else setError('复习单暂时未能保存，可以重试。');
      setBusy(false);
    }
  }
  return <>
    <PageTitle title="错题回看"><a className="tonal-button" href="/papers">我的练习</a></PageTitle>
    <ReadState resource={items} />
    {entries.length > 0 && <section className="goal-panel">
      <h2>这几题可能错在同一步吗？</h2>
      <p>将下方前 {entries.length} 题的题面、你的回答和参考答案保存为复习单。进入同伴后，可以删减选段再发送。</p>
      <button className="tonal-button" disabled={busy} onClick={() => void discuss()}>保存复习单，找同伴分析</button>
      {error && <p role="alert">{error}</p>}
    </section>}
    {items.data?.length === 0 && <section className="goal-panel"><h2>还没有待复习的错题</h2><p>练习中答错的题会收在这里。再答正确后，原作答保留在卷子的历史里。</p><a href="/papers">打开练习</a></section>}
    {items.data?.map(item => <article className="review-item" key={item.paperId + item.questionId}>
      <small>{item.title}</small><h2>{item.prompt}</h2><p>上次回答　{item.answer}</p>
      <details><summary>看参考答案</summary><p>{item.expected}</p>{item.explanation && <Message text={item.explanation} />}</details>
      <a className="text-button" href={item.paperId === 'riding' ? '/practice/riding' : '/papers/'+item.paperId}>回原卷重做</a>
    </article>)}
  </>;
}

type Sheet = { revision?: number; title: string; questions: { id: string; prompt: string; unit?: string | null }[] };
export function PrintPaper({ id }: { id: string }) {
  const sheet = useResource<Sheet>('/papers/'+id+'/print');
  const paper = sheet.error ? undefined : sheet.data;
  const display = useWorkbookPresentation(id, paper?.revision, paper?.questions.map(question => question.id) ?? []);
  return <section className="print-paper">
    <div className="study-actions print-controls"><a href={'/papers/'+id}>返回原卷</a>
      <button className="primary-button" disabled={!paper || !display.allowed} onClick={() => window.print()}>打印或存为 PDF</button></div>
    <ReadState resource={sheet} />
    {display.error && <p role="alert">{display.error} <button onClick={display.retry}>重试</button></p>}
    {paper && !display.allowed && !display.error && <p role="status">正在确认打印卷展示许可…</p>}
    {paper && display.allowed && <><h1>{paper.title}</h1><p>姓名 __________________　日期 __________________</p>
      <ol>{paper.questions.map(q => <li key={q.id}><Message text={q.prompt} />{q.unit && <small>单位：{q.unit}</small>}<div className="answer-lines" /></li>)}</ol></>}
  </section>;
}
