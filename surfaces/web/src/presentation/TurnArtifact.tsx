import { useRef, useState } from 'react';
import { ApiError } from '../api';
import { ArtifactView } from './ArtifactView';
import { sendIntent, type ArtifactIntentV1, type ArtifactSnapshotV1 } from './session-artifacts';

export type ApplySnapshot = (sent: ArtifactSnapshotV1, input: unknown) => void;

export function TurnArtifact({ snapshot, apply }: { snapshot: ArtifactSnapshotV1; apply: ApplySnapshot }) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState('');
  const [receipt, setReceipt] = useState('');
  const sending = useRef(false);
  const retry = useRef<ArtifactIntentV1 | undefined>(undefined);

  async function dispatch(intent: ArtifactIntentV1) {
    if (sending.current || snapshot.submitted) return;
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
      <fieldset disabled={snapshot.submitted || pending} className="artifact-controls">
        <ArtifactView
          key={String(snapshot.predicting)}
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
        {receipt && <p>{receipt}</p>}
        {pending && <p>正在等待操作回执…</p>}
        {problem && <p>{problem}</p>}
      </div>
    </div>
  );
}
