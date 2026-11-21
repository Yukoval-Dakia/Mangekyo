import { Icon } from '../icons';
import { ReadState } from '../workspace';
import type { GoalsPanelProps } from './types';

export function GoalsPanel({ library, onOpenGoalEditor }: GoalsPanelProps) {
  const goal = library.data?.goal ?? null;
  return (
    <section className="me-v2-card me-v2-goal" aria-labelledby="me-v2-goal-title">
      <div className="me-v2-card-head">
        <div>
          <h2 id="me-v2-goal-title">当前学习目标</h2>
          <p className="me-v2-card-sub">目标会引导同伴与后台教研围绕「你最近想弄懂的事」展开。</p>
        </div>
        {onOpenGoalEditor && (
          <button type="button" className="me-v2-pill-button" onClick={onOpenGoalEditor}>
            <Icon name="plus" />
            {goal ? '修改目标' : '写下目标'}
          </button>
        )}
      </div>
      <ReadState resource={library} />
      {library.data && (
        goal ? (
          <blockquote className="me-v2-goal-text">
            <p>{goal}</p>
          </blockquote>
        ) : (
          <div className="me-v2-empty">
            <h3>还没有设定学习目标</h3>
            <p>写下你最近希望弄懂的一件事。它会出现在「今天」页顶，陪伴每一次练习与对话。</p>
            {onOpenGoalEditor && (
              <button type="button" className="me-v2-tonal" onClick={onOpenGoalEditor}>
                设定一个近期目标
              </button>
            )}
          </div>
        )
      )}
      {goal && (
        <p className="me-v2-foot">
          节奏的分配来自「今天」页的安排；想调整强度时，直接修改目标即可。
        </p>
      )}
    </section>
  );
}
