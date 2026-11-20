import type { FactId } from '@mangekyo/kernel';
import { fields, key, list, pageId, record } from './parse.ts';

export type TextbookPageState = {
  readonly parentPageId?: FactId;
  readonly archived?: true;
  readonly mergedInto?: FactId;
  readonly mergedFrom?: readonly FactId[];
  readonly retiredBlockIds?: readonly string[];
  readonly movedBlocks?: readonly {
    readonly blockId: string;
    readonly pageId: FactId;
    readonly targetBlockId?: string;
  }[];
};

export const textbookPageStateFields = [
  'parentPageId', 'archived', 'mergedInto', 'mergedFrom', 'retiredBlockIds', 'movedBlocks',
] as const;

export function parseTextbookPageState(
  value: Record<string, unknown>,
  blocks: readonly { readonly id: string }[],
): TextbookPageState {
  const retiredBlockIds = value.retiredBlockIds === undefined ? [] : list(value.retiredBlockIds).map(key);
  const movedBlocks = value.movedBlocks === undefined ? [] : list(value.movedBlocks).map(item => {
    const move = record(item);
    fields(move, 'blockId', 'pageId', 'targetBlockId');
    return {
      blockId: key(move.blockId), pageId: pageId(move.pageId),
      ...(move.targetBlockId === undefined ? {} : { targetBlockId: key(move.targetBlockId) }),
    };
  });
  const ids = [...blocks.map(block => block.id), ...retiredBlockIds, ...movedBlocks.map(move => move.blockId)];
  if (new Set(ids).size !== ids.length) throw new Error('教材块标识已经使用。');
  const { archived } = value;
  if (archived !== undefined && archived !== true) throw new Error('教材归档状态无效。');
  if (value.mergedInto !== undefined && (!archived || blocks.length)) throw new Error('合并页必须归档并移出所有块。');
  const mergedFrom = value.mergedFrom === undefined ? [] : list(value.mergedFrom).map(pageId);
  if (new Set(mergedFrom).size !== mergedFrom.length) throw new Error('教材合并来源重复。');
  return {
    ...(value.parentPageId === undefined ? {} : { parentPageId: pageId(value.parentPageId) }),
    ...(archived ? { archived } : {}),
    ...(value.mergedInto === undefined ? {} : { mergedInto: pageId(value.mergedInto) }),
    ...(mergedFrom.length ? { mergedFrom } : {}),
    ...(retiredBlockIds.length ? { retiredBlockIds } : {}),
    ...(movedBlocks.length ? { movedBlocks } : {}),
  };
}
