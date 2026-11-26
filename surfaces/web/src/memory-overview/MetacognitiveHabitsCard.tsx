import { useState, type MouseEvent } from 'react';
import type { MetacognitiveHabit, MetacognitiveHabitEvidence } from './types';

export type MetacognitiveHabitsCardProps = {
  readonly habits?: readonly MetacognitiveHabit[] | undefined;
  readonly onNavigate?: ((href: string) => void) | undefined;
};

function isSpaHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/');
}

function handleLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onNavigate?: (href: string) => void,
) {
  if (!onNavigate || !isSpaHref(href)) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  onNavigate(href);
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  verified: '已实证',
  supported: '已实证',
  confirmed: '已实证',
  active: '持续观察',
  provisional: '待复核',
  candidate: '待复核',
  needs_review: '待复核',
};

function statusLabel(status: string | undefined): string | null {
  if (!status) return null;
  return STATUS_LABELS[status] ?? status;
}

function HabitEvidenceList({
  evidences,
  onNavigate,
}: {
  evidences: readonly MetacognitiveHabitEvidence[];
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (evidences.length === 0) return null;

  return (
    <div className="mo-habit-evidence">
      <button
        type="button"
        className="memory-basis-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? '收起原话证据' : `查看原话证据（${evidences.length} 条）`}
      </button>
      {open && (
        <ul className="memory-basis-list mo-habit-evidence-list">
          {evidences.map((item, index) => (
            <li key={item.id ?? `ev-${index}`}>
              <div className="mo-habit-evidence-head">
                <strong>{item.label || `独立证据 ${index + 1}`}</strong>
                {item.href && (
                  <a
                    className="text-button mo-evidence-link"
                    href={item.href}
                    onClick={(event) => handleLinkClick(event, item.href!, onNavigate)}
                  >
                    溯源记录
                  </a>
                )}
              </div>
              <span className="mo-habit-excerpt">“{item.excerpt}”</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MetacognitiveHabitsCard({ habits, onNavigate }: MetacognitiveHabitsCardProps) {
  const list = habits ?? [];

  return (
    <section className="mo-insight-card mo-habit-card" aria-labelledby="mo-habits-title">
      <div className="mo-insight-head">
        <div className="mo-insight-title-group">
          <span className={`mo-signal-dot ${list.length > 0 ? 'is-forest' : 'is-calm'}`} aria-hidden="true" />
          <div>
            <h3 id="mo-habits-title">跨科元认知习惯</h3>
            <p className="mo-insight-sub">仅在跨学科或多次独立会话反复出现时成立，每条均可回查原话证据。</p>
          </div>
        </div>
        {list.length > 0 && (
          <span className="mo-habit-count">{list.length} 条已实证</span>
        )}
      </div>

      {list.length === 0 ? (
        <div className="mo-insight-empty">
          <p>跨学科或多次会话积累足够独立证据后，这里会呈现可查证的元认知习惯，绝不因单次失误贴标签。</p>
        </div>
      ) : (
        <ul className="mo-habit-list">
          {list.map((habit) => {
            const subjects = habit.subjects ?? [];
            const evidences = habit.evidences ?? [];
            const evidenceTotal = habit.evidenceCount ?? evidences.length;
            const label = statusLabel(habit.status);
            const showSummary = habit.summary.trim() !== habit.title.trim();

            return (
              <li key={habit.id} className="mo-habit-item">
                <div className="mo-habit-item-head">
                  <strong>{habit.title}</strong>
                  {label && <span className="mo-tag mo-tag--forest">{label}</span>}
                </div>

                <div className="mo-habit-badges">
                  {habit.errorStageLabel && (
                    <span className="mo-tag">{habit.errorStageLabel}</span>
                  )}
                  {subjects.length >= 2 && (
                    <span className="mo-tag mo-tag--forest">跨 {subjects.length} 科</span>
                  )}
                  {subjects.map((subject) => (
                    <span key={subject} className="mo-tag">{subject}</span>
                  ))}
                  {typeof habit.sessionCount === 'number' && habit.sessionCount > 0 && (
                    <span className="mo-tag">{habit.sessionCount} 次会话</span>
                  )}
                  {evidenceTotal > 0 && (
                    <span className="mo-tag">{evidenceTotal} 条独立证据</span>
                  )}
                </div>

                {habit.preStartHint ? (
                  <p className="mo-habit-summary">开卷前提醒：{habit.preStartHint}</p>
                ) : (
                  showSummary && <p className="mo-habit-summary">{habit.summary}</p>
                )}
                {habit.confidenceNote &&
                  habit.confidenceNote !== habit.preStartHint &&
                  habit.confidenceNote !== habit.summary && (
                    <p className="mo-habit-summary">{habit.confidenceNote}</p>
                  )}

                <HabitEvidenceList evidences={evidences} onNavigate={onNavigate} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
