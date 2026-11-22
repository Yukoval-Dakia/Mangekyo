import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, deletedSubmission, submissionId } from './api';
import { PageTitle, ReadState } from './workspace';
import { paperPracticePath } from './builtin-packs';
import { RecurringErrorStrip, type ErrorCluster } from './recurring-error-strip';
import { observedDeletionWatermark, subscribeDeletionWatermark } from './deletion-watermark';
import { useVisibleDocument } from './workbook-presentation';
import { Message } from './message';
import './review.css';

export type ReviewEntry = {
  paperId: string; title: string; questionId: string; prompt: string;
  recurringErrorCluster?: ErrorCluster;
  answer: string; expected: string; explanation: string | null;
};

function useReviewEntries() {
  const visible = useVisibleDocument();
  const generation = useSyncExternalStore(subscribeDeletionWatermark, observedDeletionWatermark);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<ReviewEntry[]>();
  const [error, setError] = useState(false);
  useLayoutEffect(() => {
    setData(undefined);
    setError(false);
    if (!visible) return;
    const controller = new AbortController();
    void api<ReviewEntry[]>('/review', {signal: controller.signal, cache: 'no-store'}).then(entries => {
      if (!controller.signal.aborted && generation === observedDeletionWatermark()) setData(entries);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [visible, generation, revision]);
  return {data, error, reload: () => setRevision(n => n + 1)};
}

export function Mistakes() {
  const items = useReviewEntries();
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
    {items.data?.length === 0 && <section className="goal-panel review-empty"><h2>还没有待复习的错题</h2><p>练习中答错的题会收在这里。再答正确后，原作答保留在卷子的历史里。</p><a className="tonal-button" href="/papers">打开练习</a></section>}
    {items.data?.map(item => <ReviewCard key={item.paperId + ':' + item.questionId} item={item}/>)}
  </>;
}

function ReviewCard({item}: {item: ReviewEntry}) {
  const {paperId, questionId} = item;
  const reopen = useCallback(async (signal: AbortSignal) => {
    const entries = await api<ReviewEntry[]>('/review', {signal, cache: 'no-store'});
    return entries.find(row => row.paperId === paperId && row.questionId === questionId)?.recurringErrorCluster;
  }, [paperId, questionId]);
  return <article className="review-item">
    <small>{item.title}</small><h2>{item.prompt}</h2><p>上次回答　{item.answer}</p>
    <RecurringErrorStrip initial={item.recurringErrorCluster} reopen={reopen}/>
    <details><summary>看参考答案</summary><p>{item.expected}</p>{item.explanation && <Message text={item.explanation} />}</details>
    <a className="text-button" href={paperPracticePath(item.paperId)}>回原卷重做</a>
  </article>;
}
