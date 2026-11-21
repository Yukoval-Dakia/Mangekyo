import { useEffect, useState } from 'react';
import { latestKey, validWatermark } from './deletion-watermark';
import { savedDrafts } from './today-draft';
import { remember, remembered } from './api';
import { cachedPack, durationLabel, openLink, type Duration, otherCachedPacks, type ActivityRef } from './today-pack';

type PlanItem = { open: ActivityRef | null };
type Plan = {
  day: string;
  resting: boolean;
  totalMinutes: number;
  protectedItems: PlanItem[];
  items: { candidate: PlanItem }[];
};
type History = Pick<Plan, 'day' | 'resting' | 'totalMinutes'> & { mode: string; duration?: Duration; slots: (ActivityRef | null)[] };
const key = 'today-offline-plan';
const modes: Record<string, string> = { any: '全部', 'one-hand': '单手点选', voice: '语音' };

export function rememberPlan(plan: Plan, mode: string, duration?: Duration) {
  // Only the organizer's immutable pack references may travel offline.
  // Private activities retain a position, with no identifying fields.
  const slots = [...plan.protectedItems, ...plan.items.map(item => item.candidate)].map(({ open }) =>
    open?.kind === 'pack' ? { kind: open.kind, id: open.id, rev: open.rev } : null);
  const snapshot: History = { day: plan.day, totalMinutes: plan.totalMinutes, mode, ...(duration && {duration}), resting: plan.resting, slots };
  remember(key, JSON.stringify(snapshot));
}

function readHistory(): History | null {
  try {
    const value = JSON.parse(remembered(key) ?? 'null');
    return value && Array.isArray(value.slots) && /^\d{4}-\d\d-\d\d$/.test(value.day) ? value : null;
  } catch { return null; }
}

export function TodayHistory() {
  const snapshot = readHistory();
  const today = new Date().toLocaleDateString('sv-SE');
  const other = otherCachedPacks(snapshot?.slots.filter(ref => ref !== null) ?? []);
  return <>
    {snapshot && <section className="day-sheet">
      <h2>上次读取的组合</h2>
      <p>{snapshot.day} · {modes[snapshot.mode]} · {durationLabel(snapshot.mode, snapshot.duration)} · 约 {snapshot.totalMinutes} 分钟 ·
        {snapshot.day === today ? '离线副本' : '历史安排，日期已过期'}。联网后可核对当前安排。</p>
      {snapshot.resting && <p>当时安排了休息。</p>}
      <ol>{snapshot.slots.map((ref, i) => {
        const pack = ref?.kind === 'pack' && cachedPack(ref);
        return <li key={i}>{pack && ref ?
          <a href={openLink(ref, snapshot.mode, snapshot.duration)}>{pack.title} · 打开已缓存的练习</a> :
          ref ? '内置练习尚未缓存' : '私人活动 · 联网后核对'}</li>;
      })}</ol>
    </section>}
    {other.length > 0 && <section className="day-sheet">
      <h2>本机已缓存的练习</h2>
      <ul>{other.map(pack => <li key={pack.id + '@' + pack.rev}>
        <a href={openLink(pack, snapshot?.mode ?? 'any', snapshot?.duration)}>{pack.title} · 第 {pack.rev} 版</a>
      </li>)}</ul>
    </section>}
  </>;
}

export function SavedTodayAnswers({ mode, duration }: { mode: string; duration: Duration | undefined }) {
  const [answers, setAnswers] = useState<{ href: string; label: string }[]>([]);
  useEffect(() => {
    function refresh() {
      try {
        const watermark = localStorage.getItem(latestKey);
        if (!validWatermark(watermark)) { setAnswers([]); return; }
        setAnswers(otherCachedPacks([]).flatMap(pack =>
          savedDrafts(pack, watermark).map(draft => ({
            href: openLink(pack, mode, duration) + '&answer=' + encodeURIComponent(draft.requestId),
            label: [pack.title, draft.pending ? '待核对' : '草稿', pack.choices[draft.choice]].join(' · '),
          }))));
      } catch {
        setAnswers([]);
      }
    }
    refresh();
    window.addEventListener('storage', refresh);
    window.addEventListener(latestKey, refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener(latestKey, refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, [mode, duration]);
  return answers.length > 0 && <section className="day-sheet">
    <h2>本机作答</h2>
    <ul>{answers.map(answer => <li key={answer.href}><a href={answer.href}>{answer.label}</a></li>)}</ul>
  </section>;
}
