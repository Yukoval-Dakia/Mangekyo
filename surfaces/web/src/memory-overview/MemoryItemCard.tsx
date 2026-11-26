import { useState, type FormEvent } from 'react';
import { formatShortDateTime } from '../shared/format-time';
import type {
  MemoryActionRequest,
  MemoryBasisEntry,
  MemoryItem,
} from './types';

const categoryLabel: Record<string, string> = {
  preference: '学习偏好',
  claim: '长期断言',
  state: '短期状态',
  refusal: '明确拒绝',
};

const kindLabel: Record<string, string> = {
  preference: '学习偏好',
  claim: '长期断言',
  state: '短期状态',
  refusal: '明确拒绝',
  directive: '始终生效',
  observation: '观察记录',
  learning: '学习理解',
};

const statusLabel: Record<string, string> = {
  tentative: '待验证',
  'learner-corrected': '你已经更正',
  confirmed: '已证实',
  active: '生效中',
  forgotten: '已撤回',
  unknown: '暂无状态',
};

const reviewLabel: Record<string, string> = {
  supported: '对账支持',
  contradicted: '对账矛盾',
  unresolved: '对账未决',
  unknown: '对账未知',
};

function labelOf(key: string | undefined | null, map: Record<string, string>): string {
  if (!key) return '未分类';
  return map[key] ?? key;
}

function basisTitle(entry: MemoryBasisEntry): string {
  switch (entry.kind) {
    case 'turn-quote': return '来自对话原话';
    case 'scope-object': return entry.type ? `学习材料 · ${entry.type}` : '学习材料';
    case 'activity-citation': return entry.anchor ? `作答片段 · ${entry.anchor}` : '作答片段';
    case 'learner-declaration': return '你的主动声明';
    default: return '来源见证';
  }
}

function basisDetail(entry: MemoryBasisEntry): string {
  if (entry.kind === 'turn-quote' || entry.kind === 'activity-citation') return entry.excerpt || '';
  if (entry.kind === 'scope-object') return entry.type || '';
  return '';
}

export function MemoryItemCard({
  item,
  onRunAction,
}: {
  item: MemoryItem;
  onRunAction?: (request: MemoryActionRequest) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<'forget' | 'undo' | null>(null);
  const [pending, setPending] = useState<'correct' | 'forget' | 'undo' | null>(null);
  const [text, setText] = useState(item.text);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const { actions } = item;
  const canEdit = !!actions.correct && !!onRunAction;
  const canForget = !!actions.forget && !!onRunAction;
  const canUndo = !!actions.undo && !!onRunAction;
  const hasAnyAction = canEdit || canForget || canUndo;

  async function run(kind: 'correct' | 'forget' | 'undo') {
    if (!onRunAction) return;
    const spec = kind === 'correct' ? actions.correct : kind === 'forget' ? actions.forget : actions.undo;
    if (!spec) return;
    setPending(kind);
    setFeedback(null);
    try {
      await onRunAction({ item, kind, spec, ...(kind === 'correct' ? { text } : {}) });
      if (kind === 'correct') {
        setEditing(false);
        setFeedback({ tone: 'ok', text: '已保存修改。' });
      } else {
        setConfirming(null);
        setFeedback({
          tone: 'ok',
          text: kind === 'forget' ? '已让系统忘记这条记忆。' : '已撤回这条记录。',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作未完成。';
      setFeedback({ tone: 'error', text: message });
    } finally {
      setPending(null);
    }
  }

  function submitEdit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    void run('correct');
  }

  const chipLabel = item.section === 'directive'
    ? (item.authority === 'directive' ? '始终生效' : labelOf(item.category, categoryLabel))
    : labelOf(item.kind, kindLabel);
  const stateLabel = item.section === 'directive'
    ? (item.expired ? '已过期' : item.sticky ? '粘性' : '生效中')
    : item.review && item.review !== 'unknown'
      ? labelOf(item.review, reviewLabel)
      : labelOf(item.status, statusLabel);

  return (
    <article className={`memory-item-card ${item.section === 'directive' ? 'is-directive' : 'is-hypothesis'}`}>
      <div className="memory-item-head">
        <span className="memory-chip">{chipLabel}</span>
        <span className={`memory-state ${item.section === 'directive' ? 'is-sticky' : ''}`}>
          {stateLabel}
        </span>
      </div>

      {editing ? (
        <form onSubmit={submitEdit} className="memory-edit-form">
          <label>
            修改这条记忆
            <textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} />
          </label>
          <div className="memory-item-actions">
            <button type="submit" className="primary-button" disabled={!!pending}>
              {pending === 'correct' ? '保存中…' : '保存修改'}
            </button>
            <button
              type="button"
              className="tonal-button"
              disabled={!!pending}
              onClick={() => {
                setEditing(false);
                setText(item.text);
                setFeedback(null);
              }}
            >
              取消
            </button>
          </div>
        </form>
      ) : (
        <p className="memory-text">{item.text}</p>
      )}

      {item.section === 'directive' && item.validUntil && (
        <p className="memory-meta">
          {item.expired ? '已于 ' : '有效期至 '}
          {formatShortDateTime(item.validUntil)}
        </p>
      )}
      {item.section === 'hypothesis' && item.ttl && (
        <p className="memory-meta">有效期至 {formatShortDateTime(item.ttl)}</p>
      )}

      <div className="memory-basis">
        <button
          type="button"
          className="memory-basis-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起依据' : `查看依据（${item.basis.length}）`}
        </button>
        {expanded && (
          <ul className="memory-basis-list">
            {item.basis.length ? (
              item.basis.map((entry, index) => (
                <li key={index}>
                  <strong>{basisTitle(entry)}</strong>
                  {basisDetail(entry) && <span>{basisDetail(entry)}</span>}
                </li>
              ))
            ) : (
              <li className="memory-empty">暂无引用依据</li>
            )}
          </ul>
        )}
      </div>

      {hasAnyAction && !editing && !confirming && (
        <div className="memory-item-actions">
          {canEdit && (
            <button type="button" className="tonal-button" disabled={!!pending} onClick={() => setEditing(true)}>
              修改
            </button>
          )}
          {canForget && (
            <button
              type="button"
              className="text-button danger"
              disabled={!!pending}
              onClick={() => setConfirming('forget')}
            >
              忘记
            </button>
          )}
          {canUndo && (
            <button
              type="button"
              className="text-button danger"
              disabled={!!pending}
              onClick={() => setConfirming('undo')}
            >
              撤回记录
            </button>
          )}
        </div>
      )}

      {confirming && (
        <div className="memory-confirm">
          <p>
            {confirming === 'forget'
              ? '让系统忘记后，这条记忆将不再影响后续理解。'
              : '撤回后，这条记录将被标记为已撤销，但删除痕迹仍可审计。'}
          </p>
          <div className="memory-item-actions">
            <button
              type="button"
              className="primary-button danger"
              disabled={!!pending}
              onClick={() => void run(confirming)}
            >
              {pending === confirming
                ? confirming === 'forget' ? '忘记中…' : '撤回中…'
                : confirming === 'forget' ? '确认忘记' : '确认撤回'}
            </button>
            <button
              type="button"
              className="tonal-button"
              disabled={!!pending}
              onClick={() => setConfirming(null)}
            >
              再想想
            </button>
          </div>
        </div>
      )}

      {feedback && <p className={`memory-feedback ${feedback.tone}`}>{feedback.text}</p>}
    </article>
  );
}
