import type { ReactNode } from 'react';
import type { Settings } from '../api';
import type { Resource, Workspace } from '../workspace';

export type MeSection = 'memory' | 'goals' | 'privacy' | 'models';

export const ME_SECTIONS: readonly { id: MeSection; label: string; hint: string }[] = [
  { id: 'memory', label: '我的记忆与画像', hint: '系统记住了什么、为什么这样判断' },
  { id: 'goals', label: '当前学习目标', hint: '近期想弄懂什么、节奏与预算' },
  { id: 'privacy', label: '数据自主与隐私', hint: '材料授权、连接、导出与删除' },
  { id: 'models', label: '模型与双预算', hint: '同伴模型与后台教研 / 维护预算' },
] as const;

export function isMeSection(value: string | null | undefined): value is MeSection {
  return ME_SECTIONS.some(section => section.id === value);
}

export function sectionFromSearch(search: string): MeSection {
  const parsed = new URLSearchParams(search).get('section');
  return isMeSection(parsed) ? parsed : 'memory';
}

export type MeSurfaceProps = {
  section?: MeSection;
  onSectionChange?: (section: MeSection) => void;
  library: Resource<Workspace>;
  settings?: Settings | undefined;
  onNavigate?: ((href: string) => void) | undefined;
  onOpenGoalEditor?: (() => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
  renderMemoryOverview?: (() => ReactNode) | undefined;
  renderNotionSettings?: (() => ReactNode) | undefined;
  renderErasure?: (() => ReactNode) | undefined;
};

export type GoalsPanelProps = {
  library: Resource<Workspace>;
  onOpenGoalEditor?: (() => void) | undefined;
};

export type DataSovereigntyPanelProps = {
  renderNotionSettings?: (() => ReactNode) | undefined;
  renderErasure?: (() => ReactNode) | undefined;
};

export type ModelBudgetPanelProps = {
  settings?: Settings | undefined;
  onOpenSettings?: (() => void) | undefined;
};
