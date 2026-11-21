import { useRef, useState } from 'react';
import { api, ApiError, submissionId } from './api';

import { useDraftWatermark } from './draft-watermark';

type QuestionRef = {id: string; rev: number};

export function BankPractice({source}: {source: QuestionRef}) {
  const watermark = useDraftWatermark();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const intent = useRef<string | null>(null);
  async function issue() {
    if (busy || !watermark.ready) return;
    setBusy(true);
    setError('');
    try {
      intent.current ??= submissionId();
      const paper = await api<{id: string}>('/iqdb/papers', {
        method: 'POST',
        body: {requestId: intent.current, sourceRef: source},
      });
      location.assign('/papers/' + encodeURIComponent(paper.id));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : '暂时无法确认是否已发卷，可以重试。');
      setBusy(false);
    }
  }
  return <>
    <button type="button" className="tonal-button" disabled={busy || !watermark.ready} onClick={issue}>
      {busy ? '正在开卷…' : '用这个版本开练'}
    </button>
    {error && <p role="alert">{error}</p>}
  </>;
}
