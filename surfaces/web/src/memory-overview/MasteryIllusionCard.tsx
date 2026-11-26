import type { MouseEvent } from 'react';
import type { MasteryIllusionAlert } from './types';

export type MasteryIllusionCardProps = {
  readonly alerts?: readonly MasteryIllusionAlert[] | undefined;
  readonly onNavigate?: ((href: string) => void) | undefined;
  readonly onPracticeCounterexample?: ((alert: MasteryIllusionAlert) => void) | undefined;
};

function isSpaHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/');
}

function navigateTo(onNavigate: ((href: string) => void) | undefined, href: string) {
  if (onNavigate && isSpaHref(href)) onNavigate(href);
  else window.location.assign(href);
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

function resolvePracticeHref(alert: MasteryIllusionAlert): string {
  if (alert.practiceHref) return alert.practiceHref;
  if (alert.conceptId) return `/materials?view=graph&focus=${encodeURIComponent(alert.conceptId)}`;
  return '/today';
}

export function MasteryIllusionCard({
  alerts,
  onNavigate,
  onPracticeCounterexample,
}: MasteryIllusionCardProps) {
  const list = alerts ?? [];

  function handlePractice(alert: MasteryIllusionAlert) {
    if (onPracticeCounterexample) {
      onPracticeCounterexample(alert);
      return;
    }
    navigateTo(onNavigate, resolvePracticeHref(alert));
  }

  return (
    <section className="mo-insight-card mo-illusion-card" aria-labelledby="mo-illusion-title">
      <div className="mo-insight-head">
        <div className="mo-insight-title-group">
          <span className={`mo-signal-dot ${list.length > 0 ? 'is-alert' : 'is-calm'}`} aria-hidden="true" />
          <div>
            <h3 id="mo-illusion-title">掌握幻觉红灯区</h3>
            <p className="mo-insight-sub">标记自评很有把握但实际答错的概念，优先用最小反例辨别击穿盲区。</p>
          </div>
        </div>
        {list.length > 0 && (
          <span className="mo-illusion-badge">{list.length} 处需警觉</span>
        )}
      </div>

      {list.length === 0 ? (
        <div className="mo-insight-empty">
          <p>暂未发现高信心却答错的掌握幻觉点；完成带信心自评的练习后会自动检测。</p>
        </div>
      ) : (
        <ul className="mo-illusion-list">
          {list.map((alert) => {
            const practiceHref = resolvePracticeHref(alert);
            return (
              <li key={alert.id} className="mo-illusion-item">
                <div className="mo-illusion-item-head">
                  <div className="mo-illusion-concept">
                    <strong>{alert.conceptTitle}</strong>
                    {alert.subject && <span className="mo-tag">{alert.subject}</span>}
                  </div>
                  <span className="mo-illusion-count">高信心答错 {alert.highConfidenceWrongCount} 次</span>
                </div>

                {alert.latestWrongSummary && (
                  <p className="mo-illusion-summary">{alert.latestWrongSummary}</p>
                )}

                {(alert.discriminatorHint || alert.targetPrompt) && (
                  <div className="mo-illusion-callout">
                    <span className="mo-illusion-callout-label">最小反例 / 辨别条件</span>
                    {alert.discriminatorHint && <p>{alert.discriminatorHint}</p>}
                    {alert.targetPrompt && (
                      <p className="mo-illusion-prompt">{alert.targetPrompt}</p>
                    )}
                  </div>
                )}

                <div className="mo-illusion-actions">
                  {onPracticeCounterexample ? (
                    <button
                      type="button"
                      className="tonal-button mo-illusion-drill-btn"
                      onClick={() => handlePractice(alert)}
                    >
                      练反例辨别
                    </button>
                  ) : (
                    <a
                      className="tonal-button mo-illusion-drill-btn"
                      href={practiceHref}
                      onClick={(event) => handleLinkClick(event, practiceHref, onNavigate)}
                    >
                      练反例辨别
                    </a>
                  )}
                  {alert.evidenceHref && (
                    <a
                      className="text-button mo-evidence-link"
                      href={alert.evidenceHref}
                      onClick={(event) => handleLinkClick(event, alert.evidenceHref!, onNavigate)}
                    >
                      查看错答证据
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
