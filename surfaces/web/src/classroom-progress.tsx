import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { AiActivity } from './shell/aiActivity';

export type ClassroomPhase = 'understand' | 'prepare' | 'present';

const PHASES: { id: ClassroomPhase; label: string }[] = [
  { id: 'understand', label: '正在理解学习需求、规划课堂步骤' },
  { id: 'prepare', label: '正在准备讲解例题与直观图解' },
  { id: 'present', label: '即将呈现，请稍候' },
];

export function useElapsedSeconds(active: boolean, resetKey?: string) {
  const [elapsed, setElapsed] = useState(0);
  const start = useRef<number>(Date.now());
  useEffect(() => {
    start.current = Date.now();
    setElapsed(0);
    if (!active) return;
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - start.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active, resetKey]);
  return elapsed;
}

export function formatElapsed(seconds: number) {
  if (seconds < 60) return `已用时 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `已用时 ${minutes} 分 ${rest} 秒` : `已用时 ${minutes} 分钟`;
}

export function useTeachingActivity(active: boolean, intervalMs = 5000) {
  const [activity, setActivity] = useState<AiActivity>();
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const next = await api<AiActivity>('/ai/activity', { signal: controller.signal });
        if (!controller.signal.aborted) setActivity(next);
      } catch {
        if (!controller.signal.aborted) setActivity(undefined);
      }
      if (!controller.signal.aborted) timer = setTimeout(read, intervalMs);
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, intervalMs]);
  return activity;
}

function teachingTasks(activity: AiActivity | undefined) {
  if (!activity) return [];
  return activity.running.filter(item => item.kind === 'teaching' || item.slotType?.includes('Feedback'));
}

export function inferPhase(activity: AiActivity | undefined, hasTurns: boolean): { current: ClassroomPhase; detail: string } {
  const tasks = teachingTasks(activity);
  if (tasks.some(item => item.state === 'blocked')) {
    return { current: 'prepare', detail: '后台任务已暂停，打开「AI 运作」查看处理办法。' };
  }
  const tools = activity?.recentTools ?? [];
  if (tools.length > 0 || hasTurns) {
    const calls = activity?.usage.recentCalls.length ?? 0;
    return {
      current: 'present',
      detail: calls ? `已记录 ${calls} 次模型调用，正在整理呈现。` : '内容已生成，正在整理呈现。',
    };
  }
  if (tasks.length > 0) {
    const first = tasks[0]!;
    const state = first.state === 'running' ? '正在运行' : first.state === 'waiting' ? '排队等待中' : '已排入队列';
    return { current: 'prepare', detail: `教研任务${state}：正在准备讲解例题与直观图解。` };
  }
  return { current: 'understand', detail: '同伴正在阅读你的输入并规划这节课的步骤。' };
}

export function ClassroomGenerationProgress({
  active,
  resetKey,
  hasTurns,
  onOpenAiActivity,
}: {
  active: boolean;
  resetKey?: string;
  hasTurns?: boolean;
  onOpenAiActivity?: (() => void) | undefined;
}) {
  const elapsed = useElapsedSeconds(active, resetKey);
  const activity = useTeachingActivity(active);
  const { current, detail } = inferPhase(activity, Boolean(hasTurns));
  const currentIndex = PHASES.findIndex(phase => phase.id === current);
  return (
    <div className="classroom-progress" role="status" aria-live="polite">
      <div className="classroom-progress-head">
        <span className="classroom-progress-title">
          <i className="waiting-dot" aria-hidden="true" /> 教研团正在准备这节课
        </span>
        <span className="classroom-progress-elapsed tnum">{formatElapsed(elapsed)}</span>
      </div>
      <ol className="classroom-progress-steps">
        {PHASES.map((phase, index) => (
          <li
            key={phase.id}
            data-state={index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo'}
          >
            {phase.label}
          </li>
        ))}
      </ol>
      <p className="classroom-progress-detail">{detail}这是阶段提示，不是虚假百分比；真实课堂生成通常需要一到两分钟。</p>
      {onOpenAiActivity && (
        <button type="button" className="text-button classroom-progress-link" onClick={onOpenAiActivity}>
          在右侧「AI 运作」中查看实时步骤
        </button>
      )}
    </div>
  );
}
