import {useLayoutEffect, useRef, useState} from 'react';
import {api} from './api';
import type {ItemPacing} from './workbook-pacing';

const labels = {
  steady: '稳拿分',
  'fast-slip': '低耗时失分',
  'time-sink': '超估时失分',
  'recovered-skip': '回访得分',
  unknown: '节奏未知',
};
type State = keyof typeof labels;
type Ref = {id: string; rev: number};
type Item = {item_id: string; position: number; effective_duration_ms: number; state: State};

// Optional workbook projection: the authorized @2 result bound to its frozen paper.
export type ExamTimeValueView = {paper: Ref; attempt_ref: Ref; method_version: 'plan/exam-pacing@2'} &
  ({kind: 'unknown'} | {kind: 'observed'; total_duration_ms: number; items: readonly Item[]; summary: string});
type Attempt = {id: string; rev?: number; paperRev?: number; pacing?: ItemPacing; effectiveDurationMs?: number;
  examTimeValue?: ExamTimeValueView};

function projection(attempt: Attempt, paperId: string, ids: string[]) {
  const total = attempt.effectiveDurationMs;
  const pacing = attempt.pacing;
  if (!ids.length || new Set(ids).size !== ids.length || !attempt.rev || !attempt.paperRev || total === undefined || !Number.isSafeInteger(total) || total <= 0 ||
      pacing?.version !== 1 || !Array.isArray(pacing.items) || pacing.items.length !== ids.length) return;
  const durations = new Map<string, number>();
  let recorded = 0;
  for (const item of pacing.items) {
    if (!item || !Number.isSafeInteger(item.effectiveDurationMs) || item.effectiveDurationMs < 0 ||
        !ids.includes(item.questionId) || durations.has(item.questionId)) return;
    durations.set(item.questionId, item.effectiveDurationMs);
    recorded += item.effectiveDurationMs;
  }
  if (!recorded || recorded > total) return;
  const result = attempt.examTimeValue;
  if (!result || result.kind !== 'observed' || result.method_version !== 'plan/exam-pacing@2' ||
      result.paper?.id !== paperId || result.paper.rev !== attempt.paperRev ||
      result.attempt_ref?.id !== attempt.id || result.attempt_ref.rev !== attempt.rev ||
      !Array.isArray(result.items) || result.items.length !== ids.length ||
      result.total_duration_ms !== recorded || typeof result.summary !== 'string' || !result.summary.trim() ||
      !result.items.every((item, index) => item && item.position === index + 1 && item.item_id === ids[index] &&
        item.effective_duration_ms === durations.get(item.item_id) && typeof item.state === 'string' && Object.hasOwn(labels, item.state))) return;
  const items = result.items.map(({item_id, position, effective_duration_ms, state}: Item) => ({
    id: item_id, number: position, ms: effective_duration_ms, state,
  }));
  return {items, total, remainder: total - recorded, summary: result.summary};
}

const percent = new Intl.NumberFormat('zh-CN', {style: 'percent', maximumFractionDigits: 1});
function share(ms: number, total: number) {
  return ms > 0 && ms / total < 0.0005 ? '<0.1%' : percent.format(ms / total);
}

export function ExamTimeValue({attempt, paperId, ids}: {attempt: Attempt; paperId: string; ids: string[]}) {
  const [unavailable, setUnavailable] = useState(false);
  const request = useRef<AbortController>(undefined);
  useLayoutEffect(() => () => request.current?.abort(), []);
  const timing = unavailable ? undefined : projection(attempt, paperId, ids);
  async function jump(id: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const fresh = await api<{id: string; attempts: (Attempt & {questions?: {id: string}[]})[]}>(
        '/papers/' + encodeURIComponent(paperId), {signal: controller.signal, cache: 'no-store'});
      if (controller.signal.aborted || document.visibilityState !== 'visible') return;
      const current = fresh.id === paperId && fresh.attempts.find(a => a.id === attempt.id &&
        a.rev === attempt.rev && a.paperRev === attempt.paperRev);
      if (current && current.questions?.length === ids.length && current.questions.every((q, i) => q.id === ids[i]) &&
          JSON.stringify(projection(current, paperId, ids)) === JSON.stringify(timing)) {
        document.getElementById('workbook-feedback-' + id)?.focus();
      } else setUnavailable(true);
    } catch {
      if (!controller.signal.aborted) setUnavailable(true);
    }
  }
  return <section className="exam-time-value" aria-label="本卷用时分布">
    <h3>本卷用时分布</h3>
    {timing ? <>
      <p>{timing.summary}</p>
      <div className="exam-time-track" role="group" aria-label="各题占整卷有效用时的比例">
        {timing.items.map(({id, number, ms, state}) => {
          if (!ms) return null;
          const label = `第 ${number} 题 · ${share(ms, timing.total)} · ${labels[state]}`;
          return <button key={id} type="button" aria-label={label} title={label} data-state={state}
            style={{width: (100 * ms / timing.total) + '%'}} onClick={() => jump(id)} />;
        })}
        {timing.remainder > 0 && <span title="未归到题位的用时" style={{width: (100 * timing.remainder / timing.total) + '%'}}/>}
      </div>
      <details>
        <summary>查看逐题占比{timing.remainder > 0 && ` · 未归到题位 ${share(timing.remainder, timing.total)}`}</summary>
        <div className="exam-time-positions">
          {timing.items.map(({id, number, ms, state}) =>
            <button key={id} type="button" onClick={() => jump(id)}>
              第 {number} 题 · {share(ms, timing.total)} · {labels[state]}
            </button>)}
        </div>
      </details>
    </> : <p>用时分布和逐题节奏未知。</p>}
  </section>;
}
