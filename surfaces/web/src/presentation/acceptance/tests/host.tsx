import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import {
  titration,
  passage,
  rhythm,
  predictionLab,
  openedPredictionLab,
} from '../../../../../shared/presentation/samples/examples.ts';
import type { ArtifactIntentV1, HostStateV1 } from '../../../../../shared/presentation/index.ts';
import { ArtifactView } from '../../ArtifactView.tsx';
import '../../../styles.css';

const scene = titration.sections.flatMap((s) => s.nodes).find((n) => n.kind === 'scene')!;
const giant = {
  ...titration,
  sections: [
    {
      id: 'oversize',
      title: '多场景',
      layout: 'stack',
      nodes: Array.from({ length: 8 }, (_, i) => ({
        ...scene,
        id: 'scene-' + i,
        objects: Array.from({ length: 90 }, (_, j) => ({
          kind: 'label',
          id: 'label-' + i + '-' + j,
          x: 0,
          y: 0,
          text: '刻度',
        })),
      })),
    },
  ],
};

function AcceptanceHost() {
  const index = Number(new URLSearchParams(location.search).get('case') || 0);
  const [interrupted, setInterrupted] = useState(false),
    [revoked, setRevoked] = useState(false);
  const [mountId, setMountId] = useState('mount-a');
  const [stateRev, setStateRev] = useState(0);
  const [sent, setSent] = useState<ArtifactIntentV1[]>([]);
  const last = sent.at(-1);
  function receive(request: ArtifactIntentV1) {
    setSent((history) => [...history, request]);
  }
  const mount = { mountId, stateRev };
  const hostState: HostStateV1 = {
    ...mount,
    version: 1,
    artifactId: predictionLab.id,
    revision: predictionLab.revision,
    logic: { id: 'prediction-phase', revision: 'r1' },
    inputs: { phase: stateRev === 0 ? 'predict' : 'experiment' },
  };
  const view = [
    titration,
    passage,
    rhythm,
    { ...passage, version: 2 },
    interrupted ? { ...passage, sections: [] } : passage,
    interrupted ? undefined : passage,
    stateRev === 0 ? predictionLab : openedPredictionLab,
    giant,
  ][index];
  return (
    <div style={{ maxWidth: 940, margin: '24px auto', padding: '0 12px' }}>
      {(index === 4 || index === 5) && (
        <button onClick={() => setInterrupted(!interrupted)}>
          {interrupted ? '恢复定义' : '中断更新'}
        </button>
      )}
      {index === 5 && (
        <>
          <button
            onClick={() => {
              setRevoked(!revoked);
              setSent([]);
            }}
          >
            {revoked ? '重新授权' : '撤回挂载'}
          </button>
          <button
            onClick={() => {
              setMountId(mountId === 'mount-a' ? 'mount-b' : 'mount-a');
              setSent([]);
            }}
          >
            切换挂载
          </button>
        </>
      )}
      <ArtifactView
        view={view}
        mount={revoked ? null : mount}
        hostState={hostState}
        onAction={receive}
      />
      {last && (
        <details open>
          <summary>宿主收到的动作</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {JSON.stringify(last, null, 2)}
          </pre>
          <output>发送次数 {sent.length}</output>
          <button onClick={() => receive(last)}>重发原请求</button>
          {index === 6 &&
            !stateRev &&
            last.action.nodeId === 'submit-prediction' &&
            last.action.answers.estimate?.kind === 'text' &&
            last.action.answers.estimate.text.trim() && (
              <button onClick={() => setStateRev(1)}>宿主确认预测</button>
            )}
        </details>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<AcceptanceHost />);
