import { RecordQuestionLink, teachingPage } from './current-record';
import {useState} from 'react';
import {PageTitle, ReadState, useResource} from './workspace';
import {ConceptReading, FixedRecord} from './concept-reading';
import {Message} from './message';

type Entry = {id:string; kind?:string; rev:number; title:string; excerpt:string; author:string};
type Detail = Entry & {category?: string; teaching?: boolean; text:string; nextOffset:number|null; related?:{id:string;title:string}[];
  question?: {prompt:string;answer?:string;rubric?:string}};
const names: Record<string,string> = {question:'题目',page:'教材页',concept:'概念',relation:'概念关系',observation:'学情观察',annotation:'作答批注'};

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
  const item = resource.data;
  function preparePaper() {
    if (!item?.question) return;
    try {
      sessionStorage.setItem('mangekyo:paper-proposal',JSON.stringify({title:item.title,questions:[{...item.question, sourceQuestionRef:{id:item.id, rev:item.rev}}]}));
      location.assign('/papers/new?proposal=1');
    } catch { setProblem('浏览器暂时无法保存组卷草稿。'); }
  }
  return <><PageTitle title={item?.title ?? '学习记录'}><a href="/materials/workspace">返回同伴工作区</a></PageTitle>
    <ReadState resource={resource} />
    {item && <article className="companion-turn"><small>{names[item.kind ?? ''] ?? '学习记录'} · 第 {item.rev} 版 · {item.author === 'companion' ? '同伴创建' : '本人保存'}</small>
      {teachingPage(item) && <RecordQuestionLink kind="page" record={item} />}
      {item.question && <button type="button" className="tonal-button" onClick={preparePaper}>用这道题组卷</button>}
      <Message text={item.text} />
      {!!item.related?.length && <ul aria-label="关联记录">{item.related.map(link =>
        <li key={link.id}><a href={'/materials/records/'+link.id}>{link.title}</a></li>)}</ul>}
    </article>}
    {item?.kind === 'concept' && <ConceptReading conceptId={item.id} />}
    {problem && <p role="alert">{problem}</p>}
    {offset > 0 && <button className="text-button" onClick={() => setOffset(0)}>回到开头</button>}
    {item?.nextOffset != null && <button className="text-button" onClick={() => setOffset(item.nextOffset!)}>继续阅读</button>}
  </>;
}
