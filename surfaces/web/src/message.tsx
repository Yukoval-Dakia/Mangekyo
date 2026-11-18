import { lazy, Suspense } from 'react';
const MathText = lazy(() => import('./math-text'));

export function Message({ text }: { text: string }) {
  return (
    <div className="turn-message formatted-reply">
      <Suspense fallback={<p>{text}</p>}>
        <MathText text={text} />
      </Suspense>
    </div>
  );
}
