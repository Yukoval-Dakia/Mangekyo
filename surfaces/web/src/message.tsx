import { createContext, lazy, Suspense, useContext } from 'react';
import { ReadAloud } from './classroom-voice';
const MathText = lazy(() => import('./math-text'));

export const ReadReply = createContext(false);

export function Message({ text }: { text: string }) {
  return (
    <div className="turn-message formatted-reply">
      <Suspense fallback={<p>{text}</p>}>
        <MathText text={text} />
      </Suspense>
      {useContext(ReadReply) && <ReadAloud text={text} />}
    </div>
  );
}
