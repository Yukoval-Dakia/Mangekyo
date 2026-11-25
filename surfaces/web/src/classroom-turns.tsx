import { useEffect, useState } from 'react';
import { api, isCarePauseTurn, sessionPath, type Session } from './api';
import type { Classroom } from './classroom-contract';
import { useConversation } from './conversation';
import { ActivityReentry } from './activity-reentry';
import { TeachingTurn } from './demo';
import { ClassroomGenerationProgress } from './classroom-progress';
import { RecoveryGuide } from './recovery';

export function ClassroomLesson({room, visible, onOpenAiActivity}: {room: Classroom; visible: boolean; onOpenAiActivity?: (() => void) | undefined}) {
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
  return initial ? <BoundTurns room={room} initial={initial} visible={visible} onOpenAiActivity={onOpenAiActivity} /> : <p role="status">正在打开讲义…</p>;
}

const statusLabel = {pending: '待学', active: '当前步骤', presented: '已呈现', skipped: '已跳过'};

function BoundTurns({room, initial, visible, onOpenAiActivity}: {room: Classroom; initial: Session; visible: boolean; onOpenAiActivity?: (() => void) | undefined}) {
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
    {room.steps.length > 0 && <ol className="classroom-steps">{room.steps.map(step => {
      const current = room.status === 'active' && step.status === 'active' && room.activeStepId === step.id;
      const visible = step.status !== 'pending' && !!step.turnId;
      const turn = visible && session.turns.find(item => item.turnId === step.turnId);
      const carePause = turn && isCarePauseTurn(turn) ? turn : undefined;
      const live = current && visible && session.status === 'pending' && session.currentTurnId === step.turnId;
      const mounts = visible ? session.mounts.filter(m => m.turnId === step.turnId) : [];
      const anchor = 'classroom-step-' + step.id;
      const binding = JSON.stringify([room.id, room.rev, room.sessionId, step.id, step.turnId,
        mounts.map(m => [m.mountId, m.view.revision, m.viewSeq, m.stateRev])]);
      return <li key={step.id} id={anchor} tabIndex={-1} aria-current={current ? 'step' : undefined}>
        <p className="heading-meta">{statusLabel[step.status]}</p><h2>{step.title}</h2>
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
      </li>;
    })}</ol>}
  </>;
}
