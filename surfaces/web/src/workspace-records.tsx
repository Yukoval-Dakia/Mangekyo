import { RecordQuestionLink, teachingPage, type CurrentObject } from './current-record';
import { useEffect, useRef, useState } from 'react';
import { PageTitle, ReadState, useResource } from './workspace';
import { ConceptReading, FixedRecord } from './concept-reading';
import { BankPractice } from './bank-practice';
import MathText from './math-text';
import { attemptVerdictLabel, errorStageLabel, hypothesisStatusLabel, recordKindLabel, relationLabel } from './learning-labels.ts';
import { issueGraphQuickPaper, workspaceRecordFlow, type RecordFlowProvenance, type RecordFlowView, type RecordFlowMasteryLevel } from './api';
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

const ISSUED_PAPER_HREF = /^\/papers\/[0-9A-HJKMNP-TV-Z]{26}/;
const QUICK_PAPER_KINDS = new Set(['concept', 'method', 'archetype']);

function currentObjectOf(item: Detail | undefined): CurrentObject | undefined {
  if (!item || !Number.isSafeInteger(item.rev) || item.rev < 1) return;
  if (item.category === 'attempt' || item.kind === 'attempt') return { kind: 'attempt', id: item.id, rev: item.rev };
  if (teachingPage(item)) return { kind: 'page', id: item.id, rev: item.rev };
  return;
}

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

function provenanceBadge(entry: RecordFlowProvenance): string {
  const label = entry.originBadge?.trim();
  return label || '来源';
}

function provenanceMeta(entry: RecordFlowProvenance): string {
  const labels = [relationLabel(entry.relation), recordKindLabel(entry.kind)].filter((label): label is string => Boolean(label));
  return [...new Set(labels)].join(' · ');
}

function ProvenanceCard({ entry }: { entry: RecordFlowProvenance }) {
  const meta = provenanceMeta(entry);
  const body = (
    <>
      <div className="record-prov-card-head">
        <span className="m3e-tonal-chip m3e-tonal-chip--strong">{provenanceBadge(entry)}</span>
        {meta && <small className="record-prov-meta">{meta}</small>}
      </div>
      <strong className="record-prov-title">{entry.title}</strong>
      {entry.excerpt && <small className="record-prov-excerpt">{entry.excerpt}</small>}
    </>
  );
  return (
    <li className="m3e-seg-item record-prov-item" key={entry.id}>
      {entry.href ? (
        <a className="record-prov-link" href={entry.href}>{body}</a>
      ) : (
        <div className="record-prov-link record-prov-link--static">{body}</div>
      )}
    </li>
  );
}

function ProvenanceSection({ flow }: { flow: RecordFlowView }) {
  const provenance = flow.provenance ?? [];
  const derived = flow.derived ?? [];
  if (!provenance.length && !derived.length) {
    return (
      <section className="record-section record-prov-section" aria-label="数据溯源脉络">
        <div className="record-section-head">
          <strong>数据溯源</strong>
        </div>
        <p className="record-prov-empty">暂无登记的上游原件或派生来源。</p>
      </section>
    );
  }
  return (
    <section className="record-section record-prov-section" aria-label="数据溯源脉络">
      <div className="record-section-head">
        <strong>数据溯源</strong>
        <small>{provenance.length + derived.length} 条</small>
      </div>

      <div className="record-prov-band">
        <p className="record-prov-label">
          <span aria-hidden="true">↓</span> 来源 · 从哪来
        </p>
        {provenance.length > 0 ? (
          <ul className="m3e-seg-list record-prov-list">
            {provenance.map((entry) => <ProvenanceCard key={entry.id} entry={entry} />)}
          </ul>
        ) : (
          <p className="record-prov-empty">暂无登记的上游原件或派生来源。</p>
        )}
      </div>

      {derived.length > 0 && (
        <div className="record-prov-band">
          <p className="record-prov-label">
            <span aria-hidden="true">↑</span> 下游 · 流向哪
          </p>
          <ul className="m3e-seg-list record-prov-list">
            {derived.map((entry) => <ProvenanceCard key={entry.id} entry={entry} />)}
          </ul>
        </div>
      )}
    </section>
  );
}

function FlowPanel({ flow }: { flow: RecordFlowView }) {
  const mastery = flow.mastery;
  const evidenceTotal = mastery.evidenceCount;
  return (
    <aside className="record-flow-side" aria-label="数据流动脉络">
      <ProvenanceSection flow={flow} />
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
                    {item.errorStage && <span className="m3e-tonal-chip m3e-tonal-chip--amber">{errorStageLabel(item.errorStage)}</span>}
                    <span className="m3e-tonal-chip">{hypothesisStatusLabel(item.status)}</span>
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
                      {attemptVerdictLabel(attempt.verdict)}
                    </span>
                    {attempt.errorStage && <span className="m3e-tonal-chip">{errorStageLabel(attempt.errorStage)}</span>}
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
                    <small style={{ color: 'var(--muted)', fontSize: 11.5 }}>{[recordKindLabel(neighbor.kind), relationLabel(neighbor.relation)].filter((label): label is string => Boolean(label)).join(' · ')}</small>
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

function NextActionsBar({ flow, title, item, onNavigate }: { flow: RecordFlowView; title: string; item?: Detail | undefined; onNavigate?: ((href: string) => void) | undefined }) {
  const [issuing, setIssuing] = useState(false);
  const [notice, setNotice] = useState('');
  const busyRef = useRef(false);
  if (!flow.nextActions.length) return null;
  const firstMisconception = flow.misconceptions[0]?.summary;

  function navigateTo(href: string) {
    if (onNavigate) onNavigate(href);
    else window.location.assign(href);
  }

  async function quickPaper() {
    if (busyRef.current) return;
    busyRef.current = true;
    setIssuing(true);
    setNotice('');
    try {
      const result = await issueGraphQuickPaper(flow.identity.id);
      if (result.kind === 'paper' && result.href) {
        navigateTo(result.href);
        return;
      }
      setNotice(result.reason ?? '该知识点尚未收录可自测题，可以先看看概念脉络或交入练习。');
    } catch {
      setNotice('抽题暂时没有成功，可以打开概念脉络或稍后再试。');
    } finally {
      busyRef.current = false;
      setIssuing(false);
    }
  }

  return (
    <div className="record-flow-actions">
      {notice && (
        <p className="record-flow-notice" role="status">
          {notice}
        </p>
      )}
      <div className="m3e-floating-bar" role="toolbar" aria-label="这条学习记录的后续动作">
        {flow.nextActions.map((action) => {
          if (action.kind === 'ask_companion') {
            return (
              <button
                type="button"
                className="tv2-btn tv2-btn--tonal tv2-btn--sm"
                key={action.kind + action.href}
                onClick={() => {
                  const currentObject = currentObjectOf(item);
                  citeToCompanionDrawer({
                    title,
                    text: firstMisconception ? `错因：${firstMisconception}` : title,
                    focusLabel: title,
                    ...(currentObject ? { currentObject } : {}),
                  });
                }}
              >
                {nextActionGlyphs[action.kind]} {action.label}
              </button>
            );
          }
          if (action.kind === 'practice' && QUICK_PAPER_KINDS.has(flow.identity.kind) && !ISSUED_PAPER_HREF.test(action.href)) {
            return (
              <button
                type="button"
                className="tv2-btn tv2-btn--tonal tv2-btn--sm"
                key={action.kind + action.href}
                disabled={issuing}
                onClick={() => void quickPaper()}
              >
                {issuing ? '正在组题…' : `${nextActionGlyphs[action.kind]} ${action.label}`}
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
      {flow ? <NextActionsBar flow={flow} title={item.title} item={item} /> : null}
    </div>}
  </>;
}
