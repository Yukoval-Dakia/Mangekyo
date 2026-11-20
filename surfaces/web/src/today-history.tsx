import { remember, remembered } from './api';
import { cachedPack, openLink, otherCachedPacks, type ActivityRef } from './today-pack';

type PlanItem = { open: ActivityRef | null };
type Plan = {
  day: string;
  resting: boolean;
  totalMinutes: number;
  protectedItems: PlanItem[];
  items: { candidate: PlanItem }[];
};
type History = Pick<Plan, 'day' | 'resting' | 'totalMinutes'> & { mode: string; slots: (ActivityRef | null)[] };
const key = 'today-offline-plan';
const modes: Record<string, string> = { any: '全部', 'one-hand': '3 分钟单手', voice: '语音' };

export function rememberPlan(plan: Plan, mode: string) {
  // Only the organizer's immutable pack references may travel offline.
  // Private activities retain a position, with no identifying fields.
  const slots = [...plan.protectedItems, ...plan.items.map(item => item.candidate)].map(({ open }) =>
    open?.kind === 'pack' ? { kind: open.kind, id: open.id, rev: open.rev } : null);
  const snapshot: History = { day: plan.day, totalMinutes: plan.totalMinutes, mode, resting: plan.resting, slots };
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
      <p>{snapshot.day} · {modes[snapshot.mode]} · 约 {snapshot.totalMinutes} 分钟 ·
        {snapshot.day === today ? '离线副本' : '历史安排，日期已过期'}。联网后可核对当前安排。</p>
      {snapshot.resting && <p>当时安排了休息。</p>}
      <ol>{snapshot.slots.map((ref, i) => {
        const pack = ref?.kind === 'pack' && cachedPack(ref);
        return <li key={i}>{pack && ref ?
          <a href={openLink(ref, snapshot.mode)}>{pack.title} · 打开已缓存的练习</a> :
          ref ? '内置练习尚未缓存' : '私人活动 · 联网后核对'}</li>;
      })}</ol>
    </section>}
    {other.length > 0 && <section className="day-sheet">
      <h2>本机已缓存的练习</h2>
      <ul>{other.map(pack => <li key={pack.id + '@' + pack.rev}>
        <a href={openLink(pack, snapshot?.mode ?? 'any')}>{pack.title} · 第 {pack.rev} 版</a>
      </li>)}</ul>
    </section>}
  </>;
}
