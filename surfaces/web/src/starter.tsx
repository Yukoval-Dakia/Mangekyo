import { useEffect, useRef, useState, type FormEvent } from 'react';
import { averageSpeed, ridingLesson } from '../../../modules/activity/starter.ts';
import type { PracticeAnswers, PracticeView } from '../../../modules/activity/practice-values.ts';
import { enqueue } from './offline-queue';
import { deletedSubmission, api, ApiError, remember, remembered, submissionId } from './api';
import './starter.css';

const practicePath = '/practice/riding';
const materialPath = '/materials/riding';
const companionPath = '/companion?context=riding';
const rateUnit = '公里/小时';
const displayRate = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

export function StarterLesson() {
  const { title, distanceKm, movingMinutes, stoppedMinutes, comparisonMinutes } = ridingLesson;
  const [stopped, setStopped] = useState<number>(stoppedMinutes);
  const elapsed = movingMinutes + stopped;
  const originalElapsed = movingMinutes + stoppedMinutes;
  const movingRate = averageSpeed(distanceKm, movingMinutes);
  const elapsedRate = averageSpeed(distanceKm, elapsed);
  const maxStopped = comparisonMinutes * 2;
  const axisMinutes = movingMinutes + maxStopped;
  const movingWidth = (movingMinutes / axisMinutes) * 100;
  const stoppedWidth = (stopped / axisMinutes) * 100;

  return (
    <article className="starter">
      <header className="starter-heading">
        <h1>{title}</h1>
        <p>走了 {distanceKm} 公里，移动 {movingMinutes} 分钟，中途停了 {stoppedMinutes} 分钟。为什么两块码表分别显示 {movingRate} 和 {averageSpeed(distanceKm, originalElapsed)} {rateUnit}？</p>
      </header>

      <div className="starter-lesson-grid">
        <section className="starter-lab" aria-labelledby="starter-lab-title">
          <div className="starter-lab-heading">
            <h2 id="starter-lab-title">拉长停车时间</h2>
            <p>路程和移动时间固定。先想一想，哪块码表的读数会变？</p>
          </div>

          <figure className="starter-graph">
            <figcaption>速度（{rateUnit}）</figcaption>
            <div className="starter-plot" role="img" aria-label={`等效速度—时间图。前 ${movingMinutes} 分钟速度为 ${movingRate} ${rateUnit}，随后 ${stopped} 分钟速度为零。`}>
              <div className="starter-plot-labels" aria-hidden="true">
                <span>{movingRate}</span>
                <span>0</span>
              </div>
              <div className="starter-trace" aria-hidden="true">
                <div className="starter-motion" style={{ width: `${movingWidth}%` }} />
                {stopped > 0 && <div className="starter-stop" style={{ width: `${stoppedWidth}%` }} />}
                <span className="starter-first-tick">0</span>
                <span className="starter-divider-tick" style={{ left: `${movingWidth}%` }}>{movingMinutes}</span>
                <span className="starter-last-tick">{axisMinutes}</span>
              </div>
            </div>
            <p className="starter-time-axis">时间（分钟）</p>
            <p className="starter-graph-note">把移动画成一段等效匀速，把停车画在末尾。图下绿色矩形的面积一直代表 {distanceKm} 公里。</p>
          </figure>

          <div className="starter-range">
            <label htmlFor="starter-stop-time">停车时间 <strong>{stopped} 分钟</strong></label>
            <input id="starter-stop-time" type="range" min="0" max={maxStopped} step="1" value={stopped}
              aria-valuetext={`${stopped} 分钟`}
              onChange={(event) => setStopped(event.currentTarget.valueAsNumber)} />
            <p className="starter-mobile-readings" aria-live="polite">
              <span>移动 <strong>{displayRate.format(movingRate)}</strong></span>
              <span>全程 <strong>{displayRate.format(elapsedRate)}</strong></span>
              <span>{rateUnit}</span>
            </p>
            <div className="starter-range-actions">
              <button type="button" className="text-button" onClick={() => setStopped(comparisonMinutes)}>试停 {comparisonMinutes} 分钟</button>
              <button type="button" className="text-button" onClick={() => setStopped(stoppedMinutes)}>恢复原始记录</button>
            </div>
          </div>
        </section>

        <section className="starter-readings" aria-labelledby="starter-readings-title">
          <h2 id="starter-readings-title">两块码表的分母</h2>
          <p>平均速度＝路程 ÷ 时间。路程以公里计，时间要换成小时。</p>
          <dl aria-live="polite">
            <div>
              <dt>只计移动</dt>
              <dd><strong>{displayRate.format(movingRate)}</strong> {rateUnit}</dd>
              <dd className="starter-equation">{distanceKm} ÷ ({movingMinutes} ÷ 60)　·　只计 {movingMinutes} 分钟</dd>
            </div>
            <div>
              <dt>从出发到到达</dt>
              <dd><strong>{displayRate.format(elapsedRate)}</strong> {rateUnit}</dd>
              <dd className="starter-equation">{distanceKm} ÷ ({elapsed} ÷ 60)　·　共 {elapsed} 分钟</dd>
            </div>
          </dl>
          <p>停车时路程不增加。停车越久，全程均速越低，移动均速保持不变。</p>
        </section>
      </div>

      <footer className="starter-links">
        <a className="primary-button" href={practicePath}>做三道变式</a>
        <a className="text-button" href={companionPath}>打开同伴</a>
      </footer>
    </article>
  );
}

const resultLabels = { correct: '答对', incorrect: '算错', unanswered: '未作答' } as const;
const draftKey = 'practice:riding:draft';

type PracticeDraft = {
  version: string;
  answers: Record<string, string>;
  requestId: string;
  pending: PracticeAnswers | null;
};

function restoreDraft(): PracticeDraft | null {
  try {
    const encoded = remembered(draftKey);
    if (!encoded) return null;
    const draft = JSON.parse(encoded) as PracticeDraft | null;
    if (!draft || typeof draft.version !== 'string' || typeof draft.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{8,100}$/.test(draft.requestId) ||
        !draft.answers || typeof draft.answers !== 'object' || Array.isArray(draft.answers) ||
        Object.values(draft.answers).some((value) => typeof value !== 'string')) return null;
    if (draft.pending !== null && (!draft.pending || typeof draft.pending !== 'object' ||
        Array.isArray(draft.pending) || Object.values(draft.pending).some(
          (value) => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0),
        ))) return null;
    return draft;
  } catch {
    return null;
  }
}

function newDraft(version: string): PracticeDraft {
  return { version, answers: {}, requestId: submissionId(), pending: null };
}

export function StarterPractice() {
  const [view, setView] = useState<PracticeView | null>(null);
  const [draft, setDraft] = useState(restoreDraft);
  const [selected, setSelected] = useState<string | null>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [problem, setProblem] = useState<{ message: string; refresh: boolean } | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const justSubmitted = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setProblem(null);
    void api<PracticeView>(practicePath, { signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted) return;
        setView(value);
        remember('starter-built-in-paper',JSON.stringify(value.paper));
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if (!navigator.onLine) {
          try {
            const paper = JSON.parse(remembered('starter-built-in-paper') ?? 'null');
            if (paper?.version && Array.isArray(paper.questions) && paper.questions.every((q:Record<string,unknown>) =>
              q && ['id','unit','prompt'].every(k => typeof q[k] === 'string'))) {
              setView({paper,submission:null,history:[]});
              setProblem({message:'离线使用上次打开的内置题面。历史作答需联网查看。',refresh:false});
              return;
            }
          } catch { /* A missing or old copy needs an online visit. */ }
        }
        setProblem({ message: '小卷载入失败。', refresh: true });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);

  const selectedId = selected === undefined && !draft ? view?.submission?.id : selected;
  const submission = view?.history.find(({ id }) => id === selectedId);
  const paper = submission?.paper ?? view?.paper;
  const answered = view?.paper.questions.filter(({ id }) => Boolean(draft?.answers[id])).length ?? 0;
  const versionChanged = Boolean(draft && view && draft.version !== view.paper.version);

  useEffect(() => {
    if (submission && justSubmitted.current) {
      reviewHeading.current?.focus();
      justSubmitted.current = false;
    }
  }, [submission]);

  function saveDraft(next: PracticeDraft | null) {
    if (next || restoreDraft()?.requestId === draft?.requestId) {
      remember(draftKey, next ? JSON.stringify(next) : null);
    }
    setDraft(next);
  }

  function openDraft() {
    if (!view) return;
    if (!draft) saveDraft(newDraft(view.paper.version));
    setSelected(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || !draft || saving || loading || submission || (!draft.pending && (versionChanged || !answered))) return;
    const questionIds = draft.pending ? Object.keys(draft.pending) : view.paper.questions.map(({ id }) => id);
    const answers = Object.fromEntries(questionIds.map((id) => [
      id, draft.answers[id] ? Number(draft.answers[id]) : null,
    ]));
    const sent = draft.pending ?? answers;
    const editedAfterSend = questionIds.some((id) => sent[id] !== answers[id]);
    saveDraft({ ...draft, pending: sent });
    setSaving(true);
    setProblem(null);
    try {
      if (!navigator.onLine) {
        await enqueue({kind:'practice',id:draft.requestId,version:draft.version,answers:sent});
        saveDraft(null);
        setProblem({message:'已保存，待联机判分。',refresh:false});
        return;
      }
      const saved = await api<PracticeView>(practicePath, {
        method: 'POST',
        body: { requestId: draft.requestId, version: draft.version, answers: sent },
      });
      justSubmitted.current = true;
      setView(saved);
      setSelected(saved.submission?.id);
      saveDraft(editedAfterSend ? { ...newDraft(draft.version), answers: draft.answers } : null);
    } catch (error) {
      if (deletedSubmission(error)) {
        saveDraft(null);
        setProblem({message:'删除状态已变化，旧作答已清除。请重新开始本次练习。',refresh:false});
      } else if (error instanceof ApiError && error.status === 409) {
        saveDraft({ ...newDraft(draft.version), answers: draft.answers });
        setProblem({ message: '这个提交标识已有作答。当前答案已另存为草稿，可以确认后再交卷。', refresh: false });
      } else if (error instanceof ApiError && error.status === 400 && versionChanged) {
        saveDraft({ ...draft, pending: null });
      } else {
        setProblem({ message: '交卷结果暂时无法确认。可以核对上次提交，之后的修改会另存为草稿。', refresh: false });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="starter">
      <header className="starter-heading">
        <h1>{paper?.title ?? '骑行练习'}</h1>
        <p>{submission ? '回看这次的题面、作答和逐题解析。' : '先独立作答，交卷后一起核对。'}</p>
      </header>

      <div className="starter-practice-grid">
        <div className="starter-paper">
          {loading && <p role="status" className="starter-status">正在打开小卷…</p>}
          {problem && <div role="alert" className="starter-status">
            <p>{problem.message}</p>
            {problem.refresh && <button type="button" className="text-button" onClick={() => setReload((value) => value + 1)}>重新载入</button>}
          </div>}
          {view && !loading && view.history.length > 0 && (
            <div className="starter-history">
              <label htmlFor="riding-history">作答记录</label>
              <select id="riding-history" value={submission?.id ?? ''} disabled={saving}
                onChange={(event) => setSelected(event.currentTarget.value || null)}>
                {view.history.map(({ id }, index) => <option value={id} key={id}>第 {index + 1} 次作答</option>)}
                {draft && <option value="">本轮作答中</option>}
              </select>
            </div>
          )}
          {view && paper && !loading && (submission ? <>
            <div className="starter-review-header">
              <h2 ref={reviewHeading} tabIndex={-1} className="starter-review-title">已交卷</h2>
              <button type="button" className="text-button" onClick={openDraft}>{draft ? '继续本轮' : '再做一轮'}</button>
            </div>
            <ol className="starter-exercises">
              {paper.questions.map((question, index) => {
                const row = submission.feedback[index]!;
                return <li key={question.id} className="starter-exercise">
                  <p className="starter-prompt">{question.prompt}</p>
                  <p className="starter-feedback-answer">
                    <strong className={`starter-result starter-result-${row.result}`}>{resultLabels[row.result]}</strong>
                    {row.answer !== null && <span>你的答案　{row.answer} {question.unit}</span>}
                    <span>参考答案　{row.expected} {question.unit}</span>
                  </p>
                  <p className="starter-feedback-explanation">{row.explanation}</p>
                </li>;
              })}
            </ol>
          </> : <form onSubmit={(event) => void submit(event)}>
            {versionChanged && <div className="starter-status">
              <p>草稿对应旧版小卷。</p>
              {!draft?.pending && <button type="button" className="text-button"
                onClick={() => saveDraft(newDraft(view.paper.version))}>清除旧草稿并打开新版</button>}
            </div>}
            {!versionChanged && <ol className="starter-exercises">
              {view.paper.questions.map(({ id, prompt, unit }) => (
                <li key={id} className="starter-exercise">
                  <label className="starter-prompt" htmlFor={`riding-${id}`}>{prompt}</label>
                  <div className="starter-answer">
                    <input id={`riding-${id}`} name={id} type="number" min="0" step="any"
                      aria-describedby={`riding-${id}-unit`} autoComplete="off" disabled={saving}
                      value={draft?.answers[id] ?? ''} onChange={(event) => {
                        const current = draft ?? newDraft(view.paper.version);
                        saveDraft({ ...current, answers: { ...current.answers, [id]: event.currentTarget.value } });
                      }} />
                    <span id={`riding-${id}-unit`}>{unit}</span>
                  </div>
                </li>
              ))}
            </ol>}
            <div className="starter-submit">
              <button className="primary-button" type="submit" disabled={saving || (!draft?.pending && (versionChanged || !answered))}>
                {saving ? '正在交卷…' : draft?.pending ? '核对上次交卷' : '交卷并查看反馈'}
              </button>
              {!versionChanged && <span aria-live="polite">已答 {answered} / {view.paper.questions.length} 题</span>}
            </div>
          </form>)}
        </div>
        <aside className="starter-practice-links" aria-label="相关内容">
          <a href={materialPath}><strong>{ridingLesson.title}</strong><span>回看停车比较和计算过程</span></a>
          <a href={companionPath}><strong>同伴</strong><span>围绕这份讲义提问</span></a>
        </aside>
      </div>
    </article>
  );
}
