import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkbookFeedback } from '../../../modules/activity/workbook-values.ts';
import { api, ApiError, requestId } from './api';
import { ExpectedView } from './expected-view';
import { ReadState, useResource } from './workspace';

type ScoutOffer = { route: string; maxRetentionDays: number; maxPerCallMicros: number };
type ScoutBudget = ScoutOffer & { limitMicros: number; expiresAtMs: number };
type Receipt = { revision: number; enabled: boolean; scoutBudget?: ScoutBudget | null; scoutOffer?: ScoutOffer; heldUsdMicros?: string; settledUsdMicros?: string } | { revision: number; allowed: boolean };
type Sheet = { id: string; title: string; steps: string[]; tier: number; cost: number; source: { href: string } };
type Source = { paperTitle: string; questionNumber: number; prompt: string; feedback: WorkbookFeedback };

const researchSettingsChanged = 'research-settings-changed';

function ResearchChoice({ path, field, label, help, children, onSaved }: {
  path: string;
  field: 'enabled' | 'allowed';
  label: string;
  help: string;
  onSaved?: () => void;
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
        revision: receipt.revision, requestId: requestId(), [field]: choice, ...(field === 'enabled' && {scoutBudget: null}),
      } }));
      setChoice(undefined);
      onSaved?.();
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
    {receipt && 'enabled' in receipt && <>
      {receipt.scoutBudget && <p>{receipt.scoutBudget.expiresAtMs > Date.now() ? '已授权前哨将开放作答的卷名和作答摘要发送至' : '前哨授权已到期，原接收方为'} {receipt.scoutBudget.route}。
        每次上限 {receipt.scoutBudget.maxPerCallMicros} USD 微元，累计上限 {receipt.scoutBudget.limitMicros} USD 微元，留存上限 {receipt.scoutBudget.maxRetentionDays} 天，
        有效至 {new Date(receipt.scoutBudget.expiresAtMs).toLocaleString()}。</p>}
      {receipt.settledUsdMicros !== undefined && <p>前哨累计实付 {receipt.settledUsdMicros} USD 微元，待核占用 {receipt.heldUsdMicros} USD 微元。</p>}
    </>}
    <div className="research-controls">
      <span role="status">{readFailed ? '无法读取当前状态' : !receipt ? '正在读取…' :
        field === 'enabled' ? (current ? '当前已启用' : '当前已关闭') : (current ? '本次作答已开放' : '本次作答未授权')}</span>
      {readFailed ? <button type="button" className="text-button" onClick={refresh}>重新读取</button> :
        <button type="button" className="text-button" disabled={!receipt || choice === undefined || current === choice || busy}
          onClick={() => void save()}>{busy ? '保存中…' : field === 'enabled' ? '保存教研设置' : '保存本次授权'}</button>}
    </div>
    {receipt && 'enabled' in receipt && receipt.scoutOffer && receipt.enabled && <ScoutGrant key={receipt.revision}
      offer={receipt.scoutOffer} current={receipt.scoutBudget} revision={receipt.revision} refresh={refresh} />}
    {message && <p role="alert" className="error-text">{message}</p>}
    {receipt && children?.(Boolean(current), receipt.revision, refresh)}
  </section>;
}

function ScoutGrant({ offer, current, revision, refresh }: {
  offer: ScoutOffer; current: ScoutBudget | null | undefined; revision: number; refresh: () => void;
}) {
  const [limit, setLimit] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ body: string; id: string } | null>(null);
  const expiresAtMs = Date.parse(until);
  const valid = /^\d+$/.test(limit) && Number.isSafeInteger(Number(limit)) &&
    Number(limit) >= offer.maxPerCallMicros && expiresAtMs > Date.now();

  async function save(grant: boolean) {
    if (busy || (grant && !valid)) return;
    const scoutBudget = grant ? { ...offer, limitMicros: Number(limit), expiresAtMs } : null;
    const body = JSON.stringify({ revision, enabled: true, scoutBudget });
    if (pending.current?.body !== body) pending.current = { body, id: requestId() };
    setBusy(true);
    setError('');
    try {
      await api('/research/settings', {method: 'PUT', body: {revision, enabled: true, scoutBudget, requestId: pending.current.id}});
      refresh();
      window.dispatchEvent(new Event(researchSettingsChanged));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) refresh();
      else setError('尚未收到保存回执，可重试同一操作。');
    } finally { setBusy(false); }
  }

  return <details className="research-sheet">
    <summary>付费前哨授权</summary>
    <p>接收方 {offer.route} 会收到已开放作答的标识、卷名、提交时间和首道错题序号，用于选择复习任务。
      最多留存 {offer.maxRetentionDays} 天，每次最多 {offer.maxPerCallMicros} USD 微元。</p>
    <p>1 美元为 1,000,000 微元。累计上限包含已付及待结算的费用。</p>
    <label>累计上限（USD 微元）<input type="number" min={offer.maxPerCallMicros} step="1" value={limit}
      onChange={e => setLimit(e.target.value)} /></label>
    <label>授权到期时间<input type="datetime-local" value={until} onChange={e => setUntil(e.target.value)} /></label>
    <button type="button" disabled={busy || !valid} onClick={() => void save(true)}>确认外发范围与费用上限</button>
    {current && <button type="button" disabled={busy} onClick={() => void save(false)}>撤回付费授权</button>}
    {error && <p role="alert">{error}</p>}
  </details>;
}

export function ResearchSettings() {
  return <ResearchChoice path="/research/settings" field="enabled" label="启用后台教研"
    help="从这里启用时只运行本地教研。关闭会撤回付费前哨授权。你可以在原卷或后测对账中逐次开放作答。" />;
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
    <p className="field-help">Tier {sheet.tier} · 复习单生成费用 {sheet.cost}</p>
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

export function AttemptResearch({ paperId, attemptId, onSaved }: { paperId: string; attemptId: string; onSaved?: () => void }) {
  const path = '/papers/' + encodeURIComponent(paperId) + '/attempts/' + encodeURIComponent(attemptId) + '/research';
  return <ResearchChoice path={path + '-permission'} field="allowed" label="向后台教研开放本次作答" onSaved={onSaved}
    help="开放后，后台教研可读取这份原答。如已另行授权付费前哨，该服务可收到卷名、提交时间与错题摘要。收回后，这次作答的复习单及其来源将不再可读。">
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
