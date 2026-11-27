import { requestId, type AuthoringUiError } from '../api';
import { AuthoringFeedback } from '../AuthoringFeedback';
import { roomPath } from '../classroom-contract';
import { Icon } from '../icons';
import { nextIsoDay } from '../shared/format-time';
import { openLink, type Duration } from '../today-pack';
import {
  Chip,
  Dot,
  InlineToggle,
  cleanHumanText,
  filterHumanEvidence,
  handleSpaNavigation,
  humanizeConstraint,
  isTechnicalIdentifier,
} from './shared';
import {
  GOAL_LABELS,
  actionVerb,
  conceptRecordHref,
  freshMaterialChip,
  isConceptCandidate,
  kindLabel,
  ruleHelpersFor,
  type ActiveRoom,
  type CompanionCitation,
  type GoalStatus,
  type PendingOperation,
  type PlanRulePayload,
  type ScheduledEntry,
  type StoredRule,
  type TodayCandidate,
  type TodayMode,
  type TodayPlanV2,
} from './today-types';

function FreshMaterialChip({ candidate }: { candidate: TodayCandidate }) {
  const label = freshMaterialChip(candidate);
  return label === null ? null : <Chip tone="forest">{label}</Chip>;
}

function stateChip(candidate: TodayCandidate, isProtected: boolean) {
  if (!isProtected && !candidate.state) return null;
  if (candidate.state === 'completed') return <Chip tone="neutral">已完成</Chip>;
  if (candidate.state === 'in-progress') return <Chip tone="forest">进行中</Chip>;
  return <Chip tone="forest">已锁定</Chip>;
}

export function ResumeRoomStrip({
  room,
  onNavigate,
}: {
  room: ActiveRoom;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const href = roomPath(room.id);
  return (
    <a className="tv2-resume" href={href} onClick={(event) => handleSpaNavigation(event, href, onNavigate)}>
      <Dot />
      <span className="tv2-resume-copy">
        <strong>继续课堂</strong>
        <span className="tv2-resume-sep" aria-hidden="true">·</span>
        <span>
          {room.topic.trim() || '未命名课堂'}
          {room.activeStepTitle ? ` · ${room.activeStepTitle}` : ''}
        </span>
      </span>
      <span className="tv2-resume-cue" aria-hidden="true">
        <Icon name="chevron" />
      </span>
    </a>
  );
}

function SwapAlternativesPicker({
  day,
  candidateId,
  alternatives,
  replacementRule,
  locked,
  onChangeRule,
}: {
  day: string;
  candidateId: string;
  alternatives: readonly TodayCandidate[];
  replacementRule: StoredRule | undefined;
  locked: boolean;
  onChangeRule: (data: PlanRulePayload | null, previous?: StoredRule) => void;
}) {
  return (
    <div className="tv2-swap" role="group" aria-label="可替换的备选活动">
      {alternatives.length > 0 ? (
        alternatives.map((alternative) => (
          <button
            key={alternative.id}
            type="button"
            className="tv2-btn tv2-btn--tonal tv2-btn--sm"
            disabled={locked}
            onClick={() =>
              onChangeRule(
                { kind: 'replace', date: day, activityId: candidateId, replacementId: alternative.id },
                replacementRule ?? undefined,
              )
            }
          >
            {alternative.title} · {alternative.minutes} 分钟
          </button>
        ))
      ) : (
        <p className="tv2-muted">目前没有其他可替换的活动。</p>
      )}
    </div>
  );
}

function BasisDetails({
  candidate,
  whyList,
  open,
  onToggle,
}: {
  candidate: TodayCandidate;
  whyList: readonly string[];
  open: boolean;
  onToggle: () => void;
}) {
  const extraReasons = whyList.filter(
    (line) =>
      typeof line === 'string' &&
      line.trim().length > 0 &&
      line.trim() !== candidate.reason.trim() &&
      !isTechnicalIdentifier(line),
  );
  const { readable, hiddenRecordCount } = filterHumanEvidence(candidate.evidence ?? []);
  const durationText =
    candidate.durationBasis && !isTechnicalIdentifier(candidate.durationBasis) ? candidate.durationBasis : '';
  if (!durationText && extraReasons.length === 0 && readable.length === 0 && hiddenRecordCount === 0) {
    return null;
  }

  return (
    <div className="tv2-basis-wrap">
      <InlineToggle open={open} onToggle={onToggle} closed="查看安排依据" opened="收起依据" />
      {open && (
        <div className="tv2-why-basis" role="region" aria-label="安排依据">
          {durationText && <p>{durationText}</p>}
          {extraReasons.map((reasonLine, index) => (
            <p key={index}>{reasonLine}</p>
          ))}
          {readable.length > 0 && <p>{readable.join(' · ')}</p>}
          {readable.length === 0 && hiddenRecordCount > 0 && (
            <p>依据来自已保存的 {hiddenRecordCount} 份学习记录与当前安排节奏。</p>
          )}
        </div>
      )}
    </div>
  );
}

export function TodayHeroCard({
  plan,
  heroEntry,
  restRule,
  usableAlternatives,
  completedProtectedCount,
  scheduledCount,
  emptyLibrary,
  mode,
  duration,
  locked,
  basisOpen,
  onToggleBasis,
  swapTargetId,
  onSwapTargetChange,
  issuingConceptId,
  authoringToday,
  authoringTodayError,
  onChangeRule,
  onStartConceptPractice,
  onAuthorTodayPaper,
  onOpenOnboarding,
  onNavigate,
  navigateTo,
  onCiteToCompanion,
}: {
  plan: TodayPlanV2;
  heroEntry: ScheduledEntry | null;
  restRule: StoredRule | undefined;
  usableAlternatives: readonly TodayCandidate[];
  completedProtectedCount: number;
  scheduledCount: number;
  emptyLibrary?: boolean | undefined;
  mode: TodayMode;
  duration: Duration | undefined;
  locked: boolean;
  basisOpen: boolean;
  onToggleBasis: () => void;
  swapTargetId: string;
  onSwapTargetChange: (id: string) => void;
  issuingConceptId: string;
  authoringToday: boolean;
  authoringTodayError: AuthoringUiError | null;
  onChangeRule: (data: PlanRulePayload | null, previous?: StoredRule) => void;
  onStartConceptPractice: (candidate: TodayCandidate) => void;
  onAuthorTodayPaper: () => void;
  onOpenOnboarding?: (() => void) | undefined;
  onNavigate?: ((href: string) => void) | undefined;
  navigateTo: (href: string) => void;
  onCiteToCompanion?: ((citation: CompanionCitation) => void) | undefined;
}) {
  if (plan.resting) {
    return (
      <article className="tv2-hero tv2-hero--calm" aria-label="今晚休息">
        <div className="tv2-hero-kicker">
          <Chip tone="neutral">休整模式</Chip>
        </div>
        <h2>今晚先休息</h2>
        <p className="tv2-why">今天已标记为休息，不会计入任何欠账；有精神时随时可以把今天的组合找回来。</p>
        {restRule && (
          <div className="tv2-hero-actions">
            <button
              type="button"
              className="tv2-btn tv2-btn--primary"
              disabled={locked}
              onClick={() => onChangeRule(null, restRule)}
            >
              恢复今天的组合
            </button>
          </div>
        )}
      </article>
    );
  }

  if (!heroEntry) {
    const allDone = completedProtectedCount > 0;
    const aiPracticeButton = !allDone ? (
      <button
        type="button"
        className="tv2-btn tv2-btn--tonal"
        disabled={authoringToday}
        onClick={onAuthorTodayPaper}
      >
        {authoringToday ? '正在生成并组卷…' : 'AI 生成今日概念题并组卷开练'}
      </button>
    ) : null;
    const aiPracticeFeedback =
      authoringTodayError && !allDone ? (
        <AuthoringFeedback
          error={authoringTodayError}
          className="tv2-error tv2-authoring-error"
          linkClassName="tv2-inline-link"
          onNavigate={navigateTo}
        />
      ) : null;

    if (emptyLibrary === true && scheduledCount === 0) {
      return (
        <article className="tv2-hero tv2-hero--onboard" aria-label="30 秒配置学习画像">
          <div className="tv2-hero-kicker">
            <Chip tone="forest">30 秒起步</Chip>
          </div>
          <h2 className="m3e-display">告诉 Mangekyō 你在学什么</h2>
          <p className="tv2-why">
            用几句话介绍你的阶段与目标，自动配好考试日程、知识图谱与第一批摸底练习；也可以先随手交入一份试卷或笔记。
          </p>
          <div className="tv2-hero-actions">
            <button type="button" className="tv2-btn tv2-btn--primary" onClick={onOpenOnboarding}>
              <span>30 秒配置学习画像与考试日程</span>
              <Icon name="arrow" />
            </button>
            <a
              className="tv2-btn tv2-btn--tonal"
              href="/intake"
              onClick={(event) => handleSpaNavigation(event, '/intake', onNavigate)}
            >
              随手交入一份试卷或笔记
            </a>
            {aiPracticeButton}
          </div>
          {aiPracticeFeedback}
        </article>
      );
    }

    return (
      <article className="tv2-hero tv2-hero--calm" aria-label={allDone ? '今日安排已完成' : '今天暂无待办活动'}>
        <div className="tv2-hero-kicker">
          <Chip tone={allDone ? 'forest' : 'neutral'}>{allDone ? '已完成今日组合' : '空白起步'}</Chip>
        </div>
        <h2>{allDone ? '今天的安排已经完成' : '今天还没有待安排的活动'}</h2>
        <p className="tv2-why">
          {allDone
            ? `今天完成了 ${completedProtectedCount} 项学习任务，可以轻松收尾休息，或再挑一份材料练手。`
            : '随手交入一份讲义、错题卷或一句话，今天的学习就会从这里开始。'}
        </p>
        <div className="tv2-hero-actions">
          <a
            className="tv2-btn tv2-btn--primary"
            href="/intake"
            onClick={(event) => handleSpaNavigation(event, '/intake', onNavigate)}
          >
            交入第一份材料
          </a>
          {aiPracticeButton}
        </div>
        {aiPracticeFeedback}
      </article>
    );
  }

  const { candidate, why, actions, isProtected } = heroEntry;
  const { lockRule, swapAlternatives, replacementRule } = ruleHelpersFor(plan, usableAlternatives, candidate);
  const primaryHref = candidate.open ? openLink(candidate.open, mode, duration) : null;
  const conceptPractice = isConceptCandidate(candidate);
  const conceptHref = conceptPractice ? conceptRecordHref(candidate) : null;
  const conceptIssuing = conceptPractice && issuingConceptId === candidate.open!.id;
  const leadWhy =
    candidate.reason || why.find((line) => line.trim().length > 0 && !isTechnicalIdentifier(line)) || '';
  const showTopic = Boolean(candidate.topic && candidate.topic.trim() !== candidate.title.trim());

  const citeButton = onCiteToCompanion ? (
    <button
      type="button"
      className="tv2-btn tv2-btn--primary tv2-btn--sm"
      title="带到同伴讨论"
      onClick={() =>
        onCiteToCompanion({
          title: candidate.title,
          text: leadWhy || candidate.title,
          ...(showTopic ? { topic: candidate.topic } : {}),
        })
      }
    >
      <Icon name="chat" />
    </button>
  ) : null;

  return (
    <article className="tv2-hero" aria-label="今日主推荐">
      <div className="tv2-hero-kicker">
        <Chip tone="forest">{kindLabel[candidate.kind] ?? '今日推荐'}</Chip>
        <Chip>
          <span className="tnum">约 {candidate.minutes} 分钟</span>
        </Chip>
        {showTopic && <Chip tone="neutral">{candidate.topic}</Chip>}
        {stateChip(candidate, isProtected)}
      </div>

      <h2>{candidate.title}</h2>
      {freshMaterialChip(candidate) !== null && (
        <p className="tv2-fresh-material">
          <FreshMaterialChip candidate={candidate} />
        </p>
      )}
      {leadWhy && <p className="tv2-why">{leadWhy}</p>}
      <BasisDetails candidate={candidate} whyList={why} open={basisOpen} onToggle={onToggleBasis} />
      {candidate.delayImpact && !isTechnicalIdentifier(candidate.delayImpact) && (
        <p className="tv2-impact">
          <span>推迟影响：</span>
          {candidate.delayImpact}
        </p>
      )}

      <div className="tv2-hero-actions">
        {conceptPractice || primaryHref ? (
          <div className="m3e-split-btn">
            {conceptPractice ? (
              <button
                type="button"
                className="tv2-btn tv2-btn--primary"
                disabled={issuingConceptId !== ''}
                onClick={() => onStartConceptPractice(candidate)}
              >
                <span>{conceptIssuing ? '正在组题…' : actionVerb(candidate)}</span>
                <Icon name="arrow" />
              </button>
            ) : (
              <a
                className="tv2-btn tv2-btn--primary"
                href={primaryHref!}
                onClick={(event) => handleSpaNavigation(event, primaryHref!, onNavigate)}
              >
                <span>{actionVerb(candidate)}</span>
                <Icon name="arrow" />
              </a>
            )}
            {citeButton}
          </div>
        ) : (
          <Chip tone="neutral">材料准备中</Chip>
        )}

        {conceptHref && (
          <a
            className="tv2-btn tv2-btn--tonal tv2-btn--sm"
            href={conceptHref}
            onClick={(event) => handleSpaNavigation(event, conceptHref, onNavigate)}
          >
            看概念脉络
          </a>
        )}
        <div className="tv2-hero-secondary" role="group" aria-label="今日主推荐次操作">
          {lockRule ? (
            <button
              type="button"
              className="tv2-btn tv2-btn--tonal tv2-btn--sm"
              disabled={locked}
              onClick={() => onChangeRule(null, lockRule)}
            >
              解除锁定
            </button>
          ) : (
            actions.includes('lock') && (
              <button
                type="button"
                className="tv2-btn tv2-btn--ghost tv2-btn--sm"
                disabled={locked}
                onClick={() => onChangeRule({ kind: 'lock', date: plan.day, activityId: candidate.id })}
              >
                锁定
              </button>
            )
          )}
          {!isProtected && actions.includes('replace') && (
            <button
              type="button"
              className="tv2-btn tv2-btn--ghost tv2-btn--sm"
              disabled={locked}
              aria-expanded={swapTargetId === candidate.id}
              onClick={() => onSwapTargetChange(swapTargetId === candidate.id ? '' : candidate.id)}
            >
              换一项
            </button>
          )}
          {!isProtected && actions.includes('defer') && (
            <button
              type="button"
              className="tv2-btn tv2-btn--ghost tv2-btn--sm"
              disabled={locked}
              onClick={() => onChangeRule({ kind: 'defer', activityId: candidate.id, until: nextIsoDay(plan.day) })}
            >
              推迟
            </button>
          )}
        </div>
      </div>

      {swapTargetId === candidate.id && (
        <SwapAlternativesPicker
          day={plan.day}
          candidateId={candidate.id}
          alternatives={swapAlternatives}
          replacementRule={replacementRule}
          locked={locked}
          onChangeRule={onChangeRule}
        />
      )}
    </article>
  );
}

export function TodayQueueCard({
  plan,
  entry,
  usableAlternatives,
  mode,
  duration,
  locked,
  swapTargetId,
  onSwapTargetChange,
  issuingConceptId,
  onChangeRule,
  onStartConceptPractice,
  onNavigate,
}: {
  plan: TodayPlanV2;
  entry: ScheduledEntry;
  usableAlternatives: readonly TodayCandidate[];
  mode: TodayMode;
  duration: Duration | undefined;
  locked: boolean;
  swapTargetId: string;
  onSwapTargetChange: (id: string) => void;
  issuingConceptId: string;
  onChangeRule: (data: PlanRulePayload | null, previous?: StoredRule) => void;
  onStartConceptPractice: (candidate: TodayCandidate) => void;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const { candidate, actions, isProtected } = entry;
  const { lockRule, swapAlternatives, replacementRule } = ruleHelpersFor(plan, usableAlternatives, candidate);
  const openHref = candidate.open ? openLink(candidate.open, mode, duration) : null;
  const conceptPractice = isConceptCandidate(candidate);
  const conceptHref = conceptPractice ? conceptRecordHref(candidate) : null;
  const conceptIssuing = conceptPractice && issuingConceptId === candidate.open!.id;
  const showTopic = candidate.topic && candidate.topic.trim() !== candidate.title.trim();
  const metaSegments = [
    kindLabel[candidate.kind] ?? '活动',
    showTopic ? candidate.topic : undefined,
    `约 ${candidate.minutes} 分钟`,
    isProtected
      ? candidate.state === 'completed'
        ? '已完成'
        : candidate.state === 'in-progress'
          ? '进行中'
          : '已锁定'
      : undefined,
  ].filter(Boolean);

  return (
    <li className="tv2-queue-item m3e-seg-item">
      <div className="tv2-queue-card">
        <div className="tv2-queue-copy">
          <strong>{candidate.title}</strong>
          <FreshMaterialChip candidate={candidate} />
          <small className="tv2-queue-meta tnum">{metaSegments.join(' · ')}</small>
          {candidate.reason && !isTechnicalIdentifier(candidate.reason) && (
            <small className="tv2-queue-reason">{candidate.reason}</small>
          )}
        </div>
        <div className="tv2-queue-actions">
          {conceptPractice ? (
            <button
              type="button"
              className="tv2-btn tv2-btn--tonal tv2-btn--sm"
              disabled={issuingConceptId !== ''}
              onClick={() => onStartConceptPractice(candidate)}
            >
              {conceptIssuing ? '正在组题…' : actionVerb(candidate)}
            </button>
          ) : (
            openHref && (
              <a
                className="tv2-btn tv2-btn--tonal tv2-btn--sm"
                href={openHref}
                onClick={(event) => handleSpaNavigation(event, openHref, onNavigate)}
              >
                {actionVerb(candidate)}
              </a>
            )
          )}
          {conceptHref && (
            <a
              className="tv2-btn tv2-btn--ghost tv2-btn--sm"
              href={conceptHref}
              onClick={(event) => handleSpaNavigation(event, conceptHref, onNavigate)}
            >
              看概念脉络
            </a>
          )}
          {lockRule ? (
            <button
              type="button"
              className="tv2-btn tv2-btn--ghost tv2-btn--sm"
              disabled={locked}
              onClick={() => onChangeRule(null, lockRule)}
            >
              解除锁定
            </button>
          ) : !isProtected && actions.includes('replace') ? (
            <button
              type="button"
              className="tv2-btn tv2-btn--ghost tv2-btn--sm"
              disabled={locked}
              aria-expanded={swapTargetId === candidate.id}
              onClick={() => onSwapTargetChange(swapTargetId === candidate.id ? '' : candidate.id)}
            >
              换一项
            </button>
          ) : null}
        </div>
      </div>
      {swapTargetId === candidate.id && (
        <SwapAlternativesPicker
          day={plan.day}
          candidateId={candidate.id}
          alternatives={swapAlternatives}
          replacementRule={replacementRule}
          locked={locked}
          onChangeRule={onChangeRule}
        />
      )}
    </li>
  );
}

export function TodayBudgetCard({
  plan,
  scheduledCount,
  restRule,
  undoableRules,
  titleByActivityId,
  locked,
  onChangeRule,
}: {
  plan: TodayPlanV2;
  scheduledCount: number;
  restRule: StoredRule | undefined;
  undoableRules: readonly StoredRule[];
  titleByActivityId: ReadonlyMap<string, string>;
  locked: boolean;
  onChangeRule: (data: PlanRulePayload | null, previous?: StoredRule) => void;
}) {
  const budgetPercent =
    plan.budgetMinutes > 0 ? Math.min(100, Math.round((plan.totalMinutes / plan.budgetMinutes) * 100)) : 0;
  const overBudget = plan.budgetMinutes > 0 && plan.totalMinutes > plan.budgetMinutes;

  return (
    <section className="tv2-budget-card" aria-label="今日时间预算与出口">
      <div className="tv2-budget">
        <div className="tv2-budget-line tnum">
          <span>
            今日约 <strong className="tnum">{plan.totalMinutes} 分钟</strong>
            {plan.budgetMinutes > 0 && ` / 预算 ${plan.budgetMinutes} 分钟`}
          </span>
          <span className="tv2-muted tnum">
            {scheduledCount} 项
            {plan.schoolMinutes > 0 && ` · 学校作业 ${plan.schoolMinutes} 分钟`}
            {plan.budgetBasis && !isTechnicalIdentifier(plan.budgetBasis) && ` · ${plan.budgetBasis}`}
          </span>
        </div>
        {plan.budgetMinutes > 0 && (
          <div
            className="tv2-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={plan.budgetMinutes}
            aria-valuenow={Math.min(plan.totalMinutes, plan.budgetMinutes)}
            aria-label={`今日时间预算 ${plan.totalMinutes}/${plan.budgetMinutes} 分钟`}
          >
            <span
              className={overBudget ? 'tv2-track-fill tv2-track-fill--over' : 'tv2-track-fill'}
              style={{ width: `${budgetPercent}%` }}
            />
          </div>
        )}
      </div>

      <div className="tv2-exits" role="group" aria-label="快速切换与休息">
        {plan.resting
          ? restRule && (
              <button
                type="button"
                className="tv2-btn tv2-btn--tonal"
                disabled={locked}
                onClick={() => onChangeRule(null, restRule)}
              >
                恢复今天的组合
              </button>
            )
          : plan.actions.includes('rest') && (
              <button
                type="button"
                className="tv2-btn tv2-btn--tonal"
                disabled={locked}
                onClick={() => onChangeRule({ kind: 'rest', date: plan.day })}
              >
                今晚休息
              </button>
            )}
      </div>

      {undoableRules.length > 0 && (
        <div className="tv2-rule-undos" role="group" aria-label="撤销今天的调整">
          {undoableRules.map((rule) => {
            const targetTitle = rule.data.activityId ? titleByActivityId.get(rule.data.activityId) : undefined;
            const verb = rule.data.kind === 'defer' ? '撤回推迟' : '撤回换选';
            return (
              <button
                key={rule.id}
                type="button"
                className="tv2-btn tv2-btn--ghost tv2-btn--sm"
                disabled={locked}
                onClick={() => onChangeRule(null, rule)}
              >
                {targetTitle ? `${verb} · ${targetTitle}` : `${verb} · 原安排项`}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function TodayAuxPanels({
  plan,
  titleByActivityId,
  locked,
  conflictsOpen,
  onToggleConflicts,
  goalOpen,
  onToggleGoal,
  overviewOpen,
  onToggleOverview,
  onCommitOperation,
}: {
  plan: TodayPlanV2;
  titleByActivityId: ReadonlyMap<string, string>;
  locked: boolean;
  conflictsOpen: boolean;
  onToggleConflicts: () => void;
  goalOpen: boolean;
  onToggleGoal: () => void;
  overviewOpen: boolean;
  onToggleOverview: () => void;
  onCommitOperation: (operation: PendingOperation) => void;
}) {
  if (plan.conflicts.length === 0 && !plan.goal && !(plan.returning && plan.overview)) {
    return null;
  }

  return (
    <div className="tv2-aux">
      {plan.conflicts.length > 0 && (
        <div className="tv2-aux-item">
          <InlineToggle
            open={conflictsOpen}
            onToggle={onToggleConflicts}
            closed={`${plan.conflicts.length} 处安排冲突`}
            opened="收起冲突说明"
          />
          {conflictsOpen && (
            <div className="tv2-why-basis">
              {plan.conflicts.map((conflict, index) => {
                const readableConstraints = conflict.constraints
                  .map((entry) => humanizeConstraint(entry, titleByActivityId))
                  .filter((value): value is string => Boolean(value));
                const readableOptions = conflict.options.filter((option) => !isTechnicalIdentifier(option));
                return (
                  <p className="tv2-muted" role="status" key={index}>
                    {readableConstraints.join(' · ')}
                    {readableOptions.length > 0 ? `。可选：${readableOptions.join(' / ')}` : ''}
                  </p>
                );
              })}
            </div>
          )}
        </div>
      )}

      {plan.goal && (
        <div className="tv2-aux-item">
          <InlineToggle
            open={goalOpen}
            onToggle={onToggleGoal}
            closed={`当前目标 · ${GOAL_LABELS[plan.goal.status]}`}
            opened="收起目标"
          />
          {goalOpen && (
            <div className="tv2-why-basis">
              {plan.goal.text && <p className="tv2-muted">{plan.goal.text}</p>}
              <div className="tv2-swap">
                {(Object.keys(GOAL_LABELS) as GoalStatus[])
                  .filter((status) => status !== plan.goal!.status)
                  .map((status) => (
                    <button
                      key={status}
                      type="button"
                      className="tv2-btn tv2-btn--tonal tv2-btn--sm"
                      disabled={locked}
                      onClick={() =>
                        onCommitOperation({
                          path: '/today/goal',
                          requestId: requestId(),
                          payload: { id: plan.goal!.id, expectedRev: plan.goal!.rev, status },
                        })
                      }
                    >
                      标记为{GOAL_LABELS[status]}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {plan.returning && plan.overview && (
        <div className="tv2-aux-item">
          <InlineToggle
            open={overviewOpen}
            onToggle={onToggleOverview}
            closed="回来后的掌握概况"
            opened="收起概况"
          />
          {overviewOpen && (
            <div className="tv2-why-basis">
              <p className="tv2-muted">
                保留较稳：{plan.overview.retained.map(cleanHumanText).filter(Boolean).join('、') || '暂无'}
              </p>
              <p className="tv2-muted">
                有所减弱：{plan.overview.faded.map(cleanHumanText).filter(Boolean).join('、') || '暂无'}
              </p>
              <p className="tv2-muted">
                尚待核对：{plan.overview.unknown.map(cleanHumanText).filter(Boolean).join('、') || '暂无'}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
