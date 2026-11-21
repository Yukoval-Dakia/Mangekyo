import { useEffect, useRef, useState } from 'react';
import { api, ApiError, remember, remembered, requestId } from './api';
import { PageTitle } from './workspace';
import { RetentionPosttests } from './retention-posttests';
import { durationLabels, openLink, todayParams, TodayActivity, type ActivityRef, type Duration } from './today-pack';
import { rememberPlan, SavedTodayAnswers, TodayHistory } from './today-history';
import { TodayClassrooms } from './today-classrooms';
import './today.css';

type Mode = 'any' | 'one-hand' | 'voice';
const kindLabel = {
  review: '复习',
  probe: '摸底',
  counterexample: '反例练习',
  exam: '考试练习',
  recovery: '恢复练习',
  lesson: '讲义',
};
type Candidate = {
  kind: keyof typeof kindLabel;
  id: string;
  title: string;
  minutes: number;
  topic: string;
  open: ActivityRef | null;
  durationBasis: string;
  reason: string;
  evidence: string[];
  delayImpact: string;
  state?: 'in-progress' | 'completed';
};
type Action = 'defer' | 'replace' | 'rest' | 'lock';
type Rule = { kind: string; date?: string; activityId?: string; replacementId?: string; until?: string };
type StoredRule = { id: string; rev: number; data: Rule };
type GoalStatus = 'active' | 'paused' | 'completed' | 'exited';
type TodayPlan = {
  day: string;
  openedAt: string;
  returning: boolean;
  overview: { retained: string[]; faded: string[]; unknown: string[] } | null;
  campaign: string;
  goal: { id: string; rev: number; text: string | null; status: GoalStatus } | null;
  protectedItems: Candidate[];
  items: { candidate: Candidate; why: string[]; actions: Action[] }[];
  rules: StoredRule[];
  alternatives: Candidate[];
  conflicts: { constraints: string[]; options: string[] }[];
  resting: boolean;
  totalMinutes: number;
  budgetMinutes: number;
  budgetBasis: string;
  forecast:
    | { kind: 'unknown'; reason: string }
    | {
        kind: 'value';
        value: { low: number; high: number; maximum: number; methodVersion: string; absoluteError: number };
      };
  schoolMinutes: number;
  tradeoffs: { activityId: string; reason: string }[];
  actions: Action[];
};
type Operation = { path: '/today/rules' | '/today/goal'; payload: object; requestId: string };
const labels: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '暂停',
  completed: '已完成',
  exited: '已退出',
};

function nextDay(day: string) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function TodayPlanPage({ mode, duration }: { mode: Mode; duration: Duration | undefined }) {
  const [plan, setPlan] = useState<TodayPlan | null>(null);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [swapId, setSwapId] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [pending, setPending] = useState<Operation | null>(() => {
    try {
      const op = JSON.parse(remembered('today-pending-rule') ?? 'null');
      return op &&
        ['/today/rules', '/today/goal'].includes(op.path) &&
        typeof op.requestId === 'string' &&
        op.payload
        ? op
        : null;
    } catch {
      return null;
    }
  });
  const lastVisit = useRef(remembered('today-last-open'));
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) setReload((n) => n + 1);
    };
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const params = todayParams(mode, duration);
    params.set('timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    if (lastVisit.current) params.set('lastOpenedAt', lastVisit.current);
    if (!navigator.onLine) {
      setPlan(null);
      setOffline(true);
      setLoading(false);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    void api<TodayPlan>('/today?' + params, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (
          !Array.isArray(value?.items) ||
          !Array.isArray(value.protectedItems) ||
          !Array.isArray(value.rules) ||
          !Array.isArray(value.alternatives) ||
          !Number.isFinite(value.totalMinutes)
        )
          throw new Error('规划回执不完整。');
        rememberPlan(value, mode, duration);
        setOffline(false);
        setPlan(value);
        if (typeof value.openedAt === 'string') remember('today-last-open', value.openedAt);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setPlan(null);
          setOffline(failure instanceof TypeError);
          setError(
            failure instanceof ApiError && failure.status !== 404
              ? failure.message
              : '当前无法取得服务端的今日安排。',
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [mode, duration, reload]);

  async function write(op: Operation) {
    if (busy) return;
    setBusy(true);
    setMutationError('');
    setPending(op);
    remember('today-pending-rule', JSON.stringify(op));
    function clear() {
      setPending(null);
      remember('today-pending-rule', null);
    }
    try {
      await api(op.path, { method: 'POST', body: { ...op.payload, requestId: op.requestId } });
      clear();
      setSwapId('');
      setReload((n) => n + 1);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
        clear();
        setReload((n) => n + 1);
        setMutationError(failure.message + ' 请核对最新安排。');
      } else setMutationError('结果尚未确认，可用原请求继续核对。');
    } finally {
      setBusy(false);
    }
  }
  function changeRule(data: Rule | null, previous?: StoredRule) {
    void write({
      path: '/today/rules',
      requestId: requestId(),
      payload: { ...(previous && { id: previous.id }), expectedRev: previous?.rev ?? null, data },
    });
  }
  const locked = busy || loading || !!pending;
  const restRule = plan?.rules.find((rule) => rule.data.kind === 'rest' && rule.data.date === plan.day);
  function card(candidate: Candidate, why: string[], actions: Action[], protectedItem: boolean) {
    if (!plan) return null;
    const lock = plan.rules.find(
      (r) => r.data.kind === 'lock' && r.data.date === plan.day && r.data.activityId === candidate.id,
    );
    const alternatives = plan.alternatives.filter(
      (c) =>
        c.id !== candidate.id &&
        c.open &&
        !plan.protectedItems.some((p) => p.id === c.id) &&
        !plan.items.some((i) => i.candidate.id === c.id),
    );
    const replacement = plan.rules.find(
      (r) => r.data.kind === 'replace' && r.data.date === plan.day && r.data.activityId === candidate.id,
    );
    return (
      <article className="day-item" key={candidate.id}>
        <small>
          {kindLabel[candidate.kind]} · {candidate.topic} · {candidate.minutes} 分钟
          {protectedItem &&
            ' · ' +
              (candidate.state === 'completed'
                ? '已完成'
                : candidate.state === 'in-progress'
                  ? '进行中'
                  : '已锁定')}
        </small>
        <h3>{candidate.title}</h3>
        <p>{candidate.reason}</p>
        <small>推迟影响 · {candidate.delayImpact}</small>
        <details>
          <summary>安排依据</summary>
          <p>{candidate.durationBasis}</p>
          {why
            .filter((w) => w !== candidate.reason)
            .map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          <small>{candidate.evidence.join(' · ')}</small>
        </details>
        <div className="study-actions">
          {candidate.open && (
            <a className="primary-button" href={openLink(candidate.open, mode, duration)}>
              开始 / 继续
            </a>
          )}
          {lock ? (
            <button className="text-button" disabled={locked} onClick={() => changeRule(null, lock)}>
              解除锁定
            </button>
          ) : (
            actions.includes('lock') && (
              <button
                className="text-button"
                disabled={locked}
                onClick={() => changeRule({ kind: 'lock', date: plan.day, activityId: candidate.id })}
              >
                锁定
              </button>
            )
          )}
          {actions.includes('replace') && (
            <button
              className="text-button"
              disabled={locked}
              aria-expanded={swapId === candidate.id}
              onClick={() => setSwapId(swapId === candidate.id ? '' : candidate.id)}
            >
              换一项
            </button>
          )}
          {actions.includes('defer') && (
            <button
              className="text-button"
              disabled={locked}
              onClick={() =>
                changeRule({ kind: 'defer', activityId: candidate.id, until: nextDay(plan.day) })
              }
            >
              推迟到明天
            </button>
          )}
        </div>
        {swapId === candidate.id && (
          <div className="study-actions">
            {alternatives.length ? (
              alternatives.map((c) => (
                <button
                  key={c.id}
                  disabled={locked}
                  className="tonal-button"
                  onClick={() =>
                    changeRule(
                      { kind: 'replace', date: plan.day, activityId: candidate.id, replacementId: c.id },
                      replacement,
                    )
                  }
                >
                  {c.title} · {c.minutes} 分钟
                </button>
              ))
            ) : (
              <p>服务端目前没有其他可换活动。</p>
            )}
          </div>
        )}
      </article>
    );
  }
  return (
    <>
      <PageTitle title="今天" meta={plan?.day ?? new Date().toLocaleDateString('zh-CN')} />
      <TodayClassrooms />
      <div role="group" aria-label="可用时间" className="filter-row today-modes">
        {([undefined, '3min', '15min', '45min+'] as const).map(value =>
          <a key={value ?? 'any'} className="tonal-button" aria-current={duration === value ? 'page' : undefined}
            href={'/today?' + todayParams(mode, value)}>{value ? durationLabels[value] : '不限时长'}</a>)}
      </div>
      <div role="group" aria-label="作答方式" className="filter-row today-modes">
        {(
          [
            ['any', '全部方式'],
            ['one-hand', '单手点选'],
            ['voice', '语音'],
          ] as const
        ).map(([value, label]) => (
          <a
            className="tonal-button"
            key={value}
            aria-current={mode === value ? 'page' : undefined}
            href={'/today?' + todayParams(value, duration)}
          >
            {label}
          </a>
        ))}
      </div>
      {mutationError && <p role="alert">{mutationError}</p>}
      {pending && !offline && (
        <button className="tonal-button" disabled={busy} onClick={() => void write(pending)}>
          用原请求核对安排
        </button>
      )}
      {error && (
        <p role="status">
          {error}{' '}
          <button className="text-button" onClick={() => setReload((n) => n + 1)}>
            重试
          </button>
        </p>
      )}
      {offline && <TodayHistory />}
      <SavedTodayAnswers mode={mode} duration={duration} />
      {loading && !plan && <p role="status">正在读取今天的安排…</p>}
      {plan && (
        <section className="day-sheet" aria-busy={loading}>
          <div className="subhead">
            <h2>{plan.resting ? '今晚休息' : '今日组合'}</h2>
            <span>
              {plan.protectedItems.length + plan.items.length} 项 · 约 {plan.totalMinutes} 分钟
            </span>
          </div>
          <p>
            {plan.budgetBasis} 可用 {plan.budgetMinutes} 分钟。
            {plan.schoolMinutes > 0 && '其中学校作业占 ' + plan.schoolMinutes + ' 分钟。'}
          </p>
          {restRule ? (
            <button className="tonal-button" disabled={locked} onClick={() => changeRule(null, restRule)}>
              恢复今天的组合
            </button>
          ) : (
            plan.actions.includes('rest') &&
            !plan.resting && (
              <button
                className="tonal-button"
                disabled={locked}
                onClick={() => changeRule({ kind: 'rest', date: plan.day })}
              >
                今晚休息
              </button>
            )
          )}
          {plan.protectedItems.map((c) => card(c, [], [], true))}
          {plan.items.map((item) => card(item.candidate, item.why, item.actions, false))}
          {!plan.resting && !plan.items.length && !plan.protectedItems.length && (
            <p>当前条件下没有可安排的活动。</p>
          )}
          {plan.conflicts.map((c, i) => (
            <p role="status" key={i}>
              {c.constraints.join(' · ')}。{c.options.join(' / ')}
            </p>
          ))}
          {plan.rules
            .filter(
              (r) =>
                (r.data.kind === 'defer' && r.data.until && r.data.until > plan.day) ||
                (r.data.kind === 'replace' && r.data.date === plan.day),
            )
            .map((r) => (
              <button
                className="text-button"
                key={r.id}
                disabled={locked}
                onClick={() => changeRule(null, r)}
              >
                {r.data.kind === 'defer' ? '撤回推迟' : '撤回换选'} · {r.data.activityId}
              </button>
            ))}
          {plan.goal && (
            <details>
              <summary>学习目标 · {labels[plan.goal.status]}</summary>
              <p>{plan.goal.text}</p>
              {(Object.keys(labels) as GoalStatus[])
                .filter((s) => s !== plan.goal!.status)
                .map((status) => (
                  <button
                    key={status}
                    disabled={locked}
                    className="text-button"
                    onClick={() =>
                      void write({
                        path: '/today/goal',
                        requestId: requestId(),
                        payload: { id: plan.goal!.id, expectedRev: plan.goal!.rev, status },
                      })
                    }
                  >
                    {labels[status]}
                  </button>
                ))}
            </details>
          )}
          {plan.tradeoffs.length > 0 && (
            <details>
              <summary>安排时的取舍</summary>
              {plan.tradeoffs.map((t) => (
                <p key={t.activityId}>{t.reason}</p>
              ))}
            </details>
          )}
          {plan.rules.some((r) => r.data.kind === 'exam') && (
            <details>
              <summary>考试预测</summary>
              {plan.forecast.kind === 'unknown' ? (
                <p>{plan.forecast.reason}</p>
              ) : (
                <p>
                  {plan.forecast.value.low}–{plan.forecast.value.high} / {plan.forecast.value.maximum} ·
                  {plan.forecast.value.methodVersion} · 绝对误差 {plan.forecast.value.absoluteError}
                </p>
              )}
            </details>
          )}
          {plan.returning && plan.overview && (
            <details>
              <summary>回来后的学习概况</summary>
              <p>保留 · {plan.overview.retained.join('、') || '暂无'}</p>
              <p>减弱 · {plan.overview.faded.join('、') || '暂无'}</p>
              <p>尚待核对 · {plan.overview.unknown.join('、') || '暂无'}</p>
            </details>
          )}
        </section>
      )}
      <div className="study-actions today-links">
        <a href="/practice/riding">随手开练</a>
        <a href="/materials">翻材料</a>
        <a href="/plan">学习计划</a>
        <a href="/review">错题回看</a>
      </div>
      {!offline && <RetentionPosttests />}
    </>
  );
}

export function Today() {
  const params = new URLSearchParams(location.search);
  const selected = params.get('posttest');
  if (selected !== null)
    return (
      <>
        <PageTitle title="今天" />
        <RetentionPosttests selected={selected} />
      </>
    );
  const mode: Mode =
    params.get('mode') === 'one-hand' ? 'one-hand' : params.get('mode') === 'voice' ? 'voice' : 'any';
  const requestedDuration = params.get('duration');
  const duration = requestedDuration === '3min' || requestedDuration === '15min' || requestedDuration === '45min+' ? requestedDuration : undefined;
  const kind = params.get('kind'),
    id = params.get('id'),
    rev = Number(params.get('rev'));
  if ((kind === 'pack' || kind === 'activity') && id && Number.isSafeInteger(rev) && rev > 0)
    return <TodayActivity refValue={{ kind, id, rev }} mode={mode} duration={duration} />;
  return <TodayPlanPage mode={mode} duration={duration} />;
}
