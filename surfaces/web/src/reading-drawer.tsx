import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { WorkbookSourceQuestionRef } from '../../../modules/activity/workbook-values';
import { Icon } from './icons';
import { useResource, ReadState } from './workspace';
import { capsuleLabel, PaperReadingCapsule, type ReadingContextEntry } from './paper-reading-capsule';
import {
  CalcBindingStrip,
  useQuestionPresentation,
  type CalcArtifactBinding,
  type CalcBindingsFreezeVerification,
} from './workbook-presentation';
import './reading-drawer.css';

type ReadingItem = { id: string; label: string; content: ReactNode | ((unavailable: () => void) => ReactNode) };

function SourcePreview({ source }: { source: WorkbookSourceQuestionRef }) {
  const ref = { v: 1, fact: { ...source, type: 'activity.workspaceEntry' }, anchor: { kind: 'question', itemId: 'question' } };
  const params = new URLSearchParams({ view: 'preview', ref: JSON.stringify(ref) });
  const data = useResource<{ content: string | null }>('/workspace/access/records/' + encodeURIComponent(source.id) + '?' + params);
  return <><ReadState resource={data} />{data.data && !data.error && <p>{data.data.content ?? '当前没有可预览的题面。'}</p>}</>;
}

function DrawerPanel({ item, onClose, unavailable, children }: {
  item: ReadingItem; onClose: () => void; unavailable: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(
    <dialog className="reading-panel" ref={dialog} aria-labelledby={title} onClose={onClose}>
      <header>
        <h2 id={title}>{item.label}</h2>
        <button type="button" autoFocus className="icon-button" aria-label="返回当前题" onClick={() => dialog.current?.close()}>
          <Icon name="close" />
        </button>
      </header>
      <div className="reading-content">{typeof item.content === 'function' ? item.content(unavailable) : item.content}</div>
      {children}
    </dialog>, document.body);
}

export function ReadingDrawer({ items }: { items: ReadingItem[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const unavailable = useCallback(() => {
    if (selected) setHidden(ids => ids.includes(selected) ? ids : [...ids, selected]);
    setSelected(null);
  }, [selected]);
  const available = items.filter(entry => !hidden.includes(entry.id));
  const item = available.find(entry => entry.id === selected);
  if (selected !== null && !item) setSelected(null);
  const overflow = available.slice(3).filter(entry => entry !== item);
  if (!available.length) return null;
  return <>
    <div className="reading-capsules" role="group" aria-label="本题参考">
      {available.slice(0, 3).map(entry =>
        <button type="button" key={entry.id} aria-haspopup="dialog" onClick={event => {
          trigger.current = event.currentTarget;
          setSelected(entry.id);
        }}>
          {entry.label}<Icon name="chevron" />
        </button>)}
    </div>
    {item && <DrawerPanel key={item.id} item={item} unavailable={unavailable} onClose={() => {
      setSelected(null);
      trigger.current?.focus({ preventScroll: true });
    }}>
      {overflow.length > 0 && <div className="reading-content" role="group" aria-label="其他本题参考">
        {overflow.map(entry => <button type="button" className="text-button" key={entry.id}
          onClick={() => setSelected(entry.id)}>{entry.label}</button>)}
      </div>}
    </DrawerPanel>}
  </>;
}

export function QuestionContext({
  itemId,
  readingContext,
  source,
  previous,
  historical = false,
  referencesAllowed = true,
  calcBindings,
  calcVerification,
}: {
  itemId: string;
  readingContext?: ReadingContextEntry[] | undefined;
  historical?: boolean;
  referencesAllowed?: boolean;
  source?: WorkbookSourceQuestionRef | undefined;
  previous?: ReactNode;
  calcBindings?: readonly CalcArtifactBinding[] | undefined;
  calcVerification?: CalcBindingsFreezeVerification | undefined;
}) {
  const presentation = useQuestionPresentation(itemId);
  const items: ReadingItem[] = [];
  if (presentation && historical === Boolean(presentation.attempt)) {
    const initial = readingContext ?? [];
    const entries = [...(presentation.confirmed ?? initial)];
    // Keep surviving cold-read buttons in place when the snapshot brings additional choices.
    const position = (entry: ReadingContextEntry) => {
      const index = initial.findIndex(card => card?.kind === entry?.kind && card?.ref === entry?.ref);
      return index < 0 ? initial.length : index;
    };
    entries.sort((left, right) => position(left) - position(right));
    for (const entry of entries) {
      const label = entry && capsuleLabel(entry.kind);
      if (!label || typeof entry.ref !== 'string' || !entry.ref.trim() ||
          entries.filter(other => other?.kind === entry.kind).length !== 1) continue;
      const id = JSON.stringify([entry.kind, entry.ref]);
      items.push({ id, label, content: unavailable => <PaperReadingCapsule
        presentation={presentation} itemId={itemId} entry={entry} onUnavailable={unavailable} /> });
    }
  }
  // A later solution permit adds references without remounting an open question capsule.
  const scope = JSON.stringify([itemId, presentation?.paper.id, presentation?.paper.rev, presentation?.permit,
    presentation?.attempt?.id, presentation?.attempt?.rev, source?.id, source?.rev]);
  if (referencesAllowed && source) {
    items.push({ id: [source.id, source.rev].join('/'), label: '原题 · 第 ' + source.rev + ' 版',
      content: <SourcePreview source={source} /> });
  }
  if (referencesAllowed && previous) items.push({ id: 'answer', label: '回看这次作答', content: previous });
  const resolvedCalcBindings = calcBindings && calcBindings.length > 0 ? calcBindings : presentation?.calcBindings;
  const resolvedCalcVerification = calcVerification ?? presentation?.calcVerification;
  return (
    <>
      <ReadingDrawer key={scope} items={items} />
      {(resolvedCalcBindings?.length || resolvedCalcVerification) && (
        <CalcBindingStrip
          bindings={resolvedCalcBindings}
          verification={resolvedCalcVerification}
          label="本题冻结计算产物"
        />
      )}
    </>
  );
}
