import { useMemo, useState, useEffect, useRef } from 'react';
import { journal, type Draft } from './draft.ts';
import {
  OfflineDraftAvailable,
  type Edit,
  type Block,
  type Page,
  type Address,
  type Transport,
} from './contract.ts';
export type ReceiptDetail = { category: string; seq: number; base: number; rev?: number; block: string };
export function useEditor(address: Address, transport: Transport, draftScope: string) {
  const store = useMemo(() => journal(draftScope, address.id), [draftScope, address.id]);
  const [page, show] = useState<Page | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const active = useRef<Draft | null>(null);
  const alive = useRef(true);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [lastReceipt, receiptFor] = useState<ReceiptDetail | null>(null);
  const [notice, say] = useState('');
  const [ready, loaded] = useState(false);
  const [refresh, retry] = useState(0);
  const [focus, setFocus] = useState('');
  const [undo, setUndo] = useState<{ rev: number; edit: Edit } | null>(null);
  const pinned = address.rev !== undefined;
  const { id, rev } = address;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    loaded(false);
    const restore = () => {
      const local = pinned ? null : store.read();
      active.current = local;
      setDraft(local);
    };
    void (async () => {
      try {
        const result = await transport.read(rev === undefined ? { id } : { id, rev });
        if (result.id !== id || (pinned && result.rev !== rev)) throw new Error('返回的教材版本不符');
        if (current) {
          restore();
          show(result);
          loaded(true);
          say('');
        }
      } catch (error) {
        if (!current) return;
        show(null);
        active.current = null;
        setDraft(null);
        try {
          if (error instanceof OfflineDraftAvailable) restore();
          say(String(error));
        } catch (storageError) {
          say(String(storageError));
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [id, rev, pinned, transport, store, refresh]);
  function keep(value: Draft | null) {
    store.write(value);
    active.current = value;
    setDraft(value);
  }
  function stage(edit: Edit, original: Block | null) {
    try {
      const old = active.current;
      keep({ base: old?.base ?? page!.rev, seq: store.next(), original: old?.original ?? original, edit });
      say('草稿已存到本机');
    } catch (error) {
      say(String(error));
    }
  }
  async function save() {
    const sent = active.current;
    if (!sent || lock.current || sent.base !== page?.rev || !ready || pinned) return;
    lock.current = true;
    setBusy(true);
    try {
      const receipt = await transport.revise({
        id,
        expectedRev: sent.base,
        clientEditSeq: sent.seq,
        edits: [sent.edit],
      });
      if (!alive.current) return;
      if (receipt.clientEditSeq !== sent.seq) throw new Error('回执序号不符，保留本机草稿');
      if (receipt.kind === 'proposed') {
        receiptFor({ category: '已形成提议', seq: sent.seq, base: sent.base, block: sent.edit.blockId });
        say('已形成提议 ' + receipt.proposalId);
        return;
      }
      if (receipt.page.id !== id || receipt.page.rev <= sent.base)
        throw new Error('回执版本不符，保留本机草稿');
      receiptFor({
        category:
          receipt.kind === 'conflict'
            ? '版本冲突'
            : { rewrite: '改写', insert: '新增', move: '移动' }[sent.edit.kind],
        seq: sent.seq,
        base: sent.base,
        rev: receipt.page.rev,
        block: sent.edit.blockId,
      });
      show(receipt.page);
      if (receipt.kind === 'conflict') {
        say('版本冲突，已保留两份内容');
        return;
      }
      let inverse: Edit | undefined;
      if (sent.original && sent.edit.kind === 'rewrite')
        inverse = { kind: 'rewrite', blockId: sent.original.id, body: sent.original.body };
      if (sent.original && sent.edit.kind === 'move') {
        const siblings = page.blocks.filter((b) => b.parentId === sent.original!.parentId);
        inverse = {
          kind: 'move',
          blockId: sent.original.id,
          parentId: sent.original.parentId,
          beforeId: siblings[siblings.findIndex((b) => b.id === sent.original!.id) + 1]?.id ?? null,
        };
      }
      setUndo(inverse ? { rev: receipt.page.rev, edit: inverse } : null);
      const latest = active.current;
      if (latest?.seq === sent.seq) {
        keep(null);
        setFocus(sent.edit.blockId);
      } else if (latest && latest.edit.kind !== 'move') {
        keep({
          ...latest,
          base: receipt.page.rev,
          original: receipt.page.blocks.find((b) => b.id === latest.edit.blockId) ?? null,
          edit: { kind: 'rewrite', blockId: latest.edit.blockId, body: latest.edit.body },
        });
      }
      say('已保存版本 ' + receipt.page.rev);
    } catch (error) {
      if (alive.current) say(String(error));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (address.block && ready) document.getElementById('tb-' + address.block)?.focus();
  }, [address.block, ready]);
  useEffect(() => {
    if (focus) {
      document.getElementById('tb-' + focus)?.focus();
      setFocus('');
    }
  }, [focus]);
  const edit = draft?.edit;
  const conflict = draft && page && page.rev !== draft.base;
  function abandon() {
    try {
      keep(null);
      setFocus(edit?.blockId ?? '');
      say('已放弃本机草稿');
    } catch (error) {
      say(String(error));
    }
  }
  function rebase() {
    if (!page || !draft || !edit) return;
    try {
      keep({
        ...draft,
        base: page.rev,
        seq: store.next(),
        original: page.blocks.find((b) => b.id === edit.blockId) ?? null,
      });
      say('已将本机草稿放到当前版，请核对后保存');
    } catch (error) {
      say(String(error));
    }
  }
  return {
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
    reread: () => retry((n) => n + 1),
  };
}
