import { outline } from './outline.ts';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { Block, Body, Edit, Page, Slots } from './contract.ts';
import { link } from './contract.ts';

export const blockNames = {
  text: '正文',
  list: '列表',
  table: '表格',
  formula: '公式',
  image: '原图',
  reference: '引用',
  related: '关联视图',
};
export const newBodies = {
  text: { kind: 'text', text: '' },
  list: { kind: 'list', order: 'bullet' },
  formula: { kind: 'formula', latex: '' },
  table: {
    kind: 'table',
    rows: [
      ['', ''],
      ['', ''],
    ],
  },
} satisfies Record<string, Body>;

export function BodyView({ body }: { body: Body }) {
  switch (body.kind) {
    case 'text':
      return <p className="tb-text">{body.text}</p>;
    case 'formula':
      return (
        <div
          className="tb-formula"
          dangerouslySetInnerHTML={{
            __html: katex.renderToString(body.latex, {
              displayMode: true,
              trust: false,
              throwOnError: false,
              maxSize: 10,
            }),
          }}
        />
      );
    case 'list':
      return <strong>{body.order === 'number' ? '步骤列表' : '要点列表'}</strong>;
    case 'table':
      return (
        <div className="tb-grid">
          <table>
            <tbody>
              {body.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'image':
      return <strong>{body.alt}</strong>;
    case 'reference':
      return <strong>{{ work: '我的旧作', question: '关联题目', citation: '资料来源' }[body.role]}</strong>;
    case 'related':
      return (
        <strong>
          {body.target === 'work' ? '相关旧作' : '相关题目'} · {body.allOf.map((c) => c.id).join('、')}
        </strong>
      );
  }
}
export function Fields({ body, change }: { body: Body; change: (body: Body) => void }) {
  switch (body.kind) {
    case 'text':
    case 'formula':
      return (
        <label>
          {blockNames[body.kind]}
          <textarea
            aria-label={blockNames[body.kind]}
            value={body.kind === 'text' ? body.text : body.latex}
            onChange={(e) =>
              change(
                body.kind === 'text'
                  ? { kind: 'text', text: e.target.value }
                  : { kind: 'formula', latex: e.target.value },
              )
            }
          />
        </label>
      );
    case 'list':
      return (
        <label>
          条目标记
          <select
            aria-label="条目标记"
            value={body.order}
            onChange={(e) =>
              change({ kind: 'list', order: e.target.value === 'number' ? 'number' : 'bullet' })
            }
          >
            <option value="bullet">圆点</option>
            <option value="number">编号</option>
          </select>
        </label>
      );
    case 'table':
      return (
        <>
          <div className="tb-grid">
            <table>
              <tbody>
                {body.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>
                        <input
                          aria-label={`第 ${i + 1} 行第 ${j + 1} 列`}
                          value={cell}
                          onChange={(e) =>
                            change({
                              ...body,
                              rows: body.rows.map((r, ri) =>
                                ri === i ? r.map((v, ci) => (ci === j ? e.target.value : v)) : r,
                              ),
                            })
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={() => change({ ...body, rows: [...body.rows, body.rows[0]!.map(() => '')] })}>
            添加行
          </button>
          <button onClick={() => change({ ...body, rows: body.rows.map((r) => [...r, '']) })}>添加列</button>
        </>
      );
    default:
      return <BodyView body={body} />;
  }
}
type Direction = 'up' | 'down' | 'in' | 'out';
function placement(block: Block, page: Page, direction: Direction) {
  const siblings = page.blocks.filter((b) => b.parentId === block.parentId);
  const i = siblings.findIndex((b) => b.id === block.id),
    prev = siblings[i - 1],
    next = siblings[i + 1];
  switch (direction) {
    case 'up':
      return prev && { parentId: block.parentId, beforeId: prev.id };
    case 'down':
      return next && { parentId: block.parentId, beforeId: siblings[i + 2]?.id ?? null };
    case 'in':
      return prev && { parentId: prev.id, beforeId: null };
    case 'out': {
      const parent = page.blocks.find((b) => b.id === block.parentId);
      if (!parent) return;
      const uncles = page.blocks.filter((b) => b.parentId === parent.parentId);
      return { parentId: parent.parentId, beforeId: uncles[uncles.indexOf(parent) + 1]?.id ?? null };
    }
  }
}
export function BlockTree({
  page,
  editable,
  pinned,
  slots,
  stage,
}: {
  page: Page;
  editable: boolean;
  pinned: boolean;
  slots: Slots | undefined;
  stage: (edit: Edit, original: Block | null) => void;
}) {
  const tree = outline(page.blocks).children;
  function row(block: Block) {
    const move = (dir: Direction) => {
      const point = placement(block, page, dir);
      if (editable && point) stage({ kind: 'move', blockId: block.id, ...point }, block);
    };
    const children = tree.get(block.id) ?? [];
    const List = block.body.kind === 'list' && block.body.order === 'number' ? 'ol' : 'ul';
    return (
      <li key={block.id}>
        <article
          tabIndex={-1}
          id={'tb-' + block.id}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || !event.altKey || !editable) return;
            const dir = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'in', ArrowLeft: 'out' } as const)[
              event.key as 'ArrowUp'
            ];
            if (dir) {
              event.preventDefault();
              move(dir);
            }
          }}
        >
          <div className="tb-blockhead">
            <span>{blockNames[block.body.kind]}</span>
            <details>
              <summary aria-label={'块操作 ' + block.id}>•••</summary>
              <div className="tb-menu">
                <a href={link({ id: page.id, block: block.id, ...(pinned ? { rev: page.rev } : {}) })}>
                  定位此块
                </a>
                <a href={link({ id: page.id, block: block.id, rev: page.rev })}>固定版本链接</a>
                {editable && (
                  <>
                    {block.body.kind in newBodies && (
                      <button
                        onClick={() => stage({ kind: 'rewrite', blockId: block.id, body: block.body }, block)}
                      >
                        编辑{blockNames[block.body.kind]}
                      </button>
                    )}
                    <button
                      onClick={() =>
                        stage(
                          {
                            kind: 'insert',
                            blockId: crypto.randomUUID(),
                            parentId: block.id,
                            beforeId: null,
                            body: newBodies.text,
                          },
                          null,
                        )
                      }
                    >
                      添加子块
                    </button>
                    <button
                      onClick={() => {
                        const siblings = tree.get(block.parentId)!;
                        stage(
                          {
                            kind: 'insert',
                            blockId: crypto.randomUUID(),
                            parentId: block.parentId,
                            beforeId: siblings[siblings.indexOf(block) + 1]?.id ?? null,
                            body: newBodies.text,
                          },
                          null,
                        );
                      }}
                    >
                      在下方插入
                    </button>
                    {(['up', 'down', 'in', 'out'] as const).map((dir, i) => (
                      <button key={dir} disabled={!placement(block, page, dir)} onClick={() => move(dir)}>
                        {['上移', '下移', '缩进', '提升一级'][i]}
                      </button>
                    ))}
                  </>
                )}
                {slots?.backlinks?.(page, block)}
                {slots?.reportError?.(page, block)}
              </div>
            </details>
          </div>
          <BodyView body={block.body} />
          {['reference', 'image', 'related'].includes(block.body.kind) &&
            (slots?.resource?.(page, block) ?? <small>需从已授权的材料入口查看</small>)}
        </article>
        {children.length > 0 && (
          <List className={block.body.kind === 'list' ? 'tb-items' : 'tb-nested'}>{children.map(row)}</List>
        )}
      </li>
    );
  }
  return <ul className="tb-blocks">{(tree.get(null) ?? []).map(row)}</ul>;
}
