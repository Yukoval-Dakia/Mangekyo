import type { AssessmentRelease } from '../../../modules/activity/assessment-values';
import type { WorkbookSourceQuestionRef } from '../../../modules/activity/workbook-values';
import { isRecord } from '../../shared/presentation/schema';
import { validateArtifact } from '../../shared/presentation';
import { ArtifactView } from './presentation/ArtifactView';
import { fixedLink } from './concept-reading';
import { Message } from './message';

export type BankQuestion = {
  id: string;
  kind: 'bank';
  prompt: string;
  selfCheck: false;
  sourceQuestionRef: WorkbookSourceQuestionRef;
  responseSchema: AssessmentRelease['items'][number]['slots'];
  interaction?: unknown;
  sharedMaterials: readonly unknown[];
};

function fields(question: BankQuestion) {
  return question.responseSchema.flatMap(slot => slot.fields.map(field => ({...field, slotId: slot.slotId})));
}

type Input = {slotId: string; path: string; value: {kind: string; value: string | number | Selection; unit?: string | null}};

type Selection = {kind: 'selection'; ids: string[]};
type Choice = {id: string; label: string};
type SelectionControl = Choice & {kind: 'selection'; items: Choice[]; tail: string};

function choice(value: unknown): value is Choice {
  return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string';
}
function selectionControls(interaction: unknown): SelectionControl[] {
  if (!isRecord(interaction) || !Array.isArray(interaction.controls)) return [];
  return interaction.controls.filter((node): node is SelectionControl =>
    isRecord(node) && node.kind === 'selection' && typeof node.id === 'string' && typeof node.label === 'string' &&
    typeof node.tail === 'string' && Array.isArray(node.items) && node.items.every(choice));
}
function selectedIds(value: unknown): string[] {
  return isRecord(value) && value.kind === 'selection' && Array.isArray(value.ids)
    ? value.ids.filter((id): id is string => typeof id === 'string') : [];
}

function singleText(question: BankQuestion) {
  const all = fields(question);
  return all.length === 1 && all[0]?.kind === 'text' && all[0].path === '';
}

function entries(raw: string): Input[] {
  if (!raw) return [];
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || !values.every(row => row && typeof row.slotId === 'string' &&
    typeof row.path === 'string' && row.value && typeof row.value.kind === 'string'))
    throw new Error('当前草稿无法匹配题目的作答位。');
  return values;
}

export function bankSubmission(question: BankQuestion, raw: string) {
  if (!raw || singleText(question)) return raw.trim() || null;
  const values = entries(raw).map(row => {
    if (row.value.kind !== 'numeric') return row;
    const number = Number(row.value.value);
    if (!String(row.value.value).trim() || !Number.isFinite(number)) throw new Error(row.slotId + ' 需要填写有效数字。');
    return {...row, value: {kind: 'numeric', value: number, unit: row.value.unit?.trim() || null}};
  });
  return values.length ? JSON.stringify(values) : null;
}

export function BankOrigin({source}: {source: WorkbookSourceQuestionRef}) {
  const href = fixedLink({v: 1, fact: {...source, type: 'content.asset'}, anchor: {kind: 'question', itemId: 'question'}});
  return <a href={href}>回看原题第 {source.rev} 版</a>;
}

export function BankAttachment({question, paperId}: {question: Pick<BankQuestion, 'id' | 'sharedMaterials' | 'interaction'>; paperId?: string}) {
  const projected = isRecord(question.interaction) && Array.isArray(question.interaction.controls);
  const artifact = question.interaction && !projected ? validateArtifact(question.interaction) : undefined;
  return <>
    {artifact?.ok && paperId ? <>
      <ArtifactView view={artifact.view} mount={{mountId: paperId + '-' + question.id, stateRev: 0}}
        unavailable={Object.fromEntries(artifact.view.sections.flatMap(section => section.nodes)
          .filter(node => node.kind === 'action').map(node => [node.id, '这份卷面尚未提供动作与正式作答位的绑定。']))}
        onAction={() => {}}/>
      <p className="field-help">可在上方试操作。交卷以作答栏中填写的内容为准。</p>
    </> : artifact?.ok ? <aside>
      <h3>{artifact.view.title}</h3><p>{artifact.view.fallback}</p>
      {artifact.view.sections.flatMap(section => section.nodes).map(node => node.kind === 'selection' &&
        <div key={node.id}><strong>{node.label}</strong><ul>{node.items.map(item => <li key={item.id}>{item.label}</li>)}</ul></div>)}
    </aside> : null}
    {projected && !paperId && selectionControls(question.interaction).map(control =>
      <p key={control.id}><strong>{control.label}</strong>　{control.items.map(item => item.label).join('　')}{control.tail}</p>)}
    {question.interaction != null && !projected && !artifact?.ok && <p role="status">互动题面暂时无法读取。</p>}
    {question.sharedMaterials?.map((material, index) => <aside key={index}>
      {isRecord(material) && Array.isArray(material.pieces) ? material.pieces.map((piece, i) =>
        isRecord(piece) && typeof piece.text === 'string' && <Message key={i} text={piece.text}/>)
        : <p>引用材料暂缺可展示的授权正文。</p>}
    </aside>)}
  </>;
}

export function BankFields({question, raw, disabled, change}: {
  question: BankQuestion; raw: string; disabled: boolean; change: (value: string) => void;
}) {
  if (singleText(question)) return <label className="field">文字作答<textarea value={raw} disabled={disabled}
    onChange={e => change(e.target.value)} /></label>;
  let rows: Input[];
  try { rows = entries(raw); }
  catch { return <div role="alert">旧草稿格式无法读取。<button type="button" onClick={() => change('')}>清空本题作答</button></div>; }
  return <>{fields(question).map(({slotId, path, kind}) => {
    const label = slotId + path;
    const row = rows.find(item => item.slotId === slotId && item.path === path);
    const answer = String(row?.value.value ?? '');
    const unit = row?.value.unit ?? '';
    function update(value: string | Selection, nextUnit: string) {
      const next = rows.filter(item => item.slotId !== slotId || item.path !== path);
      if (value || nextUnit) next.push({slotId, path, value: {kind, value, ...(kind === 'numeric' ? {unit: nextUnit || null} : {})}});
      change(next.length ? JSON.stringify(next) : '');
    }
    const control = kind === 'structured' && path === '' && selectionControls(question.interaction).find(node => node.id === slotId);
    if (control) {
      const ids = selectedIds(row?.value.value);
      return <fieldset key={slotId} disabled={disabled}>
        <legend>{control.label}</legend>
        {control.items.map(item => <label key={item.id}>
          <input type="checkbox" checked={ids.includes(item.id)} onChange={e =>
            update({kind: 'selection', ids: e.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id)}, '')}/>
          {item.label}
        </label>)}{control.tail}
      </fieldset>;
    }
    return <div key={JSON.stringify([slotId,path])}>
      {kind === 'text' || kind === 'numeric' ? <>
        <label className="field">{label} · {kind === 'numeric' ? '数值' : '文字'}
          <input value={answer} disabled={disabled} inputMode={kind === 'numeric' ? 'decimal' : 'text'}
            onChange={e => update(e.target.value, unit)}/>
        </label>
        {kind === 'numeric' && <label className="field">{label} · 单位（可选）
          <input disabled={disabled} value={unit} onChange={e => update(answer, e.target.value)}/>
        </label>}
      </> : <p role="status">{label} 需要{kind === 'structured' ? '结构化字段定义' : '获准的作品或过程记录选择器'}，当前卷面尚未提供。</p>}
    </div>;
  })}</>;
}

export function BankFeedback({question, answer}: {question: BankQuestion; answer: string}) {
  if (singleText(question)) return <Message text={answer}/>;
  const controls = selectionControls(question.interaction);
  try {
    return <dl>{entries(answer).map(({slotId, path, value}) => {
      const control = controls.find(node => node.id === slotId);
      const display = typeof value.value === 'object'
        ? selectedIds(value.value).map(id => control?.items.find(item => item.id === id)?.label ?? id).join('、') || '未选择'
        : String(value.value);
      return <div key={JSON.stringify([slotId, path])}>
        <dt>{control?.label ?? slotId}{path}</dt><dd>{display} {value.unit}</dd>
      </div>;
    })}</dl>;
  } catch { return <p>这次记录使用旧作答格式。</p>; }
}
