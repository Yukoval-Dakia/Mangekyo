import {useState, type ReactNode} from 'react';
import {Message} from './message';
import {PageTitle, ReadState, useResource} from './workspace';
import './concept-reading.css';

// Keep the server's complete reference, including any anchor and text revision, in the URL.
type Reference = {fact: {id: string; rev: number; type: string}};
type Item = {sourceRef: Reference; title: string; kind: string; exposure?: string};
const relationships = {
  prereq_of: '的先修概念',
  targets_concept: '',
  variant_of: '的变式',
};
type Edge = {
  id: string; rev: number; kind: keyof typeof relationships; scope: string;
  sourceRef: Reference; from: Reference; to: Reference; sources: Reference[];
};
type Graph = {items: Item[]; edges: (Edge & {hop: number})[]; truncated: boolean};
type Source = {rev: number; title: string; content: string | number | null};

function version(ref: Reference) {
  return ref.fact.id + ':' + ref.fact.rev;
}

function fixedLink(ref: Reference) {
  return '/materials/records/' + encodeURIComponent(ref.fact.id) + '?' +
    new URLSearchParams({ref: JSON.stringify(ref)});
}

function Relation({kind, from, to}: {kind: Edge['kind']; from: ReactNode; to: ReactNode}) {
  return <>{from} {kind === 'targets_concept' ? '考查' : '是'} {to}{relationships[kind]}</>;
}

function Results({conceptId, hops}: {conceptId: string; hops: number}) {
  const params = new URLSearchParams({conceptId, direction: 'both', hops: String(hops)});
  for (const kind of Object.keys(relationships)) params.append('edgeKinds', kind);
  const resource = useResource<Graph>('/workspace/access?' + params);
  const graph = resource.data;
  if (!graph || resource.error) return <ReadState resource={resource} />;
  const items = new Map(graph.items.map(item => [version(item.sourceRef), item]));
  function endpoint(ref: Reference) {
    return <a href={fixedLink(ref)}>{items.get(version(ref))?.title || '学习记录'} · 第 {ref.fact.rev} 版</a>;
  }
  return <>
    {!graph.edges.length && <p role="status">这个范围内暂无可读的概念关系或题目。</p>}
    {[1, 2].map(hop => {
      const edges = graph.edges.filter(edge => edge.hop === hop);
      if (!edges.length) return null;
      return <section key={hop}>
        <h3>{hop === 1 ? '第一跳 · 直接关联' : '第二跳 · 经由上一跳'}</h3>
        <ul className="read-list">{edges.map(edge => {
          const unknownExposure = [edge.from, edge.to].some(ref => items.get(version(ref))?.exposure === 'unknown');
          return <li key={edge.id}>
            <div><Relation kind={edge.kind} from={endpoint(edge.from)} to={endpoint(edge.to)} /></div>
            <small>{edge.scope}{unknownExposure && ' · 题目是否看过：未知'}</small>
            <a className="relation-source" href={fixedLink(edge.sourceRef)}>查看关系依据 · 第 {edge.rev} 版</a>
          </li>;
        })}</ul>
      </section>;
    })}
    {graph.truncated && <p role="status">关联较多，当前仅显示部分结果。</p>}
  </>;
}

export function ConceptReading({conceptId}: {conceptId: string}) {
  const [open, setOpen] = useState(false);
  const [hops, setHops] = useState(1);
  return <details className="concept-reading" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>先修概念、相关题与变式</summary>
    {open && <>
      <div className="filter-row" role="group" aria-label="关联范围">
        {[1, 2].map(n => <button key={n} aria-pressed={hops === n} onClick={() => setHops(n)}>
          {n === 1 ? '只看一跳' : '看到两跳'}
        </button>)}
      </div>
      <Results key={hops} conceptId={conceptId} hops={hops} />
    </>}
  </details>;
}

export function FixedRecord({id, refValue}: {id: string; refValue: string}) {
  const resource = useResource<Source | Edge>('/workspace/access/records/' + encodeURIComponent(id) +
    '?' + new URLSearchParams({ref: refValue, view: 'preview'}));
  const record = resource.error ? undefined : resource.data;
  const source = record && 'content' in record ? record : undefined;
  const edge = record && 'sources' in record ? record : undefined;
  const body = source?.content;
  return <>
    <PageTitle title={source?.title ?? (edge ? '关系依据' : '固定版资料')}
      {...(record ? {meta: '固定引用 · 第 ' + record.rev + ' 版'} : {})}>
      <a href="/materials/workspace">返回同伴工作区</a>
    </PageTitle>
    <ReadState resource={resource} />
    {source && <article className="companion-turn">{body != null && body !== '' ? <Message text={String(body)} /> : <p>暂无可预览的正文。</p>}</article>}
    {edge && <section className="concept-reading">
      <h2>{edge.scope}</h2>
      <p><Relation kind={edge.kind}
        from={<a href={fixedLink(edge.from)}>来源条目</a>}
        to={<a href={fixedLink(edge.to)}>目标条目</a>} /></p>
      <h3>引用资料</h3>
      <ul className="read-list">{edge.sources.map((ref, index) => <li key={version(ref)}>
        <a href={fixedLink(ref)}>资料 {index + 1} · 第 {ref.fact.rev} 版</a>
      </li>)}</ul>
    </section>}
  </>;
}
