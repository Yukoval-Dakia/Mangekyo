import { useState } from 'react';
import type { Turn } from '../api';

export interface LiveToolStep {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly summary?: string;
  readonly status: 'running' | 'done' | 'error';
  readonly durationMs?: number;
}

interface ConversationLike {
  readonly thinkingText: string | undefined;
  readonly liveToolSteps: readonly LiveToolStep[] | undefined;
  readonly progressLabel: string | undefined;
}

function readOptionalConversation(chat: unknown): ConversationLike {
  if (chat && typeof chat === 'object') {
    const source = chat as Record<string, unknown>;
    return {
      thinkingText: typeof source['thinkingText'] === 'string' ? source['thinkingText'] as string : undefined,
      liveToolSteps: Array.isArray(source['liveToolSteps']) ? (source['liveToolSteps'] as LiveToolStep[]) : undefined,
      progressLabel: typeof source['progressLabel'] === 'string' ? source['progressLabel'] as string : undefined,
    };
  }
  return { thinkingText: undefined, liveToolSteps: undefined, progressLabel: undefined };
}

function stepGlyph(status: LiveToolStep['status']) {
  if (status === 'running') return '…';
  if (status === 'error') return '!';
  return '✓';
}

function stepDuration(ms: number | undefined) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function LiveStepList({ steps }: { steps: readonly LiveToolStep[] }) {
  return (
    <ol className="agent-steps" aria-label="实时工具步骤">
      {steps.map((step) => (
        <li className={'agent-step agent-step--' + step.status} key={step.id}>
          <span className="agent-step-icon" aria-hidden="true">{stepGlyph(step.status)}</span>
          <span className="agent-step-copy">
            <strong>{step.label || step.name}</strong>
            {step.summary && <small>{step.summary}</small>}
          </span>
          {stepDuration(step.durationMs) && <span className="agent-step-time">{stepDuration(step.durationMs)}</span>}
        </li>
      ))}
    </ol>
  );
}

function ThinkingPreview({ text }: { text: string }) {
  return (
    <details className="agent-thinking">
      <summary>
        <span>思考过程</span>
      </summary>
      <div className="agent-thinking-body">
        <p>{text}</p>
      </div>
    </details>
  );
}

export function AgentThinkingSteps({
  chat,
  progress,
  turn,
}: {
  chat?: unknown;
  progress?: string | undefined;
  turn?: Turn | undefined;
}) {
  const live = readOptionalConversation(chat);
  const steps = live.liveToolSteps;
  const hasLive = Boolean(progress || live.progressLabel || live.thinkingText || (steps && steps.length > 0));
  const [expanded, setExpanded] = useState(false);
  const completed = Boolean(turn);

  if (hasLive) {
    return (
      <div className="agent-live" role="status" aria-label="同伴正在处理">
        <div className="agent-live-head">
          <span className="agent-live-dot" aria-hidden="true" />
          <span>{progress ?? live.progressLabel ?? '同伴正在处理…'}</span>
        </div>
        {steps && steps.length > 0 && <LiveStepList steps={steps} />}
        {live.thinkingText && <ThinkingPreview text={live.thinkingText} />}
      </div>
    );
  }

  if (completed) {
    const trace = turn?.trace ?? [];
    const toolCount = trace.length;
    const thinking = live.thinkingText;
    const hasDetails = toolCount > 0 || Boolean(thinking);
    if (!hasDetails) return null;
    const summary =
      thinking && toolCount > 0
        ? `已思考 · 调用 ${toolCount} 项工具`
        : thinking
          ? '已思考'
          : `调用 ${toolCount} 项工具`;
    return (
      <div className="agent-done">
        <button
          type="button"
          className="agent-done-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{summary}</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 160ms ease' }}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {expanded && (
          <div className="agent-done-body">
            {thinking && <p className="agent-done-thinking">{thinking}</p>}
            {toolCount > 0 && (
              <ol className="agent-steps agent-steps--done" aria-label="本轮工具步骤">
                {trace.map((step, index) => (
                  <li className="agent-step agent-step--done" key={index}>
                    <span className="agent-step-icon" aria-hidden="true">✓</span>
                    <span className="agent-step-copy"><strong>{step}</strong></span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    );
  }

  return null;
}
