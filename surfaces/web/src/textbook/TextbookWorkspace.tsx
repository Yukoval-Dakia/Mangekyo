import { outline, blockTitle } from './outline.ts';
import { useEffect, useRef, useState } from 'react';
import {
  fromHash,
  link,
  type Address,
  type Block,
  type Chapter,
  type Edit,
  type Slots,
  type Transport,
} from './contract.ts';
import { BlockTree, BodyView, Fields, blockNames, newBodies } from './blocks.tsx';
import './textbook.css';
import { useEditor } from './useEditor.ts';

type Props = {
  chapters: Chapter[];
  initialPage: string;
  draftScope: string;
  transport: Transport;
  slots?: Slots;
};
export function TextbookWorkspace(props: Props) {
  const [address, locate] = useState(() => fromHash(props.initialPage));
  useEffect(() => {
    const change = () => locate(fromHash(props.initialPage));
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, [props.initialPage]);
  const [expanded, expand] = useState(false);
  const [query, search] = useState('');
  return (
    <section className="tb-workspace" aria-label="个人教材">
      <button className="tb-toggle" aria-expanded={expanded} onClick={() => expand(!expanded)}>
        ☰　教材目录
      </button>
      <nav className={expanded ? 'tb-open' : ''} aria-label="教材目录">
        <div className="tb-book" aria-hidden="true">
          ▤
        </div>
        <h2>个人教材</h2>
        <input
          type="search"
          aria-label="查找教材页"
          placeholder="查找教材页"
          value={query}
          onChange={(e) => search(e.target.value)}
        />
        {props.chapters.map((c) => {
          const pages = c.pages.filter((p) => (c.title + p.title).includes(query));
          return (
            pages.length > 0 && (
              <section key={c.title}>
                <h3>{c.title}</h3>
                {pages.map((p) => (
                  <a
                    key={p.id}
                    aria-current={address.id === p.id ? 'page' : undefined}
                    href={link({ id: p.id })}
                    onClick={() => expand(false)}
                  >
                    {p.title}
                  </a>
                ))}
              </section>
            )
          );
        })}
      </nav>
      <Editor
        key={JSON.stringify([props.draftScope, address.id, address.rev])}
        {...props}
        address={address}
      />
    </section>
  );
}
function Editor({ address, transport, draftScope, slots, chapters }: Props & { address: Address }) {
  const {
    page,
    draft,
    edit,
    ready,
    busy,
    pinned,
    conflict,
    lastReceipt,
    notice,
    undo,
    save,
    stage,
    abandon,
    rebase,
    reread,
  } = useEditor(address, transport, draftScope);
  const { id } = address;
  const [filter, filterBy] = useState('');
  const container = useRef<HTMLElement>(null);
  const form = useRef<HTMLElement>(null);
  useEffect(() => {
    if (edit) form.current?.querySelector<HTMLElement>('textarea, input, select, button')?.focus();
  }, [edit?.blockId]);
  function start(change: Edit, original: Block | null) {
    container.current?.querySelectorAll<HTMLDetailsElement>('.tb-workspace details[open]').forEach((d) => {
      d.open = false;
    });
    stage(change, original);
  }
  const current = page?.blocks.find((b) => b.id === edit?.blockId);
  function describeMove(parent: string | null, before: string | null) {
    const name = (key: string) => {
      const target = page?.blocks.find((b) => b.id === key);
      return target ? blockTitle(target.body).slice(0, 24) : key;
    };
    return (
      (parent ? '移入「' + name(parent) + '」' : '页内顶层') +
      ' · ' +
      (before ? '放在「' + name(before) + '」前' : '放在同级末尾')
    );
  }
  const editable = !pinned && ready && !draft;
  const chapter = chapters.find((c) => c.pages.some((p) => p.id === id));
  const invalid =
    edit &&
    edit.kind !== 'move' &&
    ((edit.body.kind === 'text' && !edit.body.text.trim()) ||
      (edit.body.kind === 'formula' && !edit.body.latex.trim()));
  return (
    <main ref={container}>
      <header>
        <div className="tb-path">{chapter?.title ?? '个人教材'}</div>
        <h1>{page?.title ?? chapter?.pages.find((p) => p.id === id)?.title ?? '教材页'}</h1>
        {page && (
          <div className="tb-meta">
            <span>
              {pinned ? '固定版本' : '当前版本'} {page.rev}
            </span>
            <span>{page.blocks.length} 个块</span>
            {pinned && (
              <a href={link({ id, ...(address.block ? { block: address.block } : {}) })}>打开当前版</a>
            )}
          </div>
        )}
      </header>
      {page && (
        <div className="tb-tools">
          {slots?.practice?.(page)}
          {editable && (
            <details>
              <summary className="tb-primary">＋ 添加块</summary>
              <div className="tb-menu">
                {Object.entries(newBodies).map(([key, body]) => (
                  <button
                    key={key}
                    onClick={() =>
                      start(
                        {
                          kind: 'insert',
                          blockId: crypto.randomUUID(),
                          parentId: null,
                          beforeId: null,
                          body,
                        },
                        null,
                      )
                    }
                  >
                    {blockNames[body.kind]}
                  </button>
                ))}
              </div>
            </details>
          )}
          <details>
            <summary>页内目录</summary>
            <div className="tb-menu tb-index">
              <input
                aria-label="查找块"
                placeholder="查找块"
                value={filter}
                onChange={(e) => filterBy(e.target.value)}
              />
              {outline(page.blocks).entries.map(({ block: b, depth }) => {
                const label = blockTitle(b.body);
                return (
                  (label + b.id).includes(filter) && (
                    <a
                      key={b.id}
                      style={{ paddingInlineStart: 10 + Math.min(depth, 5) * 10 }}
                      href={link({ ...address, block: b.id })}
                      onClick={(e) => {
                        e.currentTarget.closest('details')!.open = false;
                        document.getElementById('tb-' + b.id)?.focus();
                      }}
                    >
                      {label}
                    </a>
                  )
                );
              })}
            </div>
          </details>
          {page &&
            slots?.revisions?.(page, (a) => {
              location.hash = link(a);
            })}
          {editable && undo?.rev === page.rev && (
            <button
              onClick={() => start(undo.edit, page.blocks.find((b) => b.id === undo.edit.blockId) ?? null)}
            >
              撤销上次修改
            </button>
          )}
        </div>
      )}
      {draft && edit && (
        <section className="tb-draft" ref={form} aria-label="本机草稿">
          <small>基于版本 {draft.base}</small>
          <h2>{conflict ? '合并版本冲突' : '本机草稿'}</h2>
          {conflict && page && (
            <section className="tb-compare">
              <div>
                <strong>原基版 {draft.base}</strong>
                {draft.original ? <BodyView body={draft.original.body} /> : '新增块'}
              </div>
              <div>
                <strong>当前版 {page.rev}</strong>
                {current ? (
                  <>
                    <BodyView body={current.body} />
                    {edit.kind === 'move' && (
                      <small>
                        父块 {current.parentId ?? '页内顶层'} · 同级第{' '}
                        {page.blocks
                          .filter((b) => b.parentId === current.parentId)
                          .findIndex((b) => b.id === current.id) + 1}{' '}
                        项
                      </small>
                    )}
                  </>
                ) : (
                  '此块不存在'
                )}
              </div>
            </section>
          )}
          {edit.kind === 'move' ? (
            <p>
              移动「{draft.original ? blockTitle(draft.original.body).slice(0, 24) : edit.blockId}」：
              {describeMove(edit.parentId, edit.beforeId)}
            </p>
          ) : (
            <>
              {edit.kind === 'insert' && (
                <label>
                  块类型
                  <select
                    value={edit.body.kind}
                    onChange={(e) =>
                      stage({ ...edit, body: newBodies[e.target.value as keyof typeof newBodies] }, null)
                    }
                  >
                    {Object.entries(newBodies).map(([key, body]) => (
                      <option key={key} value={key}>
                        {blockNames[body.kind]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <Fields body={edit.body} change={(body) => stage({ ...edit, body }, draft.original)} />
            </>
          )}
          <div className="tb-actions">
            {conflict ? (
              <button
                className="tb-primary"
                disabled={busy || (edit.kind === 'insert' ? !!current : !current)}
                onClick={rebase}
              >
                在当前版继续编辑
              </button>
            ) : (
              <button
                className="tb-primary"
                disabled={
                  !ready ||
                  busy ||
                  !!invalid ||
                  (lastReceipt?.seq === draft.seq && lastReceipt.category === '已形成提议')
                }
                onClick={save}
              >
                {busy ? '正在保存' : '保存修改'}
              </button>
            )}
            <button disabled={busy} onClick={abandon}>
              {conflict ? '采用当前版' : '放弃草稿'}
            </button>
          </div>
        </section>
      )}
      <output aria-live="polite">{notice}</output>
      {!ready && <button onClick={reread}>重新读取</button>}
      {address.block && page && !page.blocks.some((b) => b.id === address.block) && (
        <p>此版本中找不到指定块。</p>
      )}
      {page && <BlockTree page={page} editable={editable} pinned={pinned} slots={slots} stage={start} />}
      {page && slots?.review?.(page)}
      {lastReceipt && (
        <details className="tb-receipt">
          <summary>最近操作回执 · {lastReceipt.category}</summary>
          <p>
            编辑序号 {lastReceipt.seq} · 基于版本 {lastReceipt.base}
          </p>
          {lastReceipt.rev && (
            <a href={link({ id, rev: lastReceipt.rev, block: lastReceipt.block })}>
              查看回执版本 {lastReceipt.rev}
            </a>
          )}
        </details>
      )}
      {page && slots?.receipts?.(page)}
    </main>
  );
}
