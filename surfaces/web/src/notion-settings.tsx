import { useEffect, useRef, useState } from 'react';
import { ApiError, requestId } from './api';
import './notion-settings.css';
import { latestKey, validWatermark, verifyGenerationReceipt } from './deletion-watermark';

const purposes = {storage: '仅保存', learning: '学习使用', 'turn-only': '仅本轮', temporary: '不留存临时'};
type Preset = keyof typeof purposes;
type Root = {kind: 'page' | 'data-source'; id: string};
type Recipient = {id: string; purpose: string; label?: string};
type Source = {id: string; rev: number; accessEpoch?: string; purpose?: string[]};
type Selection = {
  selectionId: string; epoch: string; active: boolean; label: string; root: Root;
  preset: Preset; recipients: Recipient[]; sources: Source[];
};
type Settings = {
  configured: boolean; watermark: string; selections: Selection[];
  presets: {id: Preset; available: boolean; reason?: string; allowedRecipients: Recipient[]}[];
};
type Command = {
  action: 'grant' | 'sync' | 'revoke' | 'purpose';
  sourceId?: string;
  body: {requestId: string; selectionId: string; expectedEpoch: string; deletionWatermark: string;
    root?: Root; preset?: Preset; recipients?: Recipient[]; recipient?: Recipient; expectedRev?: number; accessEpoch?: string};
};

const normalized = (id: string) => id.toLowerCase().replaceAll('-', '');
const sameRoot = (a: Root, b: Root) => a.kind === b.kind && normalized(a.id) === normalized(b.id);
const idPattern = '(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})';

const sameRecipient = (a: Recipient, b: Recipient) => a.id === b.id && a.purpose === b.purpose;
const purposeLabel = (purpose: string) => ({storage: '本人存储', learning: '学习阅读', teaching: '教学'}[purpose] || purpose);

async function readSettings(signal?: AbortSignal): Promise<Settings> {
  const response = await fetch('/api/notion/settings', {cache: 'no-store', signal: signal ?? null});
  if (!response.ok) throw new Error();
  const state: Settings = await response.json();
  if (!validWatermark(state.watermark) || !Array.isArray(state.presets) || !Array.isArray(state.selections)) throw new Error();
  return state;
}

function configuration(settings: Settings) {
  return JSON.stringify([settings.watermark, settings.configured, settings.presets]);
}

function commandBasis(state: Settings, cmd: Command) {
  const selection = state.selections.find(s => s.selectionId === cmd.body.selectionId ||
    (cmd.body.root && sameRoot(s.root, cmd.body.root)));
  const source = cmd.action === 'purpose' ? selection?.sources.find(r => r.id === cmd.sourceId) : undefined;
  return JSON.stringify([configuration(state), selection?.selectionId, selection?.epoch, source]);
}

type Confirmation = {epoch: string; sources: Source[]};

function checkReceipt(cmd: Command, receipt: Record<string, unknown>): Confirmation {
  if (cmd.action === 'purpose') {
    if (receipt.id !== cmd.sourceId || typeof receipt.id !== 'string' || receipt.rev !== (cmd.body.expectedRev ?? 0) + 1 ||
        !validWatermark(receipt.accessEpoch) || !Array.isArray(receipt.purpose) ||
        receipt.purpose.length !== 1 || receipt.purpose[0] !== 'storage') throw new Error();
    return {epoch: cmd.body.expectedEpoch, sources: [
      {id: receipt.id, rev: receipt.rev, accessEpoch: receipt.accessEpoch, purpose: ['storage']},
    ]};
  }
  const epoch = cmd.action === 'sync' ? cmd.body.expectedEpoch : String(BigInt(cmd.body.expectedEpoch) + 1n);
  if (receipt.selectionId !== cmd.body.selectionId || receipt.epoch !== epoch) throw new Error();
  if (cmd.action === 'sync') {
    if (!Array.isArray(receipt.sources) || !receipt.sources.every(r =>
      r && typeof r.id === 'string' && Number.isSafeInteger(r.rev) && r.rev > 0)) throw new Error();
    return {epoch, sources: receipt.sources};
  }
  if (receipt.active !== (cmd.action === 'grant' || !!cmd.body.recipient)) throw new Error();
  return {epoch, sources: []};
}

function GrantForm({settings, submit}: {settings: Settings; submit: (cmd: Command) => void}) {
  const [kind, setKind] = useState<Root['kind']>('page');
  const [id, setId] = useState('');
  const [preset, setPreset] = useState<Preset>('storage');
  const [checked, setChecked] = useState<string[]>([]);
  const option = settings.presets.find(item => item.id === preset);
  const reader = option?.allowedRecipients.find(item => item.id === 'studio:learning-reader' && item.purpose === 'learning');
  const models = option?.allowedRecipients.filter(r => r.purpose === 'teaching') ?? [];
  const recipients = preset === 'learning'
    ? [...(reader ? [reader] : []), ...models.filter(r => checked.includes(r.id))] : [];
  const allowed = settings.configured && option?.available && (preset === 'storage' || preset === 'learning' && recipients.length > 0);
  const root = {kind, id: id.trim()};
  const previous = settings.selections.find(item => sameRoot(item.root, root));
  return <form onSubmit={event => {
    event.preventDefault();
    if (!allowed) return;
    submit({action: 'grant', body: {requestId: requestId(), deletionWatermark: settings.watermark,
      selectionId: previous?.selectionId ?? requestId(), expectedEpoch: previous?.epoch ?? '0', root, preset,
      recipients: recipients.map(({id, purpose}) => ({id, purpose}))}});
  }}>
    <label className="field">来源类型<select value={kind} onChange={event => { setKind(event.target.value as Root['kind']); setChecked([]); }}>
      <option value="page">页面</option><option value="data-source">数据源</option>
    </select></label>
    <label className="field">Notion 来源 ID<input required pattern={idPattern} title="32 位十六进制 ID，可包含 UUID 连字符"
      value={id} onChange={event => { setId(event.target.value.trim()); setChecked([]); }}/></label>
    <fieldset className="notion-presets"><legend>授权用途</legend>{settings.presets.map(item => {
      const usable = item.available && (item.id === 'storage' || item.id === 'learning' &&
        item.allowedRecipients.some(r => r.purpose === 'teaching' || (r.id === 'studio:learning-reader' && r.purpose === 'learning')));
      return <label key={item.id} className="notion-choice"><input type="radio" name="notion-purpose"
        checked={preset === item.id && !!usable} disabled={!usable} onChange={() => { setPreset(item.id); setChecked([]); }}/><span>{purposes[item.id]}</span>
        {item.reason && <small>{item.reason}</small>}</label>;
    })}</fieldset>
    {preset === 'storage' ? <p>接收方 · 仅本人</p> : <>
      {reader && <p>接收方 · {reader.label || reader.id}（学习阅读）</p>}
      {models.length > 0 && <fieldset className="notion-presets"><legend>允许用于教学的模型</legend>
        {models.map(model => <label key={model.id} className="notion-choice"><input type="checkbox"
          checked={checked.includes(model.id)} onChange={e => setChecked(e.target.checked
            ? [...checked, model.id] : checked.filter(id => id !== model.id))}/><span>{model.label || model.id}（教学）</span></label>)}
      </fieldset>}
    </>}
    {previous?.active && <p>更新会用本次所选用途和接收方替换当前授权。</p>}
    <button className="tonal-button" disabled={!allowed || !root.id}>{previous?.active ? '更新授权' : '授权来源'}</button>
  </form>;
}

export function NotionSettings() {
  const [settings, setSettings] = useState<Settings>();
  const [version, setVersion] = useState(0);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<{cmd: Command; basis: string}>();
  const [success, setSuccess] = useState<{config: string; cmd: Command; epoch: string; sources: Selection['sources']}>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  function refresh() { setSettings(undefined); setError(false); setVersion(v => v + 1); }
  useEffect(() => {
    const controller = new AbortController();
    readSettings(controller.signal).then(state => {
      if (!controller.signal.aborted) {
        setSettings(state);
        setPending(previous => previous && commandBasis(state, previous.cmd) === previous.basis ? previous : undefined);
      }
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [version]);
  useEffect(() => {
    const invalidate = () => { setSuccess(undefined); refresh(); };
    const stored = (e: StorageEvent) => { if (e.key === latestKey) invalidate(); };
    const events = ['online', 'offline', 'focus', latestKey];
    events.forEach(name => window.addEventListener(name, invalidate));
    window.addEventListener('storage', stored);
    return () => { events.forEach(name => window.removeEventListener(name, invalidate)); window.removeEventListener('storage', stored); };
  }, []);
  async function submit(cmd: Command) {
    if (lock.current || !settings || !navigator.onLine) return;
    const basis = commandBasis(settings, cmd);
    lock.current = true;
    setBusy(true);
    setNotice('');
    setSuccess(undefined);
    setPending(undefined);
    let sent = false;
    try {
      const current = await readSettings();
      if (commandBasis(current, cmd) !== basis) {
        setNotice('授权或配置已变化，请重新选择。');
        return;
      }
      sent = true;
      const path = cmd.action === 'purpose' ? '/sources/' + cmd.sourceId + '/purpose' : '/selections/' + cmd.action;
      const response = await fetch('/api/notion' + path, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(cmd.body),
      });
      if (!response.ok) throw new ApiError(response.status);
      verifyGenerationReceipt(response, cmd.body.deletionWatermark);
      const confirmation = checkReceipt(cmd, await response.json());
      setSuccess({config: configuration(current), cmd, ...confirmation});
    } catch (e) {
      if (!sent) setNotice('无法复核当前授权，操作未提交。');
      else if (e instanceof ApiError && e.status < 500) {
        setNotice(e.status === 403 ? '读取权限已失效，请核对 Notion 端访问权限及本机授权。' :
          e.status === 409 ? '授权版本或删除水位已变化，请核对最新状态。' : '宿主未接受操作，请核对最新授权状态。');
      } else {
        setNotice('未能确认操作结果。请核对最新授权状态。');
        setPending({cmd, basis});
      }
    } finally {
      refresh();
      lock.current = false;
      setBusy(false);
    }
  }
  const current = settings?.selections.find(s => s.selectionId === success?.cmd.body.selectionId);
  const confirmed = settings && success && current && configuration(settings) === success.config &&
    current.epoch === success.epoch && success.sources.every(ref => current.sources.some(r => r.id === ref.id && r.rev === ref.rev &&
      (!ref.accessEpoch || (r.accessEpoch === ref.accessEpoch && r.purpose?.length === 1 && r.purpose[0] === 'storage'))));
  return <>
    {confirmed && <p role="status">已收到操作回执。</p>}
    {notice && <p role="status">{notice}</p>}
    {error ? <p role="alert">无法读取 Notion 授权状态。 <button onClick={refresh}>重新读取</button></p> :
      !settings ? <p role="status">正在读取 Notion 授权…</p> : <>
        {!settings.configured && <p>宿主尚未配置 Notion 连接。</p>}
        <fieldset className="notion-sources" disabled={busy || !navigator.onLine}>
          <legend>只读来源</legend>
          {pending && commandBasis(settings, pending.cmd) === pending.basis && <button onClick={() => void submit(pending.cmd)}>重试原操作</button>}
          <GrantForm settings={settings} submit={submit}/>
          <h3>已有授权</h3>
          {!settings.selections.length && <p>还没有授权来源。</p>}
          {settings.selections.map(s => <section key={s.selectionId}>
            <strong>{s.label || s.root.id}</strong>
            <p>{s.root.kind === 'page' ? '页面' : '数据源'}{s.label && s.label !== s.root.id && ' · ' + s.root.id} · 授权版本 {s.epoch}</p>
            <p>{s.active ? '本机已授权' : '本机已撤销'} · {purposes[s.preset]}</p>
            {s.active && <><p>接收方 · 本人（保存）</p>
              {s.recipients.map(recipient => {
                const option = settings.presets.find(p => p.id === s.preset)?.allowedRecipients.find(r => sameRecipient(r, recipient));
                const name = option?.label || recipient.label || recipient.id;
                return <div className="notion-recipient" key={JSON.stringify([recipient.id, recipient.purpose])}>
                  <span>{name}（{purposeLabel(recipient.purpose)}）{!option && ' · 当前配置已失效'}</span>
                  <button className="text-button" aria-label={'撤销 ' + name + ' 的' + purposeLabel(recipient.purpose) + '授权'}
                    onClick={() => void submit({action: 'revoke', body: {requestId: requestId(), selectionId: s.selectionId,
                      expectedEpoch: s.epoch, deletionWatermark: settings.watermark, recipient: {id: recipient.id, purpose: recipient.purpose}}})}>撤销此接收方</button>
                </div>;
              })}
              <ul>{s.sources.map(ref => <li key={ref.id}>{ref.id} · 第 {ref.rev} 版
                {ref.purpose && <span> · {ref.purpose.map(purposeLabel).join('、')}</span>}
                {validWatermark(ref.accessEpoch) && ref.purpose?.some(p => p !== 'storage') &&
                  <button className="text-button" aria-label={'将 ' + ref.id + ' 设为仅本人存储'}
                    onClick={() => void submit({action: 'purpose', sourceId: ref.id, body: {
                      requestId: requestId(), selectionId: s.selectionId, expectedEpoch: s.epoch,
                      deletionWatermark: settings.watermark, expectedRev: ref.rev, accessEpoch: ref.accessEpoch!, preset: 'storage',
                    }})}>仅本人存储</button>}
              </li>)}</ul>
              {(['sync', 'revoke'] as const).map(action => <button key={action} className="text-button"
                disabled={action === 'sync' && !settings.configured}
                onClick={() => void submit({action, body: {requestId: requestId(), deletionWatermark: settings.watermark,
                  selectionId: s.selectionId, expectedEpoch: s.epoch}})}>{action === 'sync' ? '同步来源' : '撤销授权'}</button>)}</>}
          </section>)}
        </fieldset>
      </>}
  </>;
}
