import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkbookFeedback } from '../../../modules/activity/workbook-values.ts';
import { api, ApiError, requestId } from './api';
import { ExpectedView } from './expected-view';
import { ReadState, useResource } from './workspace';

type Receipt = { revision: number; enabled: boolean } | { revision: number; allowed: boolean };
type Sheet = { id: string; title: string; steps: string[]; tier: number; cost: number; source: { href: string } };
type Source = { paperTitle: string; questionNumber: number; prompt: string; feedback: WorkbookFeedback };

const researchSettingsChanged = 'research-settings-changed';

function ResearchChoice({ path, field, label, help, children }: {
  path: string;
  field: 'enabled' | 'allowed';
  label: string;
  help: string;
  children?: (allowed: boolean, revision: number, refresh: () => void) => ReactNode;
}) {
  const [receipt, setReceipt] = useState<Receipt>();
  const [choice, setChoice] = useState<boolean>();
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [readFailed, setReadFailed] = useState(false);
  const current = receipt && ('enabled' in receipt ? receipt.enabled : receipt.allowed);

  function refresh() {
    setReceipt(undefined);
    setReadFailed(false);
    setVersion(n => n + 1);
  }

  useEffect(() => {
    const controller = new AbortController();
    api<Receipt>(path, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setReceipt(result);
    }).catch(() => {
      if (!controller.signal.aborted) setReadFailed(true);
    });
    return () => controller.abort();
  }, [path, version]);

  async function save() {
    if (!receipt || choice === undefined || busy) return;
    setBusy(true);
    setMessage('');
    try {
      setReceipt(await api<Receipt>(path, { method: 'PUT', body: {
        revision: receipt.revision, requestId: requestId(), [field]: choice,
      } }));
      setChoice(undefined);
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 409
        ? '版本已更新。已保留你的选择，请核对当前状态。'
        : '未能确认保存结果。请核对当前状态后重试。');
      refresh();
    } finally {
      setBusy(false);
      if (field === 'enabled') window.dispatchEvent(new Event(researchSettingsChanged));
    }
  }

  return <section className="research-choice">
    <label className="workbook-check">
      <input type="checkbox" checked={choice ?? current ?? false} disabled={!receipt || busy}
        onChange={event => { setChoice(event.target.checked); setMessage(''); }} />
      <strong>{label}</strong>
    </label>
    <p className="field-help">{help}</p>
    <div className="research-controls">
      <span role="status">{readFailed ? '无法读取当前状态' : !receipt ? '正在读取…' :
        field === 'enabled' ? (current ? '当前已启用' : '当前已关闭') : (current ? '本次作答已开放' : '本次作答未授权')}</span>
      {readFailed ? <button type="button" className="text-button" onClick={refresh}>重新读取</button> :
        <button type="button" className="text-button" disabled={!receipt || choice === undefined || current === choice || busy}
          onClick={() => void save()}>{busy ? '保存中…' : field === 'enabled' ? '保存教研设置' : '保存本次授权'}</button>}
    </div>
    {message && <p role="alert" className="error-text">{message}</p>}
    {receipt && children?.(Boolean(current), receipt.revision, refresh)}
  </section>;
}

export function ResearchSettings() {
  return <ResearchChoice path="/research/settings" field="enabled" label="启用后台教研"
    help="启用后，同伴可以为你准备零费用复习单。你可以在原卷开放单次作答，也可以在后测对账中开放该次摘要。" />;
}

function WorksheetSource({ href, unavailable }: { href: string; unavailable: () => void }) {
  const [source, setSource] = useState<Source>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function open() {
    setBusy(true);
    setError('');
    try {
      setSource(await api<Source>(href.slice('/api'.length)));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) unavailable();
      else setError('无法读取来源，请重试。');
    } finally { setBusy(false); }
  }
  return <>
    <button type="button" className="text-button" disabled={busy} aria-expanded={!!source}
      onClick={() => source ? setSource(undefined) : void open()}>{source ? '收起来源' : '查看原卷来源'}</button>
    {error && <p role="alert">{error}</p>}
    {source && <blockquote>
      <strong>{source.paperTitle} · 第 {source.questionNumber} 题</strong>
      <p>{source.prompt}</p><p>你的原答：{source.feedback.answer}</p>
      <p><ExpectedView expected={source.feedback.expected} /></p>
    </blockquote>}
  </>;
}

function WorksheetContents({ sheet }: { sheet: Sheet }) {
  return <>
    <h3>{sheet.title}</h3>
    <p className="field-help">Tier {sheet.tier} · 费用 {sheet.cost}</p>
    <ol>{sheet.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
  </>;
}

function Worksheet({ path, refresh }: { path: string; refresh: () => void }) {
  const resource = useResource<{ worksheet: Sheet | null }>(path);
  const sheet = resource.data?.worksheet;
  return <div className="research-sheet">
    <ReadState resource={resource} />
    {!resource.error && resource.data && (sheet ? <>
      <WorksheetContents sheet={sheet} />
      <WorksheetSource key={sheet.id} href={sheet.source.href} unavailable={refresh} />
    </> : <p>暂未产出复习单。 <button type="button" className="text-button" onClick={refresh}>重新查看</button></p>)}
  </div>;
}

export function AttemptResearch({ paperId, attemptId }: { paperId: string; attemptId: string }) {
  const path = '/papers/' + encodeURIComponent(paperId) + '/attempts/' + encodeURIComponent(attemptId) + '/research';
  return <ResearchChoice path={path + '-permission'} field="allowed" label="向后台教研开放本次作答"
    help="开放后，后台教研可读取这份原答。收回后，这次作答的复习单及其来源将不再可读。">
    {(allowed, revision, refresh) => allowed && <Worksheet key={revision} path={path} refresh={refresh} />}
  </ResearchChoice>;
}

type ReconciliationResearchView = {
  enabled: boolean;
  revision: number;
  allowed: boolean;
  worksheet: (Sheet & { method: string; deliveredAt: string; digest?: string }) | null;
};

export function ReconciliationResearch({ recordKey }: { recordKey: string }) {
  const path = '/retention/' + encodeURIComponent(recordKey) + '/research';
  const [view, setView] = useState<ReconciliationResearchView>();
  const [message, setMessage] = useState('');
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const activeRead = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const refresh = useCallback(() => {
    activeRead.current?.abort();
    setView(undefined);
    setReadFailed(false);
    if (document.hidden || saving.current) return;
    const controller = new AbortController();
    activeRead.current = controller;
    api<ReconciliationResearchView>(path, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setView(result);
    }).catch(() => {
      if (!controller.signal.aborted) setReadFailed(true);
    });
  }, [path]);

  useEffect(() => {
    refresh();
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener(researchSettingsChanged, refresh);
    return () => {
      activeRead.current?.abort();
      activeRead.current = null;
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(researchSettingsChanged, refresh);
    };
  }, [refresh]);

  async function save() {
    if (!view || saving.current) return;
    saving.current = true;
    setBusy(true);
    setMessage('');
    setView(undefined);
    try {
      await api<ReconciliationResearchView>(path, { method: 'PUT', body: {
        requestId: requestId(), revision: view.revision, allowed: !view.allowed,
      } });
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 409
        ? '授权状态已变化，请核对后再操作。' : '未能确认保存结果，请核对当前状态。');
    } finally {
      saving.current = false;
      setBusy(false);
      if (activeRead.current) refresh();
    }
  }

  return <section className="research-choice" aria-label="后测复习单">
    <p className="field-help">你可以授权后台使用此次对账摘要，生成零费用复习单。授权可随时在这里撤回。</p>
    {message && <p role="alert">{message}</p>}
    {!view ? <div className="research-controls">
      {busy || !readFailed ? <span role="status">{busy ? '正在保存…' : '正在读取授权…'}</span> :
        <><span role="alert">暂时无法读取本次授权。</span> <button type="button" className="text-button" onClick={refresh}>重新读取</button></>}
    </div> : <>
      {!view.enabled && <p>后台教研已关闭。可在「学习设置」中启用后台教研。</p>}
      <div className="research-controls">
        <span role="status">{view.allowed ? '此次摘要已授权' : '此次摘要未授权'}</span>
        {(view.allowed || view.enabled) && <button type="button" className="text-button"
          onClick={() => void save()}>{view.allowed ? '撤回此次授权' : '授权使用此次摘要'}</button>}
      </div>
      {view.enabled && view.allowed && <div className="research-sheet">
        {view.worksheet ? <>
          <WorksheetContents sheet={view.worksheet} />
          {view.worksheet.digest && <p>{view.worksheet.digest}</p>}
          <a href="#posttest-result">查看对账来源</a>
        </> : <p>此次摘要已开放，暂未生成复习单。 <button type="button" className="text-button" onClick={refresh}>重新查看</button></p>}
      </div>}
    </>}
  </section>;
}
