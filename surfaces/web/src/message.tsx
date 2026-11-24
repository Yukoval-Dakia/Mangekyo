import { createContext, lazy, Suspense, useContext } from 'react';
import { ReadAloud } from './classroom-voice';
import { stabilizeStreamingText } from './stream-delta';
import { stripCitationsText, stripPendingCiteTail, type IndexedCitation } from './shell/inline-citations';
const MathText = lazy(() => import('./math-text'));

export const ReadReply = createContext(false);

export function Message({
  text,
  streaming = false,
  citations,
  onNavigate,
}: {
  text: string;
  streaming?: boolean;
  citations?: ReadonlyMap<string, IndexedCitation> | undefined;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const displayed = streaming ? stripPendingCiteTail(stabilizeStreamingText(text)) : text;
  const fallbackText = stripCitationsText(displayed);
  return (
    <div className={`turn-message formatted-reply${streaming ? ' mk-streaming' : ''}`}>
      <Suspense fallback={<p>{fallbackText}</p>}>
        <MathText text={displayed} citations={citations} onNavigate={onNavigate} />
      </Suspense>
      {streaming && <span className="mk-stream-cursor" aria-hidden="true" />}
      {useContext(ReadReply) && <ReadAloud text={stripCitationsText(text)} />}
    </div>
  );
}
