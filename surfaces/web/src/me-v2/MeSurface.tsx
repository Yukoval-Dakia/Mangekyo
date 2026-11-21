import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../icons';
import { ReadState } from '../workspace';
import { GoalsPanel } from './GoalsPanel';
import { DataSovereigntyPanel } from './DataSovereigntyPanel';
import { ModelBudgetPanel } from './ModelBudgetPanel';
import {
  ME_SECTIONS,
  sectionFromSearch,
  type MeSection,
  type MeSurfaceProps,
} from './types';

function useSectionState(props: MeSurfaceProps) {
  const isControlled = props.section !== undefined;
  const [internal, setInternal] = useState<MeSection>(() => sectionFromSearch(location.search));

  useEffect(() => {
    if (isControlled) return;
    const sync = () => setInternal(sectionFromSearch(location.search));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [isControlled]);

  const current = isControlled ? props.section! : internal;

  const setSection = useCallback((next: MeSection) => {
    if (isControlled) {
      props.onSectionChange?.(next);
      return;
    }
    setInternal(next);
    const url = next === 'memory' ? '/me' : `/me?section=${next}`;
    history.pushState(null, '', url);
    document.title = `${ME_SECTIONS.find(s => s.id === next)?.label ?? '我'} · Mangekyō`;
  }, [isControlled, props]);

  return [current, setSection] as const;
}

function MemoryPanel({ render }: { render?: (() => React.ReactNode) | undefined }) {
  return (
    <section className="me-v2-card" aria-labelledby="me-v2-memory">
      <div className="me-v2-card-head">
        <div>
          <h2 id="me-v2-memory">我的记忆与画像</h2>
          <p className="me-v2-card-sub">
            你能看见系统记住了什么、为什么这样判断，也可以随时修改或撤回。
          </p>
        </div>
      </div>
      {render ? (
        <div className="me-v2-slot">{render()}</div>
      ) : (
        <p className="me-v2-empty-inline">
          记忆总览面板尚未装配；装配后即可在这里逐条查看、更正或撤回系统的理解。
        </p>
      )}
    </section>
  );
}

export function MeSurface(props: MeSurfaceProps) {
  const [section, setSection] = useSectionState(props);
  const active = ME_SECTIONS.find(item => item.id === section) ?? ME_SECTIONS[0]!;

  return (
    <div className="me-v2">
      <header className="me-v2-head">
        <div>
          <p className="me-v2-meta">透明镜子 · 控制权</p>
          <h1>我</h1>
        </div>
      </header>

      <nav className="me-v2-tabs" aria-label="我的表面分区">
        {ME_SECTIONS.map(item => (
          <button
            key={item.id}
            type="button"
            aria-pressed={item.id === section}
            aria-label={item.label}
            title={item.hint}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <p className="me-v2-hint">{active.hint}</p>

      {section === 'memory' && <MemoryPanel render={props.renderMemoryOverview} />}
      {section === 'goals' && <GoalsPanel library={props.library} onOpenGoalEditor={props.onOpenGoalEditor} />}
      {section === 'privacy' && (
        <DataSovereigntyPanel
          renderNotionSettings={props.renderNotionSettings}
          renderErasure={props.renderErasure}
        />
      )}
      {section === 'models' && <ModelBudgetPanel settings={props.settings} onOpenSettings={props.onOpenSettings} />}

      <footer className="me-v2-footnote">
        <Icon name="lock" />
        <p>
          你的材料默认仅保存。每一项授权、每一次后台记录都可在这里查看、修改或撤回。
        </p>
      </footer>
    </div>
  );
}
