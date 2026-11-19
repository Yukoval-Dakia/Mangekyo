import { useEffect, useMemo, useRef, useState } from 'react';
import {
  validateArtifact,
  type Interaction,
  type Answer,
  type Artifact,
  operationLocks,
  type ArtifactIntentV1,
  type ArtifactMount,
  type HostStateV1,
  type ArtifactAction,
  type ViewNode,
} from '../../../shared/presentation/index.ts';
import { requestId } from '../api.ts';
import { SceneFigure, CurveFigure, type Reading } from './graphics.tsx';
import { Asset, Audition, type ResolveAsset } from './media.tsx';
import './artifact.css';

export interface ArtifactViewProps {
  unavailable?: Record<string,string> | undefined;
  saved?: Pick<ArtifactAction,'answers'|'trace'>[] | undefined;
  view: unknown;
  mount: ArtifactMount | null;
  hostState?: HostStateV1 | undefined;
  onAction: (request: ArtifactIntentV1) => void;
  resolveAsset?: ResolveAsset;
}

function fallback(input: unknown) {
  if (
    input &&
    typeof input === 'object' &&
    'fallback' in input &&
    typeof input.fallback === 'string'
  ) {
    const text = input.fallback.slice(0, 2048);
    if (text.trim()) return text;
  }
  return '此版本暂时无法显示互动内容。';
}
export function ArtifactView({
  view,
  mount,
  onAction,
  resolveAsset,
  hostState, saved, unavailable,
}: ArtifactViewProps) {
  if (
    !mount ||
    typeof mount.mountId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(mount.mountId) ||
    !Number.isSafeInteger(mount.stateRev) ||
    mount.stateRev < 0
  )
    return <p role="status">此活动当前不可用。</p>;
  return (
    <Revision
      key={mount.mountId}
      unavailable={unavailable} saved={saved} view={view}
      mount={mount}
      hostState={hostState}
      onAction={onAction}
      resolve={resolveAsset}
    />
  );
}

function Revision({
  view,
  mount,
  hostState,
  onAction,
  resolve, saved, unavailable,
}: {
  saved: ArtifactViewProps["saved"];
  unavailable: ArtifactViewProps["unavailable"];
  view: unknown;
  mount: ArtifactMount;
  hostState: HostStateV1 | undefined;
  onAction: ArtifactViewProps['onAction'];
  resolve: ResolveAsset | undefined;
}) {
  const result = useMemo(() => validateArtifact(view), [view]);
  // A malformed refresh of this revision must not unmount its local draft.
  const [previous, setPrevious] = useState<Artifact | null>(null);
  useEffect(() => {
    if (result.ok) setPrevious(result.view);
  }, [result]);
  const definition = result.ok ? result.view : previous;
  if (!definition)
    return (
      <section className="av-sheet" aria-label="活动文字版">
        <h2>活动文字版</h2>
        <p>{fallback(view)}</p>
      </section>
    );
  return (
    <Editor
      key={JSON.stringify([definition.id, definition.revision])}
      mount={mount}
      hostState={hostState}
      unavailable={unavailable} saved={saved} view={definition}
      onAction={onAction}
      resolve={resolve}
      alternative={result.ok ? undefined : definition.fallback}
    />
  );
}

type Control = Extract<ViewNode, { kind: 'range' | 'selection' | 'note' }>;
function initial(n: Control): Answer {
  if (n.kind === 'selection') return { kind: 'selection', ids: [...n.selected] };
  if (n.kind === 'range') return { kind: 'quantity', value: n.values[n.initial]!, unit: n.unit };
  return { kind: 'text', text: '' };
}

function Editor({
  mount,
  hostState,
  view,
  onAction,
  resolve,
  alternative, saved, unavailable,
}: {
  saved: ArtifactViewProps["saved"];
  unavailable: ArtifactViewProps["unavailable"];
  mount: ArtifactMount;
  hostState: HostStateV1 | undefined;
  alternative: string | undefined;
  view: Artifact;
  onAction: ArtifactViewProps['onAction'];
  resolve: ResolveAsset | undefined;
}) {
  const locks = operationLocks(view, mount, hostState);
  for (const [id, reason] of Object.entries(unavailable ?? {})) locks.set(id,reason);
  const nodes = view.sections.flatMap((s) => s.nodes);
  const equivalents = new Set(nodes.filter((n) => n.kind === 'stepControl').map((n) => n.target));
  const stepTargets = new Map(
    nodes.flatMap((n) =>
      n.kind === 'scene'
        ? n.objects.filter((o) => o.kind === 'stepTarget').map((o) => [o.id, o] as const)
        : [],
    ),
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const [answers, setAnswers] = useState<Record<string, Answer>>(() =>
    Object.assign(Object.fromEntries(
      nodes
        .filter((n) => n.kind === 'range' || n.kind === 'selection' || n.kind === 'note')
        .map((n) => [n.id, initial(n)]),
    ), ...(saved ?? []).map(entry => entry.answers)),
  );
  const update = (id: string, value: Answer) => setAnswers((old) => ({ ...old, [id]: value }));
  const selected = (id: string) => {
    const a = answers[id];
    return a?.kind === 'selection' ? a.ids : [];
  };
  function read(id: string): Reading {
    const range = byId.get(id) as Extract<ViewNode, { kind: 'range' }>;
    const a = answers[id];
    return { range, index: a?.kind === 'quantity' ? range.values.indexOf(a.value) : range.initial };
  }
  const [restoredTrace] = useState(() => {
    // Each receipt contains cumulative edits for its declared inputs.
    let steps: Interaction[] = [];
    let omitted = 0;
    for (const entry of saved ?? []) {
      const retained = steps.filter(step => !Object.hasOwn(entry.answers,step.nodeId));
      steps = [...retained,...entry.trace.steps];
      omitted = Math.max(omitted,entry.trace.omitted,steps.length-128);
      steps = steps.slice(-128);
    }
    return {omitted,steps};
  });
  const trace = useRef<ArtifactAction['trace']>(restoredTrace);
  function record(step: Interaction) {
    if (trace.current.steps.length === 128) {
      trace.current.steps.shift();
      trace.current.omitted++;
    }
    trace.current.steps.push(step);
  }
  const pending = useRef(new Map<string, Interaction>());
  function settle(id: string) {
    const step = pending.current.get(id);
    if (step) {
      record(step);
      pending.current.delete(id);
    }
  }
  function move(id: string, index: number, objectId?: string) {
    if (locks.has(id)) return;
    const { range } = read(id);
    const value = range.values[Math.min(index, range.values.length - 1)]!;
    if (value === range.values[read(id).index]) return;
    const step = { kind: 'adjust' as const, nodeId: id, value, unit: range.unit };
    if (objectId) record({ ...step, objectId });
    else pending.current.set(id, step);
    update(id, { kind: 'quantity', value, unit: range.unit });
  }
  function dispatch(action: Extract<ViewNode, { kind: 'action' }>) {
    if (locks.has(action.id)) return;
    for (const id of pending.current.keys()) settle(id);
    const allowed = new Set(action.inputs);
    const payload = Object.fromEntries(action.inputs.map((id) => [id, answers[id]!]));
    onAction({
      version: 1,
      requestId: requestId(),
      mountId: mount.mountId,
      baseStateRev: mount.stateRev,
      action: {
        version: 1,
        artifactId: view.id,
        revision: view.revision,
        nodeId: action.id,
        intent: action.intent,
        trace: {
          omitted: trace.current.omitted,
          steps: structuredClone(trace.current.steps.filter((step) => allowed.has(step.nodeId))),
        },
        answers: structuredClone(payload),
      },
    });
  }
  function render(n: ViewNode) {
    switch (n.kind) {
      case 'text':
        return <p>{n.text}</p>;
      case 'steps':
        return (
          <ol className="av-steps">
            {n.items.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        );
      case 'scene':
        return (
          <SceneFigure
            node={n}
            read={read}
            locks={locks}
            equivalents={equivalents}
            advance={(id, objectId) => move(id, read(id).index + 1, objectId)}
          />
        );
      case 'stepControl': {
        const object = stepTargets.get(n.target)!;
        const { range, index } = read(object.source);
        return (
          <button
            type="button"
            className="tonal-button"
            disabled={locks.has(range.id) || index + 1 >= range.values.length}
            onClick={() => move(range.id, index + 1, object.id)}
          >
            {n.label}
          </button>
        );
      }
      case 'curve':
        return <CurveFigure node={n} reading={read(n.source)} />;
      case 'range': {
        const { index } = read(n.id);
        return (
          <label className="av-range">
            {n.label}
            <output>
              {n.values[index]} {n.unit}
            </output>
            <input
              type="range"
              disabled={locks.has(n.id)}
              min="0"
              max={n.values.length - 1}
              value={index}
              aria-valuetext={n.values[index] + ' ' + n.unit}
              onChange={(e) => move(n.id, Number(e.target.value))}
              onPointerUp={() => settle(n.id)}
              onKeyUp={() => settle(n.id)}
              onBlur={() => settle(n.id)}
            />
          </label>
        );
      }
      case 'note': {
        const a = answers[n.id];
        return (
          <label>
            {n.label}
            <textarea
              rows={2}
              maxLength={4096}
              value={a?.kind === 'text' ? a.text : ''}
              onChange={(e) => update(n.id, { kind: 'text', text: e.target.value })}
            />
          </label>
        );
      }
      case 'selection': {
        const ids = selected(n.id);
        return (
          <fieldset>
            <legend>{n.label}</legend>
            <div className={'av-' + n.layout}>
              {n.items.map((item, i) => {
                const on = ids.includes(item.id);
                const toggle = () => {
                  record({ kind: 'toggle', nodeId: n.id, objectId: item.id, selected: !on });
                  update(n.id, {
                    kind: 'selection',
                    ids: n.items
                      .filter((it) => (it.id === item.id ? !on : ids.includes(it.id)))
                      .map((it) => it.id),
                  });
                };
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-object={item.id}
                    aria-label={
                      n.layout === 'passage'
                        ? `第 ${i + 1} 字「${item.label}」后停顿`
                        : n.label + '第 ' + (i + 1) + ' 格'
                    }
                    aria-pressed={on}
                    onClick={toggle}
                  >
                    {item.label}
                    {n.layout === 'passage' && <span aria-hidden="true">{on ? '／' : '·'}</span>}
                  </button>
                );
              })}
              {n.tail}
            </div>
            <output>
              {n.layout === 'passage'
                ? n.items.map((it) => it.label + (ids.includes(it.id) ? '／' : '')).join('') +
                  n.tail
                : '落点　' +
                  (n.items
                    .filter((it) => ids.includes(it.id))
                    .map((it) => it.label)
                    .join('、') || '休止')}
            </output>
          </fieldset>
        );
      }
      case 'listen':
        return (
          <Audition
            bpm={n.bpm}
            label={n.label}
            lanes={n.lanes.map((id) =>
              (byId.get(id) as Extract<ViewNode, { kind: 'selection' }>).items.map((it) =>
                selected(id).includes(it.id),
              ),
            )}
          />
        );
      case 'asset':
        return <Asset id={n.assetId} label={n.label} media={n.media} resolve={resolve} />;
      case 'action':
        return (
          <button
            type="button"
            disabled={locks.has(n.id)}
            className="primary-button"
            onClick={() => dispatch(n)}
          >
            {n.label}
          </button>
        );
    }
  }
  if (alternative !== undefined)
    return (
      <section className="av-sheet" aria-label="活动文字版">
        <h2>{view.title}</h2>
        <p>{alternative}</p>
        <h3>当前作答</h3>
        {nodes.map((n) => {
          const a = answers[n.id];
          if (!a || !('label' in n)) return null;
          const value =
            a.kind === 'quantity'
              ? a.value + ' ' + a.unit
              : a.kind === 'text'
                ? a.text
                : n.kind === 'selection'
                  ? n.items
                      .filter((item) => a.ids.includes(item.id))
                      .map((i) => i.label + ' (' + i.id + ')')
                      .join('、')
                  : '';
          return (
            <p key={n.id}>
              {n.label} · {value || '未填写'}
            </p>
          );
        })}
        <p>互动内容暂不可用，恢复后可继续编辑。</p>
      </section>
    );
  return (
    <article className="av-sheet">
      <h2>{view.title}</h2>
      {view.sections.map((s) => (
        <section key={s.id}>
          <h3>{s.title}</h3>
          <div className={'av-nodes av-' + s.layout}>
            {s.nodes.map((n) => (
              <div key={n.id} data-node={n.id}>
                {render(n)}
                {locks.has(n.id) && <small>{locks.get(n.id)}</small>}
              </div>
            ))}
          </div>
        </section>
      ))}
    </article>
  );
}
