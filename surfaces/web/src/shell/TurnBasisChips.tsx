import { useMemo, useState, type MouseEvent } from 'react';
import type { Turn } from '../api';
import { handleSpaNavigation } from '../today-v2/shared';
import {
  resolveTurnCitations,
  type IndexedCitation,
  type ResolvedTurnCitations,
  type TurnBasisChip,
} from './inline-citations';

const COLLAPSED_LIMIT = 5;

function ChipLink({
  chip,
  index,
  onNavigate,
}: {
  chip: TurnBasisChip;
  index?: number | undefined;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const title = `${chip.badge} · ${chip.label}`;
  const inner = (
    <>
      {typeof index === 'number' && (
        <span className="turn-basis-index" aria-hidden="true">{index}</span>
      )}
      <span className="turn-basis-badge">{chip.badge}</span>
      <span className="turn-basis-text">{chip.label}</span>
    </>
  );
  if (!chip.href) {
    return (
      <span className="turn-basis-chip turn-basis-chip--static" title={title}>
        {inner}
      </span>
    );
  }
  return (
    <a
      className="turn-basis-chip"
      href={chip.href}
      title={title}
      aria-label={typeof index === 'number' ? `参考来源 ${index}：${title}` : title}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => handleSpaNavigation(event, chip.href!, onNavigate)}
    >
      {inner}
    </a>
  );
}

/**
 * 正文 [[cite:ULID]] 命中白名单时：「引用来源（N）」按 [1][2][3] 严格顺序渲染；
 * 其余系统背景依据折叠进「其他参考（M）」。未引用时保持「参考依据（N）」。
 */
export function TurnBasisChips({
  turn,
  resolved,
  onNavigate,
}: {
  turn: Turn;
  resolved?: ResolvedTurnCitations | undefined;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const computed = useMemo(() => resolved ?? resolveTurnCitations(turn), [turn, resolved]);
  const { cited, background, all } = computed;
  if (all.length === 0) return null;

  if (cited.length > 0) {
    return (
      <div className="turn-basis" aria-label="本轮回复引用来源">
        <span className="turn-basis-label">引用来源（{cited.length}）</span>
        <div className="turn-basis-chips">
          {cited.map((chip: IndexedCitation) => (
            <ChipLink key={chip.key} chip={chip} index={chip.index} onNavigate={onNavigate} />
          ))}
        </div>
        {background.length > 0 && (
          <div className="turn-basis-bg">
            <button
              type="button"
              className="turn-basis-bg-toggle"
              aria-expanded={backgroundOpen}
              onClick={() => setBackgroundOpen(open => !open)}
            >
              其他参考（{background.length}）
              <svg
                className={'turn-basis-bg-chevron' + (backgroundOpen ? ' turn-basis-bg-chevron--open' : '')}
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {backgroundOpen && (
              <div className="turn-basis-chips">
                {background.map(chip => (
                  <ChipLink key={chip.key} chip={chip} onNavigate={onNavigate} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const visible = expanded ? all : all.slice(0, COLLAPSED_LIMIT);
  const hidden = all.length - visible.length;

  return (
    <div className="turn-basis" aria-label="本轮回复参考依据">
      <span className="turn-basis-label">参考依据（{all.length}）</span>
      <div className="turn-basis-chips">
        {visible.map(chip => (
          <ChipLink key={chip.key} chip={chip} onNavigate={onNavigate} />
        ))}
        {!expanded && hidden > 0 && (
          <button
            type="button"
            className="turn-basis-chip turn-basis-chip--more"
            onClick={() => setExpanded(true)}
            aria-label={`展开其余 ${hidden} 条依据`}
          >
            +{hidden}
          </button>
        )}
        {expanded && all.length > COLLAPSED_LIMIT && (
          <button
            type="button"
            className="turn-basis-chip turn-basis-chip--more"
            onClick={() => setExpanded(false)}
            aria-label="收起依据"
          >
            收起
          </button>
        )}
      </div>
    </div>
  );
}
