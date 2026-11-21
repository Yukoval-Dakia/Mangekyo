import { defineCommand } from '@mangekyo/kernel';
import { fields, key, list, pageId, record, revision } from '../parse.ts';
import { undoTextbookWrite } from '../textbook-undo.ts';

export default defineCommand({
  type: 'content.undoTextbookWrite',
  destructive: true,
  schema: {
    parse(input: unknown) {
      const value = record(input);
      fields(value, 'id', 'expectedRev', 'priorRev', 'appliedRev', 'blockIds', 'moveBlockIds', 'pruneGroupBasis');
      const blockIds = value.blockIds === undefined ? undefined : list(value.blockIds).map(key);
      if (blockIds && (!blockIds.length || new Set(blockIds).size !== blockIds.length)) {
        throw new Error('请选择不同的教材撤回块。');
      }
      const moveBlockIds = value.moveBlockIds === undefined ? [] : list(value.moveBlockIds).map(key);
      if (moveBlockIds.some(id => !blockIds?.includes(id)) || new Set(moveBlockIds).size !== moveBlockIds.length) {
        throw new Error('撤回位置须指向已选的教材块。');
      }
      if (value.pruneGroupBasis !== undefined && (value.pruneGroupBasis !== true || !blockIds)) {
        throw new Error('撤回来源须指向完整教材插入组。');
      }
      return {
        id: pageId(value.id), expectedRev: revision(value.expectedRev),
        priorRev: value.priorRev === null ? null : revision(value.priorRev),
        ...(value.appliedRev === undefined ? {} : { appliedRev: revision(value.appliedRev) }),
        ...(blockIds ? { blockIds } : {}),
        ...(moveBlockIds.length ? { moveBlockIds } : {}),
        ...(value.pruneGroupBasis === true ? { pruneGroupBasis: true } : {}),
      };
    },
  },
  write: undoTextbookWrite,
});
