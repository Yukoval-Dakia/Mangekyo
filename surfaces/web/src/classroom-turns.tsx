import { useEffect, useState } from 'react';
import { api, isCarePauseTurn, sessionPath, type Session } from './api';
import type { Classroom } from './classroom-contract';
import { useConversation } from './conversation';
import { ActivityReentry } from './activity-reentry';
import { TeachingTurn } from './demo';
import { ClassroomGenerationProgress } from './classroom-progress';
import { RecoveryGuide } from './recovery';

export function ClassroomLesson({
  room,
  visible,
  onOpenAiActivity,
  onAdvance,
  actionDisabled,
}: {
  room: Classroom;
  visible: boolean;
  onOpenAiActivity?: (() => void) | undefined;
  onAdvance?: (() => void) | undefined;
  actionDisabled?: boolean | undefined;
}) {
  const [initial, setInitial] = useState<Session>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void api<Session>(sessionPath(room.sessionId), {signal: controller.signal}).then(session => {
      if (session.id !== room.sessionId) throw new Error();
      if (!controller.signal.aborted) setInitial(session);
    }).catch(() => {if (!controller.signal.aborted) setError(true);});
    return () => controller.abort();
  }, [room.sessionId, attempt]);
  if (error) return <p role="alert">暂时无法读取这次课堂的内容。 <button onClick={() => setAttempt(n => n + 1)}>重试</button></p>;
  return initial ? (
    <BoundTurns
      room={room}
      initial={initial}
      visible={visible}
      onOpenAiActivity={onOpenAiActivity}
      onAdvance={onAdvance}
      actionDisabled={actionDisabled}
    />
  ) : <p role="status">正在打开讲义…</p>;
}

const statusLabel = {pending: '待学', active: '当前步骤', presented: '已呈现', skipped: '已跳过'};
const practiceStepPattern = /练|题|测|检|迁移|巩固|作答|验证/;
const isPracticeStep = (title: string) => practiceStepPattern.test(title);

function BoundTurns({
  room,
  initial,
  visible,
  onOpenAiActivity,
  onAdvance,
  actionDisabled,
}: {
  room: Classroom;
  initial: Session;
  visible: boolean;
  onOpenAiActivity?: (() => void) | undefined;
  onAdvance?: (() => void) | undefined;
  actionDisabled?: boolean | undefined;
}) {
  const chat = useConversation(initial.caseId, true, initial, false);
  const {session} = chat;
  if (!visible) return null;
  if (!session || chat.invalidated || chat.problem?.source === 'read')
    return <p role="alert">当前无法核对课堂内容。 <button onClick={chat.retry}>重新读取</button></p>;
  const visibleBoundTurnIds = new Set(
    room.steps
      .filter(step => step.status !== 'pending' && Boolean(step.turnId))
      .map(step => step.turnId as string),
  );
  const unboundCarePauseTurns = session.turns.filter(
    turn => isCarePauseTurn(turn) && (!turn.turnId || !visibleBoundTurnIds.has(turn.turnId)),
  );
  const activeIndex = room.steps.findIndex(
    step => room.status === 'active' && step.status === 'active' && room.activeStepId === step.id,
  );
  const completedCount = room.steps.filter(step => step.status === 'presented' || step.status === 'skipped').length;
  const railLabel = activeIndex >= 0
    ? `第 ${activeIndex + 1} / ${room.steps.length} 步`
    : `已完成 ${completedCount} / ${room.steps.length} 步`;
  return <>
    {session.status === 'failed' || session.status === 'unknown' ? (
        <RecoveryGuide
          status={session.status === 'unknown' ? 'unknown' : 'failed'}
          detail={session.error || '教学内容未能生成。'}
          onResend={chat.retry}
          resendLabel="重新核对"
        />
      )
      : !room.steps.length && session.status === 'pending' && (
        <ClassroomGenerationProgress
          active
          resetKey={session.id + ':' + (session.currentTurnId ?? 'open')}
          hasTurns={session.turns.length > 0}
          onOpenAiActivity={onOpenAiActivity}
        />
      )}
    {unboundCarePauseTurns.length > 0 && (
      <ol className="turns" aria-label="安全支持">
        {unboundCarePauseTurns.map((turn, index) => (
          <TeachingTurn key={turn.turnId ?? `care-pause-${index}`} answer="" turn={turn} />
        ))}
      </ol>
    )}
    {room.steps.length > 1 && (
      <nav className="classroom-step-rail" aria-label="课堂步骤脉络">
        <span className="classroom-step-rail-progress tnum">{railLabel}</span>
        <ol className="classroom-step-rail-list">
          {room.steps.map((step, index) => {
            const isCurrent = index === activeIndex;
            const practice = isPracticeStep(step.title);
            const jumpable = step.status === 'active' || step.status === 'presented';
            const inner = <>
              <span className="classroom-rail-num tnum">{index + 1}</span>
              <span className="classroom-rail-title">{step.title}</span>
              <span className={`classroom-rail-kind ${practice ? 'is-practice' : 'is-explain'}`}>
                {practice ? '独立练习' : '概念讲解'}
              </span>
            </>;
            return (
              <li key={step.id}>
                {jumpable ? (
                  <a
                    href={`#classroom-step-${step.id}`}
                    className="classroom-rail-item"
                    data-status={step.status}
                    aria-current={isCurrent ? 'step' : undefined}
                  >
                    {inner}
                  </a>
                ) : (
                  <span className="classroom-rail-item" data-status={step.status}>
                    {inner}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    )}
    {room.steps.length > 0 && <ol className="classroom-steps">{room.steps.map((step, index) => {
      const current = room.status === 'active' && step.status === 'active' && room.activeStepId === step.id;
      const visibleStep = step.status !== 'pending' && !!step.turnId;
      const turn = visibleStep && session.turns.find(item => item.turnId === step.turnId);
      const carePause = turn && isCarePauseTurn(turn) ? turn : undefined;
      const live = current && visibleStep && session.status === 'pending' && session.currentTurnId === step.turnId;
      const mounts = visibleStep ? session.mounts.filter(m => m.turnId === step.turnId) : [];
      const practice = isPracticeStep(step.title);
      const nextStep = current ? room.steps.slice(index + 1).find(item => item.status === 'pending') : undefined;
      const anchor = 'classroom-step-' + step.id;
      const binding = JSON.stringify([room.id, room.rev, room.sessionId, step.id, step.turnId,
        mounts.map(m => [m.mountId, m.view.revision, m.viewSeq, m.stateRev])]);
      return <li
        key={step.id}
        id={anchor}
        tabIndex={-1}
        className="classroom-step"
        data-status={step.status}
        data-current={current ? 'true' : undefined}
        data-kind={practice ? 'practice' : 'explain'}
        aria-current={current ? 'step' : undefined}
      >
        <header className="classroom-step-head">
          <span className="classroom-step-index tnum" aria-hidden="true">{index + 1}</span>
          <div className="classroom-step-title-wrap">
            <div className="classroom-step-meta">
              <span className="heading-meta">{statusLabel[step.status]}</span>
              <span className={`m3e-tonal-chip ${practice ? 'm3e-tonal-chip--amber' : 'm3e-tonal-chip--quiet'}`}>
                {practice ? '独立练习' : '概念讲解'}
              </span>
            </div>
            <h2>{step.title}</h2>
          </div>
        </header>
        {current && turn && room.generation === 'ready' && chat.mountsConfirmed &&
          <ActivityReentry key={binding} slot={'classroom:' + room.id} binding={binding} itemId={step.id}
            label={'上次停在「' + step.title + '」'} onContinue={() => {
              const target = document.getElementById(anchor);
              (target?.querySelector<HTMLElement>('textarea:enabled, input:enabled') ?? target)?.focus();
            }} />}
        {carePause ? <ol className="turns"><TeachingTurn answer="" turn={carePause} message={carePause.message}
          progress={live ? chat.progressLabel : undefined} mounts={mounts} applySnapshot={chat.applySnapshot} chat={chat} /></ol>
        : (turn || live || mounts.length > 0) && <fieldset className="classroom-work" disabled={!current}>
          <ol className="turns"><TeachingTurn answer="" turn={turn || undefined} message={turn ? turn.message : live ? chat.streamingReply : undefined}
            progress={live ? chat.progressLabel : undefined} mounts={mounts} applySnapshot={chat.applySnapshot} chat={chat} /></ol>
        </fieldset>}
        {current && !carePause && !live && turn && (
          <div className="classroom-handoff-bar">
            {nextStep ? (
              <>
                <p className="classroom-handoff-copy">
                  {isPracticeStep(nextStep.title)
                    ? <>听懂这一步的直觉与例题后，接下来进入独立练习：<strong>{nextStep.title}</strong></>
                    : <>这一步讲透后，接下来继续：<strong>{nextStep.title}</strong></>}
                </p>
                {onAdvance && (
                  <button
                    type="button"
                    className="tonal-button"
                    disabled={actionDisabled}
                    onClick={onAdvance}
                  >
                    进入下一步 →
                  </button>
                )}
              </>
            ) : (
              <p className="classroom-handoff-copy">这是本节课的最后一步；理解透彻后可在下方结束这节课。</p>
            )}
          </div>
        )}
      </li>;
    })}</ol>}
  </>;
}
