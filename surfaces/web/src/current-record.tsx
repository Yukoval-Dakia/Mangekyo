export type CurrentObject = {kind: 'attempt' | 'page'; id: string; rev: number};
export type BoundObject = {alias: 'current_attempt' | 'current_page'; id: string; rev: number};

function currentObject(kind: unknown, id: unknown, rev: unknown): CurrentObject | undefined {
  if ((kind === 'attempt' || kind === 'page') && typeof id === 'string' && id.trim() &&
      typeof rev === 'number' && Number.isSafeInteger(rev) && rev > 0) return {kind, id, rev};
  return undefined;
}

export function recordFromQuery(query: URLSearchParams) {
  return currentObject(query.get('record'), query.get('id'), Number(query.get('rev')));
}

export function recordFromSession(bound?: BoundObject) {
  if (!bound) return;
  const kind = {current_attempt: 'attempt', current_page: 'page'}[bound.alias];
  return currentObject(kind, bound.id, bound.rev);
}

export function RecordQuestionLink({kind, record}: {kind: CurrentObject['kind']; record: {id: string}}) {
  const ref = currentObject(kind, record.id, 'rev' in record && record.rev);
  if (!ref) return null;
  const query = new URLSearchParams({record: kind, id: ref.id, rev: String(ref.rev)});
  return <><a className="tonal-button" href={'/companion?' + query}>
    {kind === 'attempt' ? '就这次作答问同伴' : '就这条记录问同伴'}
  </a><a className="tonal-button" href={'/classroom?' + query}>用这{kind === 'attempt' ? '次作答' : '条记录'}开课</a></>;
}

export function teachingPage(item: {category?: string; kind?: string; teaching?: boolean}) {
  return item.teaching === true && (item.category === 'note' || item.category === 'textbook' || (item.category === 'entry' && item.kind === 'page'));
}

export function recordLabel(ref: CurrentObject) {
  return (ref.kind === 'attempt' ? '作答' : '笔记或页面') + ' · ' + ref.id + ' · 第 ' + ref.rev + ' 版';
}
