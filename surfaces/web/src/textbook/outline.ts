import type { Block, Body } from './contract.ts';

export function blockTitle(body: Body) {
  switch (body.kind) {
    case 'text':
      return body.text;
    case 'formula':
      return body.latex;
    case 'table':
      return body.rows.flat().join('　');
    case 'image':
      return body.alt;
    case 'list':
      return body.order === 'number' ? '步骤列表' : '要点列表';
    case 'related':
      return (
        (body.target === 'question' ? '相关题目' : '相关旧作') +
        ' · ' +
        body.allOf.map((c) => c.id).join('、')
      );
    case 'reference':
      return { work: '我的旧作', question: '关联题目', citation: '资料来源' }[body.role];
  }
}

export function outline(blocks: readonly Block[]) {
  const children = new Map<string | null, Block[]>();
  for (const block of blocks) {
    const group = children.get(block.parentId);
    if (group) group.push(block);
    else children.set(block.parentId, [block]);
  }
  function flatten(parent: string | null, depth: number): { block: Block; depth: number }[] {
    return (children.get(parent) ?? []).flatMap((block) => [
      { block, depth },
      ...flatten(block.id, depth + 1),
    ]);
  }
  return { children, entries: flatten(null, 0) };
}
