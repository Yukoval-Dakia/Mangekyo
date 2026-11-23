import { RecordQuestionLink, teachingPage } from './current-record';
import { useEffect, useState } from 'react';
import { PageTitle, ReadState, useResource } from './workspace';
import { ConceptReading, FixedRecord } from './concept-reading';
import { BankPractice } from './bank-practice';
import MathText from './math-text';
import { workspaceRecordFlow, type RecordFlowView, type RecordFlowMasteryLevel } from './api';
import { citeToCompanionDrawer } from './shell/AppShell';
import './workspace-records.css';

type Entry = {id:string; kind?:string; rev:number; title:string; excerpt:string; author:string};
type Detail = Entry & {type?: string; category?: string; teaching?: boolean; text:string; nextOffset:number|null; related?:{id:string;title:string}[];
  question?: {prompt:string;answer?:string;rubric?:string}};
const names: Record<string,string> = {question:'题目',page:'教材页',concept:'概念',relation:'概念关系',observation:'学情观察',annotation:'作答批注'};

const masteryLabels: Record<RecordFlowMasteryLevel, string> = {
  unknown: '待摸底',
  fragile: '待巩固',
  developing: '进阶中',
  solid: '稳固',
};

const masteryTones: Record<RecordFlowMasteryLevel, string> = {
  unknown: 'neutral',
  fragile: 'amber',
  developing: 'strong',
  solid: 'strong',
};

const nextActionGlyphs: Record<RecordFlowView['nextActions'][number]['kind'], string> = {
  practice: '练',
  review_mistake: '核',
  ask_companion: '问',
  open_graph: '图',
};

function masteryRingFill(level: RecordFlowMasteryLevel): number {
  if (level === 'solid') return 0.88;
  if (level === 'developing') return 0.56;
  if (level === 'fragile') return 0.26;
  return 0.06;
}

function MasteryRing({ level }: { level: RecordFlowMasteryLevel }) {
  const size = 44;
  const r = 17;
  const circumference = 2 * Math.PI * r;
  const fill = masteryRingFill(level);
  return (
    <span className="m3e-ring" style={{ ['--m3e-ring-size' as string]: size + 'px' }} role="img" aria-label={masteryLabels[level]}>
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle className="m3e-ring-track" cx="22" cy="22" r={r} />
        <circle
          className="m3e-ring-fill"
          cx="22"
          cy="22"
          r={r}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fill)}
          style={{ ['--m3e-ring-fill' as string]: level === 'fragile' ? 'var(--m3e-amber)' : 'var(--primary)' }}
        />
      </svg>
      <span className="m3e-ring-label">{Math.round(fill * 100)}</span>
    </span>
  );
}

function useRecordFlow(id: string | undefined) {
  const [flow, setFlow] = useState<RecordFlowView | null>(null);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    workspaceRecordFlow(id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setFlow(result);
      })
      .catch(() => {
        // 404 / 网络失败时优雅降级：仅正文展示，不渲染脉络面板。
      });
    return () => controller.abort();
  }, [id]);
  return flow;
}

function FlowPanel({ flow }: { flow: RecordFlowView }) {
  const mastery = flow.mastery;
  const evidenceTotal = mastery.evidenceCount;
  return (
    <aside className="record-flow-side" aria-label="数据流动脉络">
      <section className="record-section" aria-label="掌握度与记忆保持">
        <div className="record-section-head">
          <strong>掌握度</strong>
          <small>{evidenceTotal} 条证据</small>
        </div>
        <div className="record-mastery-row">
          <MasteryRing level={mastery.level} />
          <div className="record-mastery-copy">
            <strong>{masteryLabels[mastery.level]}</strong>
            <small>
              {mastery.score !== null ? `掌握 ${Math.round(mastery.score * 100)}%` : '掌握度待摸底'}
              {mastery.retrievability !== null ? ` · 保持 ${Math.round(mastery.retrievability * 100)}%` : ''}
            </small>
          </div>
        </div>
      </section>

      {flow.misconceptions.length > 0 && (
        <section className="record-section" aria-label="关联错因与失分环节">
          <div className="record-section-head">
            <strong>关联错因</strong>
            <small>{flow.misconceptions.length} 条</small>
          </div>
          <ul className="m3e-seg-list">
            {flow.misconceptions.map((item) => (
              <li className="m3e-seg-item" key={item.id}>
                <div style={{ padding: '8px 10px', display: 'grid', gap: 4 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {item.errorStage && <span className="m3e-tonal-chip m3e-tonal-chip--amber">{item.errorStage}</span>}
                    <span className="m3e-tonal-chip">{item.status === 'active' ? '活跃' : item.status}</span>
                    {item.supportCount > 0 && <span className="m3e-tonal-chip">支持 {item.supportCount}</span>}
                    {item.contradictCount > 0 && <span className="m3e-tonal-chip">反驳 {item.contradictCount}</span>}
                  </div>
                  <span style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink)' }}>{item.summary}</span>
                  {item.evidenceHref && (
                    <a href={item.evidenceHref} style={{ color: 'var(--primary)', fontSize: 12.5, fontWeight: 600 }}>
                      直达证据源
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {flow.attempts.length > 0 && (
        <section className="record-section" aria-label="做题记录">
          <div className="record-section-head">
            <strong>做题记录</strong>
            <small>{flow.attempts.length} 条</small>
          </div>
          <ul className="record-timeline">
            {flow.attempts.map((attempt) => (
              <li key={attempt.attemptId + ':' + attempt.itemId} data-verdict={attempt.verdict}>
                <a href={attempt.href} style={{ color: 'inherit' }}>
                  <strong style={{ fontSize: 13 }}>{attempt.paperTitle}</strong>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 3 }}>
                    <span className={'m3e-tonal-chip ' + (attempt.verdict === 'correct' ? 'm3e-tonal-chip--strong' : attempt.verdict === 'incorrect' ? 'm3e-tonal-chip--amber' : '')}>
                      {attempt.verdict === 'correct' ? '答对' : attempt.verdict === 'incorrect' ? '答错' : attempt.verdict}
                    </span>
                    {attempt.errorStage && <span className="m3e-tonal-chip">{attempt.errorStage}</span>}
                    {attempt.scoreText && <span className="m3e-tonal-chip">{attempt.scoreText}</span>}
                  </div>
                  {attempt.occurredAt && (
                    <small style={{ display: 'block', marginTop: 3, color: 'var(--muted)', fontSize: 11.5 }}>
                      {new Date(attempt.occurredAt).toLocaleString('zh-CN')}
                    </small>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {flow.graphNeighbors.length > 0 && (
        <section className="record-section" aria-label="知识图谱上下游">
          <div className="record-section-head">
            <strong>图谱脉络</strong>
            <small>{flow.graphNeighbors.length} 个节点</small>
          </div>
          <ul className="m3e-seg-list">
            {flow.graphNeighbors.map((neighbor) => (
              <li className="m3e-seg-item" key={neighbor.id + ':' + neighbor.direction}>
                <a href={neighbor.href} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', color: 'inherit' }}>
                  <span className="m3e-tonal-chip" aria-hidden="true">{neighbor.direction === 'in' ? '前置' : '延伸'}</span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <strong style={{ display: 'block', fontSize: 13, overflowWrap: 'anywhere' }}>{neighbor.title}</strong>
                    <small style={{ color: 'var(--muted)', fontSize: 11.5 }}>{neighbor.kind} · {neighbor.relation}</small>
                  </span>
                  <span aria-hidden="true" style={{ color: 'var(--muted)', flex: 'none' }}>{neighbor.direction === 'in' ? '→' : '↗'}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {flow.discussions.length > 0 && (
        <section className="record-section" aria-label="关联同伴对话">
          <div className="record-section-head">
            <strong>关联对话</strong>
            <small>{flow.discussions.length} 条</small>
          </div>
          <ul className="m3e-seg-list">
            {flow.discussions.map((item) => (
              <li className="m3e-seg-item" key={item.sessionId + ':' + item.turnId}>
                <a href={item.href} style={{ display: 'grid', gap: 3, padding: '8px 10px', color: 'inherit' }}>
                  <strong style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{item.title}</strong>
                  <small style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{item.excerpt}</small>
                  {item.occurredAt && (
                    <small style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                      {new Date(item.occurredAt).toLocaleString('zh-CN')}
                    </small>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

function NextActionsBar({ flow, title }: { flow: RecordFlowView; title: string }) {
  if (!flow.nextActions.length) return null;
  const firstMisconception = flow.misconceptions[0]?.summary;
  return (
    <div className="record-flow-actions">
      <div className="m3e-floating-bar" role="toolbar" aria-label="这条学习记录的后续动作">
        {flow.nextActions.map((action) => {
          if (action.kind === 'ask_companion') {
            return (
              <button
                type="button"
                className="tv2-btn tv2-btn--tonal tv2-btn--sm"
                key={action.kind + action.href}
                onClick={() =>
                  citeToCompanionDrawer({
                    title,
                    text: firstMisconception ? `错因：${firstMisconception}` : title,
                  })
                }
              >
                {nextActionGlyphs[action.kind]} {action.label}
              </button>
            );
          }
          return (
            <a className="tv2-btn tv2-btn--tonal tv2-btn--sm" key={action.kind + action.href} href={action.href}>
              {nextActionGlyphs[action.kind]} {action.label}
            </a>
          );
        })}
      </div>
    </div>
  );
}

export function WorkspaceLibrary() {
  const [search,setSearch] = useState('');
  const [query,setQuery] = useState('');
  const [cursor,setCursor] = useState('');
  const [kind,setKind] = useState(() => new URLSearchParams(location.search).get('kind') ?? '');
  const resource = useResource<{items:Entry[]; nextCursor:string|null}>('/workspace/access?category=entry&kind='+encodeURIComponent(kind)+'&query=' + encodeURIComponent(query) + '&cursor=' + encodeURIComponent(cursor));
  return <><PageTitle title="同伴工作区"><a href="/materials">返回材料</a></PageTitle>
    <form className="library-actions" onSubmit={event => {event.preventDefault(); setCursor(''); setQuery(search);}}>
      <label className="field"><span>查找题目、教材、学情和概念关系</span><input value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label className="field"><span>类别</span><select value={kind} onChange={event => {setCursor(''); setKind(event.target.value);}}>
        <option value="">全部</option>{Object.entries(names).map(([value,label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      <button className="text-button">查找</button>
    </form><ReadState resource={resource} />
    <ul className="read-list">{resource.data?.items.map(item => <li key={item.id}>
      <small>{names[item.kind ?? ''] ?? '记录'} · 第 {item.rev} 版</small>
      <div><a href={'/materials/records/'+item.id}>{item.title}</a></div><p>{item.excerpt}</p>
    </li>)}</ul>
    {resource.data?.items.length === 0 && <p>没有找到对应的学习条目。</p>}
    {cursor && <button className="text-button" onClick={() => setCursor('')}>返回第一页</button>}
    {resource.data?.nextCursor && <button className="text-button" onClick={() => setCursor(resource.data!.nextCursor!)}>下一页</button>}
  </>;
}

export function WorkspaceRecord({id}:{id:string}) {
  const refValue = new URLSearchParams(location.search).get('ref');
  return refValue === null ? <CurrentRecord id={id} /> : <FixedRecord id={id} refValue={refValue} />;
}

function CurrentRecord({id}:{id:string}) {
  const [offset,setOffset] = useState(0);
  const [problem,setProblem] = useState('');
  const resource = useResource<Detail>('/workspace/access/records/'+encodeURIComponent(id)+'?offset='+offset);
  const flow = useRecordFlow(id);
  const item = resource.error ? undefined : resource.data;
  function preparePaper() {
    if (!item?.question) return;
    try {
      sessionStorage.setItem('mangekyo:paper-proposal',JSON.stringify({title:item.title,questions:[{...item.question, sourceQuestionRef:{id:item.id, rev:item.rev}}]}));
      location.assign('/papers/new?proposal=1');
    } catch { setProblem('浏览器暂时无法保存组卷草稿。'); }
  }
  return <><PageTitle title={item?.title ?? '学习记录'}><a href="/materials/workspace">返回同伴工作区</a></PageTitle>
    <ReadState resource={resource} />
    {item && <div className="record-flow">
      <div className="record-flow-main">
        <article className="record-identity" aria-label="记录身份">
          <div className="record-identity-copy">
            <strong>{item.title}</strong>
            <small>{names[item.kind ?? ''] ?? '学习记录'} · 第 {item.rev} 版 · {item.author === 'companion' ? '同伴创建' : '本人保存'}</small>
          </div>
          {flow && <span className={'m3e-tonal-chip ' + (masteryTones[flow.mastery.level] === 'amber' ? 'm3e-tonal-chip--amber' : flow.mastery.level === 'unknown' ? '' : 'm3e-tonal-chip--strong')}>
            {masteryLabels[flow.mastery.level]}
          </span>}
        </article>

        <article className="record-body" aria-label="记录正文">
          {teachingPage(item) && <RecordQuestionLink kind="page" record={item} />}
          {item.type === 'content.asset' && item.kind === 'question' && item.teaching &&
            <BankPractice key={item.id + ':' + item.rev} source={{id: item.id, rev: item.rev}}/>}
          {item.question && <button type="button" className="tonal-button" onClick={preparePaper}>用这道题组卷</button>}
          <MathText text={item.text} />
          {!!item.related?.length && <ul className="record-related-list" aria-label="关联记录">{item.related.map(link =>
            <li key={link.id}><a href={'/materials/records/'+link.id}>{link.title}</a></li>)}</ul>}
        </article>
        {item?.kind === 'concept' && <ConceptReading conceptId={item.id} />}
        {problem && <p role="alert">{problem}</p>}
        {offset > 0 && <button className="text-button" onClick={() => setOffset(0)}>回到开头</button>}
        {item?.nextOffset != null && <button className="text-button" onClick={() => setOffset(item.nextOffset!)}>继续阅读</button>}
      </div>
      {flow ? <FlowPanel flow={flow} /> : null}
      {flow ? <NextActionsBar flow={flow} title={item.title} /> : null}
    </div>}
  </>;
}
