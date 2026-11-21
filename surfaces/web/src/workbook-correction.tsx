import { useRef, useState } from 'react';
import { api, deletedSubmission, submissionId } from './api';

export function WorkbookCorrection({ paperId, attemptId, attemptRev, itemId, recorded }: {
  paperId: string; attemptId: string; attemptRev: number; itemId: string; recorded: boolean;
}) {
  const request = useRef('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'erased'>('idle');
  const [error, setError] = useState('');
  async function save() {
    if (state !== 'idle') return;
    setState('saving');
    setError('');
    try {
      request.current ||= submissionId();
      await api(`/papers/${paperId}/attempts/${attemptId}/corrections`, {
        method: 'POST', body: { requestId: request.current, attemptRev, itemId },
      });
      setState('saved');
    } catch (error) {
      const erased = deletedSubmission(error);
      setState(erased ? 'erased' : 'idle');
      setError(erased ? '删除状态已变化，请重新打开原作答。' : '未能记录订正。请重新打开原作答或重试。');
    }
  }
  if (recorded || state === 'saved') return <p role="status" className="muted">已记录订正</p>;
  return <div>
    <button type="button" className="tonal-button" disabled={state !== 'idle'} onClick={() => void save()}>
      {state === 'saving' ? '正在记录…' : '我已订正'}
    </button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
