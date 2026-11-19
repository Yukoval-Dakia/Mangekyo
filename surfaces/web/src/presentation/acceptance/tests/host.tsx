import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { titration, passage, rhythm } from '../../../../../shared/presentation/samples/examples.ts';
import type { ArtifactAction } from '../../../../../shared/presentation/index.ts';
import { ArtifactView } from '../../ArtifactView.tsx';
import '../../../styles.css';

function AcceptanceHost() {
  const index = Number(new URLSearchParams(location.search).get('case') || 0);
  const [interrupted, setInterrupted] = useState(false);
  const view = [
    titration,
    passage,
    rhythm,
    { ...passage, version: 2 },
    interrupted ? { ...passage, sections: [] } : passage,
  ][index];
  const [last, receive] = useState<ArtifactAction>();
  return (
    <div style={{ maxWidth: 940, margin: '24px auto', padding: '0 12px' }}>
      {index === 4 && (
        <button type="button" onClick={() => setInterrupted(!interrupted)}>
          {interrupted ? '恢复定义' : '模拟无效更新'}
        </button>
      )}
      <ArtifactView view={view} onAction={receive} />
      {last && (
        <details open>
          <summary>宿主收到的动作</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {JSON.stringify(last, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<AcceptanceHost />);
