import { createContext, lazy, Suspense, useContext } from 'react';
import { ReadAloud } from './classroom-voice';
import { stabilizeStreamingText } from './stream-delta';
const MathText = lazy(() => import('./math-text'));

export const ReadReply = createContext(false);

export function Message({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const displayed = streaming ? stabilizeStreamingText(text) : text;
  return (
    <div className={`turn-message formatted-reply${streaming ? ' mk-streaming' : ''}`}>
      <Suspense fallback={<p>{displayed}</p>}>
        <MathText text={displayed} />
      </Suspense>
      {streaming && <span className="mk-stream-cursor" aria-hidden="true" />}
      {useContext(ReadReply) && <ReadAloud text={text} />}
    </div>
  );
}
