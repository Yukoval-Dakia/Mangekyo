import type { Block, Edit } from './contract.ts';

export type Draft = { base: number; seq: number; original: Block | null; edit: Edit };
export function journal(scope: string, page: string) {
  const key = 'mangekyo.textbook.' + JSON.stringify([scope, page]);
  return {
    read(): Draft | null {
      const saved = localStorage.getItem(key);
      if (saved === null) return null;
      const draft: Draft = JSON.parse(saved);
      if (!draft?.edit?.blockId || !Number.isSafeInteger(draft.seq) || !Number.isInteger(draft.base)) {
        throw new Error('无法读取本机草稿');
      }
      return draft;
    },
    write(draft: Draft | null) {
      if (draft) localStorage.setItem(key, JSON.stringify(draft));
      else localStorage.removeItem(key);
    },
    next(): number {
      // Completed sequences belong to the page across browser profiles.
      const prior = localStorage.getItem(key + '.seq');
      const seq = prior === null
        ? crypto.getRandomValues(new Uint32Array(1))[0]! * 1048576
        : Number(prior) + 1;
      if (!Number.isSafeInteger(seq)) throw new Error('本机编辑序号无效');
      localStorage.setItem(key + '.seq', String(seq));
      return seq;
    },
  };
}
