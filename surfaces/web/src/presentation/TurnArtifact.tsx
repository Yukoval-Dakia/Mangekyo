import { useRef, useState } from 'react';
import { drawingStroke } from '../../../shared/presentation/index.ts';
import { ApiError } from '../api';
import { assessmentMessage } from './artifact-assessment';
import { editorDrafts } from './editor-draft.ts';
import { ArtifactView } from './ArtifactView';
import { sendIntent, type ArtifactIntentV1, type ArtifactSnapshotV1 } from './session-artifacts';
import { StrokeFigure, type MountedStroke } from './graphics';

export type ApplySnapshot = (sent: ArtifactSnapshotV1, input: unknown) => void;

export function TurnArtifacts({ mounts, apply, live }: { mounts: ArtifactSnapshotV1[]; apply?: ApplySnapshot | undefined; live: boolean }) {
  let announcement = '';
  const drawings = new Map<string, MountedStroke[]>();
  const works: (ArtifactSnapshotV1 | { key: string; strokes: MountedStroke[] })[] = [];
  for (const mount of mounts) {
    const { view } = mount;
    const stroke = drawingStroke(view);
    if (!stroke || mount.predicting || mount.prediction || mount.submitted) {
      works.push(mount);
      continue;
    }
    const key = JSON.stringify([mount.sessionId, mount.turnId, view.drawingId, view.revision, stroke.scene.width, stroke.scene.height]);
    let strokes = drawings.get(key);
    if (!strokes) {
      strokes = [];
      drawings.set(key, strokes);
      works.push({ key, strokes });
    }
    strokes.push({ ...stroke, mountId: mount.mountId, title: view.title });
    announcement = `${view.title}，已画 ${strokes.length} 笔。${stroke.scene.description}`;
  }
  return <>
    {live && <span role="status" className="visually-hidden">{announcement}</span>}
    {works.map(work => 'strokes' in work
      ? <StrokeFigure key={work.key} strokes={work.strokes} />
      : <TurnArtifact key={JSON.stringify([work.sessionId, work.turnId, work.mountId])} snapshot={work} apply={apply} />)}
  </>;
}

export function TurnArtifact({ snapshot, apply }: { snapshot: ArtifactSnapshotV1; apply?: ApplySnapshot | undefined }) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState('');
  const [receipt, setReceipt] = useState('');
  const sending = useRef(false);
  const retry = useRef<ArtifactIntentV1 | undefined>(undefined);

  async function dispatch(intent: ArtifactIntentV1) {
    if (!apply || sending.current || snapshot.submitted) return;
    sending.current = true;
    setPending(true);
    setProblem('');
    retry.current = intent;
    try {
      const result = await sendIntent(snapshot, intent);
      const node = snapshot.view.sections
        .flatMap((section) => section.nodes)
        .find((n) => n.id === intent.action.nodeId);
      setReceipt(
        node?.kind === 'action' ? '服务器已接收「' + node.label + '」操作。' : '服务器已接收本次操作。',
      );
      retry.current = undefined;
      apply(snapshot, result.snapshot);
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) apply(snapshot, null);
      if (error instanceof ApiError && [401, 403, 404, 409].includes(error.status))
        apply(snapshot, undefined);
      if (error instanceof ApiError && error.status < 500) retry.current = undefined;
      setProblem(error instanceof ApiError ? error.message : '尚未收到回执，可重发原请求。');
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  return (
    <div className="turn-artifact">
      <fieldset inert={!apply} disabled={!apply || snapshot.submitted || pending} className="artifact-controls">
        <ArtifactView
          key={JSON.stringify([snapshot.viewSeq, snapshot.predicting])}
          drafts={apply ? editorDrafts : undefined}
          view={snapshot.view}
          mount={snapshot}
          hostState={snapshot.hostState}
          unavailable={snapshot.unavailable}
          saved={snapshot.saved}
          onAction={dispatch}
        />
      </fieldset>
      {snapshot.prediction && <p>当时的预测 · {snapshot.prediction.answer.text}</p>}
      {snapshot.commandId && (
        <p>
          {snapshot.submitted ? '已提交' : '已记录'} · 回执 {snapshot.commandId}
        </p>
      )}
      {problem && retry.current && <button onClick={() => dispatch(retry.current!)}>重发原请求</button>}
      <div className="artifact-status" role="status">
        {snapshot.assessment && <p><strong>{assessmentMessage(snapshot.assessment)}</strong></p>}
        {receipt && <p>{receipt}</p>}
        {pending && <p>正在等待操作回执…</p>}
        {problem && <p>{problem}</p>}
      </div>
    </div>
  );
}
