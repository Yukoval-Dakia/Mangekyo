import { useState, type FormEvent } from 'react';
import type { MemoryItem, MemoryItemInput } from './types';

const kindLabel: Record<string, string> = {
  preference: '学习偏好',
  claim: '长期断言',
  state: '短期状态',
  refusal: '明确拒绝',
  directive: '始终生效',
  hypothesis: '学习理解',
};

const statusLabel: Record<string, string> = {
  confirmed: '已证实',
  tentative: '待验证',
  forgotten: '已撤回',
  unknown: '暂无状态',
  active: '生效中',
};

function labelOf(key: string, map: Record<string, string>) {
  return map[key] ?? key;
}

function formatTime(value: string | undefined | null) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function basisTitle(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '来源见证';
  const record = value as Record<string, unknown>;
  const title = record.title ?? record.label ?? record.id ?? record.factId ?? record.source ?? '来源见证';
  return typeof title === 'string' ? title : '来源见证';
}

function basisDetail(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const occurredAt = typeof record.occurredAt === 'string' ? record.occurredAt : null;
  const excerpt = typeof record.excerpt === 'string' ? record.excerpt : typeof record.text === 'string' ? record.text : '';
  return [formatTime(occurredAt), excerpt].filter(Boolean).join(' · ');
}

function readText(item: MemoryItem) {
  return 'summary' in item ? item.summary : item.text;
}

export function MemoryItemCard({
  item,
  onUpdateItem,
  onWithdrawItem,
}: {
  item: MemoryItem;
  onUpdateItem?: (input: MemoryItemInput) => Promise<void>;
  onWithdrawItem?: (input: MemoryItemInput) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<'save' | 'withdraw' | null>(null);
  const [text, setText] = useState(readText(item));
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const canEdit = item.actions.some((action) => action === 'correct' || action === 'update');
  const canWithdraw = item.actions.some((action) => action === 'forget' || action === 'undo' || action === 'withdraw');

  async function run(kind: 'save' | 'withdraw') {
    setPending(kind);
    setFeedback(null);
    try {
      if (kind === 'save') {
        if (!onUpdateItem) throw new Error('当前上下文不支持修改。');
        await onUpdateItem({ item, text });
        setEditing(false);
        setFeedback({ tone: 'ok', text: '已保存修改。' });
      } else {
        if (!onWithdrawItem) throw new Error('当前上下文不支持撤回。');
        await onWithdrawItem({ item });
        setConfirming(false);
        setFeedback({ tone: 'ok', text: '已撤回这条记忆。' });
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
    void run('save');
  }

  return (
    <article className={`memory-item-card ${item.section === 'directive' ? 'is-directive' : 'is-hypothesis'}`}>
      <div className="memory-item-head">
        <span className="memory-chip">{labelOf(item.kind, kindLabel)}</span>
        <span className={`memory-state ${item.section === 'directive' ? 'is-sticky' : ''}`}>
          {item.section === 'directive' ? '始终生效' : labelOf(item.status ?? 'unknown', statusLabel)}
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
              {pending === 'save' ? '保存中…' : '保存修改'}
            </button>
            <button type="button" className="tonal-button" disabled={!!pending} onClick={() => { setEditing(false); setText(readText(item)); setFeedback(null); }}>
              取消
            </button>
          </div>
        </form>
      ) : (
        <p className="memory-text">{readText(item)}</p>
      )}
      <div className="memory-meta">
        <span>版本 {item.rev}</span>
      </div>
      <div className="memory-basis">
        <button type="button" className="memory-basis-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
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
      {(canEdit || canWithdraw) && !editing && (
        <div className="memory-item-actions">
          {canEdit && (
            <button type="button" className="tonal-button" disabled={!!pending} onClick={() => setEditing(true)}>
              修改
            </button>
          )}
          {canWithdraw && (
            <button type="button" className="text-button danger" disabled={!!pending} onClick={() => setConfirming(true)}>
              撤回/忘记
            </button>
          )}
        </div>
      )}
      {confirming && (
        <div className="memory-confirm">
          <p>撤回后，这条记忆将不再影响后续理解。</p>
          <div className="memory-item-actions">
            <button type="button" className="primary-button danger" disabled={!!pending} onClick={() => void run('withdraw')}>
              {pending === 'withdraw' ? '撤回中…' : '确认撤回'}
            </button>
            <button type="button" className="tonal-button" disabled={!!pending} onClick={() => setConfirming(false)}>
              再想想
            </button>
          </div>
        </div>
      )}
      {feedback && <p className={`memory-feedback ${feedback.tone}`}>{feedback.text}</p>}
    </article>
  );
}
