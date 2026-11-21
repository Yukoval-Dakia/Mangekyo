import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

type Grant = {id: string; rev: number; teaching: boolean};
type DisplayGrant = Grant & {paperRev: number; numbers: number[]};
type Page = {items: (Grant | DisplayGrant)[]; next: string | null};

function GrantControl({grant, disabled, isQuestion, change}: {
  grant: Grant | DisplayGrant; disabled: boolean; isQuestion: boolean; change: (grant: Grant) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return <li>
    {'numbers' in grant && <>
      <strong>第 {grant.numbers.join('、')} 题的答案展示</strong>
      <p className="muted">卷面第 {grant.paperRev} 版 · 见证 {grant.id}</p>
    </>}
    <p>{grant.teaching ? '已授权伴学使用' : '仅本人可用'}</p>
    {!grant.teaching && <label>
      <input type="checkbox" checked={confirmed} disabled={disabled}
        onChange={event => setConfirmed(event.currentTarget.checked)} />
      {isQuestion ? ' 我允许伴学使用这道题的题面' : ' 我允许伴学使用这条已确认的答案展示见证'}
    </label>}
    <div><button type="button" className="tonal-button" disabled={disabled || (!grant.teaching && !confirmed)}
      onClick={() => { setConfirmed(false); change(grant); }}>
      {grant.teaching ? '撤回授权' : '确认授权'}
    </button></div>
  </li>;
}

export function WorkbookAccess({paperId, attemptId, displayId}: {
  paperId: string; attemptId?: string; displayId?: string | undefined;
}) {
  const isQuestion = attemptId === undefined;
  const [page, setPage] = useState<Page>();
  const [after, setAfter] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [reading, setReading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [notice, setNotice] = useState('');
  const [readError, setReadError] = useState(false);
  const inFlight = useRef(false);
  const questionPath = '/papers/sealed-practice/' + encodeURIComponent(paperId) + '/teaching';
  const displayPath = '/papers/' + encodeURIComponent(paperId) + '/attempts/' + encodeURIComponent(attemptId ?? '') + '/answer-displays';

  useEffect(() => {
    const controller = new AbortController();
    const options = {signal:controller.signal};
    const request = isQuestion
      ? api<Grant>(questionPath,options).then(item => ({items:[item],next:null}))
      : api<Page>(displayPath + (after ? '?after=' + encodeURIComponent(after) : ''),options);
    setReading(true);
    setReadError(false);
    setPage(undefined);
    request.then(result => {
      if (!controller.signal.aborted) setPage(result);
    }).catch(() => {
      if (!controller.signal.aborted) setReadError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setReading(false);
    });
    return () => controller.abort();
  }, [isQuestion,questionPath,displayPath,after,epoch,displayId]);

  async function change(grant: Grant) {
    if (inFlight.current || reading) return;
    inFlight.current = true;
    setWriting(true);
    setNotice('');
    try {
      await api(isQuestion ? questionPath : '/workspace/access/records/' + encodeURIComponent(grant.id),{
        method:'PUT',body:{expectedRev:grant.rev,...(isQuestion
          ? {allowed:!grant.teaching} : {enabled:!grant.teaching})},
      });
    } catch (error) {
      setNotice(error instanceof ApiError && error.status === 409
        ? '权限已在别处更新。请核对刷新后的状态，再决定是否授权。'
        : '未收到权限更新回执。请核对刷新后的状态。');
    } finally {
      setReading(true);
      setEpoch(value => value + 1);
      setWriting(false);
      inFlight.current = false;
    }
  }

  const id = isQuestion ? 'question-teaching' : 'answer-display-access';
  const busy = reading || writing;
  return <section className="workbook-editor-block" id={id} aria-labelledby={id+'-heading'} tabIndex={-1}>
    <div className="subhead">
      <h3 id={id+'-heading'}>{isQuestion ? '原题题面权限' : '答案展示见证权限'}</h3>
      <button type="button" className="text-button" disabled={busy}
        onClick={() => { setNotice(''); setReading(true); setEpoch(value => value + 1); }}>刷新权限</button>
    </div>
    {!isQuestion && <p className="muted">展示见证记录哪些题的答案已经显示。伴学读取见证还需要卷面和这次作答的权限，可在「学习设置 → 学习记录访问」分别管理。</p>}
    {notice && <p role="alert">{notice}</p>}
    {busy && <p role="status">{writing ? '正在更新权限…' : '正在读取权限…'}</p>}
    {readError && <p role="alert">暂时无法读取权限。请刷新后再试。</p>}
    {page && <ul>{page.items.map(grant => <GrantControl key={grant.id+':'+grant.rev}
      grant={grant} disabled={busy} isQuestion={isQuestion} change={item => void change(item)} />)}</ul>}
    {page?.items.length === 0 && <p>本次作答暂无已确认的答案展示见证。</p>}
    {after && <button type="button" className="text-button" disabled={busy}
      onClick={() => { setReading(true); setAfter(null); }}>回到第一页</button>}
    {page?.next && <button type="button" className="text-button" disabled={busy}
      onClick={() => { setReading(true); setAfter(page.next); }}>更多展示见证</button>}
  </section>;
}
