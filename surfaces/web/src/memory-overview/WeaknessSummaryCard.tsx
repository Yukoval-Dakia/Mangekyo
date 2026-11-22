import { useRef, useState } from 'react';
import { api, ApiError, requestId, type Settings } from '../api';
import { chatRoute } from '../model-route';
import { rememberRoom, rejected, roomPath, writeRoom, type ClassroomWrite } from '../classroom-contract';
import type {
  PriorityConceptSummary,
  TopErrorStageSummary,
  WeaknessAndErrorSummaryView,
  WeaknessEvidenceRef,
} from './types';

export type WeaknessSummaryCardProps = {
  summary: WeaknessAndErrorSummaryView;
  settings?: Settings | undefined;
  onNavigate?: ((href: string) => void) | undefined;
};

type ActionState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'error'; message: string }
  | { status: 'empty'; message: string };

function navigateTo(onNavigate: ((href: string) => void) | undefined, href: string) {
  if (onNavigate) onNavigate(href);
  else location.assign(href);
}

function evidenceLabel(ref: WeaknessEvidenceRef, index: number): string {
  const short = ref.id.length > 10 ? `…${ref.id.slice(-6)}` : ref.id;
  return `记录 ${index + 1} · ${short} · v${ref.rev}`;
}

function EvidenceDetails({ refs }: { refs: readonly WeaknessEvidenceRef[] }) {
  const [open, setOpen] = useState(false);
  if (!refs.length) return null;
  return (
    <div className="weak-evidence">
      <button
        type="button"
        className="memory-basis-toggle weak-evidence-toggle"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {open ? '收起依据' : `查看依据（${refs.length} 条）`}
      </button>
      {open && (
        <ul className="memory-basis-list weak-evidence-list">
          {refs.map((ref, index) => (
            <li key={`${ref.id}:${ref.rev}:${ref.itemId ?? index}`}>
              {ref.href ? (
                <a className="text-button weak-evidence-link" href={ref.href}>
                  {evidenceLabel(ref, index)}
                </a>
              ) : (
                <strong>{evidenceLabel(ref, index)}</strong>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function classroomTopic(item: PriorityConceptSummary): string {
  const reason = item.reason.trim();
  const topic = `围绕「${item.title}」上一节 10 分钟微课，重点解决：${reason || '近期练习中的易错环节'}`;
  return topic.length > 280 ? `${topic.slice(0, 279)}…` : topic;
}

function parseQuickPaper(result: unknown): { kind: 'paper'; paperId: string; href?: string } | { kind: 'empty'; message: string } {
  if (!result || typeof result !== 'object') throw new Error('抽题响应格式无法识别。');
  const record = result as Record<string, unknown>;
  if (record.kind === 'empty') {
    const reason = typeof record.reason === 'string' && record.reason.trim()
      ? record.reason
      : typeof record.message === 'string' && record.message.trim()
        ? record.message
        : '该知识点暂时还没有可自测的题目。';
    return { kind: 'empty', message: reason };
  }
  const nested = record.paper && typeof record.paper === 'object'
    ? (record.paper as Record<string, unknown>).id
    : undefined;
  const paperId = record.paperId ?? nested ?? record.id;
  if (typeof paperId === 'string' && paperId.trim()) {
    const href = typeof record.href === 'string' && record.href.trim() ? record.href : undefined;
    return { kind: 'paper', paperId, ...(href ? { href } : {}) };
  }
  throw new Error('抽题响应未包含试卷标识。');
}

export function WeaknessSummaryCard({ summary, settings, onNavigate }: WeaknessSummaryCardProps) {
  const [actions, setActions] = useState<Record<string, ActionState>>({});
  const pendingRef = useRef(new Set<string>());

  const setAction = (key: string, state: ActionState) =>
    setActions(prev => ({ ...prev, [key]: state }));

  async function startClassroom(item: PriorityConceptSummary, displayKey?: string) {
    const key = `classroom:${item.conceptId}`;
    const echo = displayKey ?? key;
    if (pendingRef.current.has(key)) return;
    const route = settings && chatRoute(settings, 'companion');
    if (!route) {
      navigateTo(onNavigate, '/me?section=models');
      return;
    }
    pendingRef.current.add(key);
    setAction(echo, { status: 'busy' });
    const operation: ClassroomWrite = {
      path: '/classrooms',
      body: { requestId: requestId(), topic: classroomTopic(item), minutes: 10, route },
    };
    try {
      const room = await writeRoom(operation);
      rememberRoom(room.id);
      pendingRef.current.delete(key);
      navigateTo(onNavigate, roomPath(room.id));
    } catch (failure) {
      pendingRef.current.delete(key);
      const message = failure instanceof ApiError
        ? rejected(failure)
          ? failure.message
          : '尚未收到开课回执，可稍后重试。'
        : '暂时无法开课，请稍后重试。';
      setAction(echo, { status: 'error', message });
    }
  }

  async function quickPaper(item: PriorityConceptSummary) {
    const key = `paper:${item.conceptId}`;
    if (pendingRef.current.has(key)) return;
    pendingRef.current.add(key);
    setAction(key, { status: 'busy' });
    try {
      const result = await api<unknown>(
        `/knowledge/graph/${encodeURIComponent(item.conceptId)}/quick-paper`,
        { method: 'POST', body: { requestId: requestId() } },
      );
      const parsed = parseQuickPaper(result);
      pendingRef.current.delete(key);
      if (parsed.kind === 'paper') {
        navigateTo(onNavigate, parsed.href ?? `/papers/${encodeURIComponent(parsed.paperId)}`);
      } else {
        setAction(key, { status: 'empty', message: parsed.message });
      }
    } catch (failure) {
      pendingRef.current.delete(key);
      if (failure instanceof ApiError && failure.status === 404) {
        setAction(key, { status: 'empty', message: '该知识点暂时还没有可自测的题目。' });
      } else {
        setAction(key, {
          status: 'error',
          message: failure instanceof Error ? failure.message : '抽题暂时失败，请稍后重试。',
        });
      }
    }
  }

  function reviewMistake(item: PriorityConceptSummary) {
    const href = item.evidenceRefs.find(ref => ref.href)?.href;
    navigateTo(onNavigate, href ?? '/materials?tab=bank');
  }

  function runAction(item: PriorityConceptSummary) {
    if (item.nextAction === 'review_mistake') reviewMistake(item);
    else if (item.nextAction === 'quick_paper') void quickPaper(item);
    else void startClassroom(item);
  }

  if (summary.status === 'insufficient_evidence') {
    const progress = summary.neededCount > 0 ? Math.min(1, summary.sampleCount / summary.neededCount) : 0;
    return (
      <section className="weak-card" aria-labelledby="weak-card-title">
        <div className="weak-card-head">
          <h3 id="weak-card-title">错因画像与薄弱建议</h3>
          <p className="weak-summary">{summary.summary}</p>
        </div>
        <div className="weak-progress" role="group" aria-label="样本积累进度">
          <div className="weak-progress-track" aria-hidden="true">
            <div className="weak-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="weak-progress-text">
            已积累 {summary.sampleCount} / {summary.neededCount} 条独立记录
          </p>
        </div>
        <div className="weak-inline-actions">
          <button type="button" className="primary-button weak-action-btn" onClick={() => navigateTo(onNavigate, '/today')}>
            去今天开始练习
          </button>
          <button type="button" className="tonal-button weak-action-btn" onClick={() => navigateTo(onNavigate, '/intake')}>
            + 交入错题
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="weak-card" aria-labelledby="weak-card-title">
      <div className="weak-card-head">
        <h3 id="weak-card-title">错因画像与薄弱建议</h3>
        <p className="weak-summary">{summary.summary}</p>
        <p className="weak-meta">基于 {summary.sampleCount} 条独立记录</p>
      </div>

      {summary.topErrorStages.length > 0 && (
        <div className="weak-block">
          <h4 className="weak-block-title">高频卡点环节</h4>
          <ul className="weak-stage-list">
            {summary.topErrorStages.map((stage: TopErrorStageSummary) => (
              <li key={stage.stage} className="weak-stage-item">
                <div className="weak-stage-head">
                  <strong>{stage.label}</strong>
                  <span className="weak-count-chip">{stage.count} 次</span>
                </div>
                <p className="weak-advice">{stage.advice}</p>
                <EvidenceDetails refs={stage.evidenceRefs} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.priorityConcepts.length > 0 && (
        <div className="weak-block">
          <h4 className="weak-block-title">优先巩固概念</h4>
          <ul className="weak-concept-list">
            {summary.priorityConcepts.map(item => {
              const actionKey = item.nextAction === 'review_mistake'
                ? `review:${item.conceptId}`
                : item.nextAction === 'quick_paper'
                  ? `paper:${item.conceptId}`
                  : `classroom:${item.conceptId}`;
              const state = actions[actionKey];
              const busy = state?.status === 'busy';
              const actionLabel = item.nextAction === 'review_mistake'
                ? '去订正'
                : item.nextAction === 'quick_paper'
                  ? busy ? '正在抽题…' : '抽题自测'
                  : busy ? '正在开课…' : '开 10 分钟微课';
              return (
                <li key={item.conceptId} className="weak-concept-item">
                  <div className="weak-concept-head">
                    <strong className="weak-concept-title">{item.title}</strong>
                    <span className={`weak-status ${item.status === 'weak' ? 'is-weak' : 'is-fading'}`}>
                      {item.status === 'weak' ? '薄弱' : '待固'}
                    </span>
                  </div>
                  <div className="weak-concept-badges">
                    {item.uncorrectedErrorCount > 0 && (
                      <span className="weak-count-chip is-warn">{item.uncorrectedErrorCount} 道待订正</span>
                    )}
                    {item.retrievability !== null && (
                      <span className="weak-retrievability">保持度约 {Math.round(item.retrievability * 100)}%</span>
                    )}
                  </div>
                  <p className="weak-reason">{item.reason}</p>
                  <EvidenceDetails refs={item.evidenceRefs} />
                  <div className="weak-concept-actions">
                    <button
                      type="button"
                      className="primary-button weak-action-btn"
                      disabled={busy}
                      onClick={() => runAction(item)}
                    >
                      {actionLabel}
                    </button>
                  </div>
                  {state?.status === 'error' && (
                    <p className="weak-feedback error" role="alert">{state.message}</p>
                  )}
                  {state?.status === 'empty' && (
                    <div className="weak-feedback">
                      <p className="weak-feedback-text">{state.message}</p>
                      <div className="weak-inline-actions">
                        <button
                          type="button"
                          className="tonal-button weak-action-btn"
                          onClick={() => void startClassroom(item, actionKey)}
                        >
                          开 10 分钟微课
                        </button>
                        <button
                          type="button"
                          className="text-button weak-action-btn"
                          onClick={() => navigateTo(onNavigate, '/materials?tab=graph')}
                        >
                          去图谱查看
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
