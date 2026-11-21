import { useRef, useState, type FormEvent } from 'react';
import { api, submissionId } from './api';

export function SealedPracticeAuthor() {
  const [generated, setGenerated] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const last = useRef<{key:string; requestId:string} | undefined>(undefined);
  async function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const operands = generated
      ? {generate: true}
      : {left: Number(form.get('left')), right: Number(form.get('right'))};
    const definition = {operation: form.get('operation'), allowTeaching: form.get('allowTeaching') === 'on', ...operands};
    const key = JSON.stringify(definition);
    const requestId = last.current?.key === key ? last.current.requestId : submissionId();
    last.current = {key,requestId};
    setError('');
    setBusy(true);
    try {
      const paper = await api<{path:string}>('/papers/sealed-practice',{method:'POST',body:{...definition,requestId}});
      location.assign(paper.path);
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法打开整数练习，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="workbook-editor-block">
      <summary>新建整数练习</summary>
      <form className="workbook-editor" onSubmit={(event) => void open(event)}>
        <div className="workbook-fields">
          <label className="field"><span>出题方式</span>
            <select value={generated ? 'generated' : 'manual'} disabled={busy}
              onChange={event => setGenerated(event.currentTarget.value === 'generated')}>
              <option value="manual">自己填数</option>
              <option value="generated">随机生成新题</option>
            </select>
          </label>
          {!generated && <label className="field"><span>第一个整数</span><input required type="number" name="left" min={1} max={999} disabled={busy} /></label>}
          <label className="field"><span>运算</span><select name="operation" disabled={busy}>
            <option value="add">加</option><option value="subtract">减</option><option value="multiply">乘</option>
          </select></label>
          {!generated && <label className="field"><span>第二个整数</span><input required type="number" name="right" min={1} max={999} disabled={busy} /></label>}
        </div>
        <label><input type="checkbox" name="allowTeaching" disabled={busy} /> 允许伴学使用新题的题面</label>
        <p className="field-help">已有练习会沿用原权限，可在试卷内修改。</p>
        <div><button className="tonal-button" disabled={busy}>{busy ? '正在打开…' : '保存并开练'}</button></div>
        {error && <p role="alert">{error}</p>}
      </form>
    </details>
  );
}
