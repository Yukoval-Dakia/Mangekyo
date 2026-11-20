import type { ReactNode } from 'react';
import type {
  TextbookBlock,
  TextbookBlockBody,
  TextbookPage,
} from '../../../../modules/content/textbook-page.ts';
import type { TextbookEdit } from '../../../../modules/content/textbook-edits.ts';

export type { TextbookBlock as Block, TextbookBlockBody as Body, TextbookEdit as Edit };
export type Page = TextbookPage & { id: string; rev: number; purpose?: readonly string[] };
export type Request = { id: string; expectedRev: number; clientEditSeq: number; edits: [TextbookEdit] };
export type Address = { id: string; rev?: number; block?: string };
export type Chapter = { title: string; pages: { id: string; title: string }[] };
export type Receipt =
  | { kind: 'saved' | 'conflict'; clientEditSeq: number; page: Page }
  | { kind: 'proposed'; clientEditSeq: number; proposalId: string };
// Only raise this after checking the host's local retention and offline access policy.
export class OfflineDraftAvailable extends Error {}
export type Transport = {
  read(address: Address): Promise<Page>;
  revise(request: Request): Promise<Receipt>;
};
export type Slots = {
  practice?(page: Page): ReactNode;
  receipts?(page: Page): ReactNode;
  resource?(page: Page, block: TextbookBlock): ReactNode;
  revisions?(page: Page, open: (address: Address) => void): ReactNode;
  review?(page: Page): ReactNode;
  backlinks?(page: Page, block: TextbookBlock): ReactNode;
  reportError?(page: Page, block: TextbookBlock): ReactNode;
};
export function link(address: Address) {
  const parts = new URLSearchParams({ textbook: address.id });
  if (address.rev !== undefined) parts.set('rev', String(address.rev));
  if (address.block) parts.set('block', address.block);
  return '#' + parts.toString();
}
export function fromHash(defaultId: string): Address {
  const parts = new URLSearchParams(location.hash.slice(1));
  const rev = parts.get('rev'),
    block = parts.get('block');
  return {
    id: parts.get('textbook') || defaultId,
    ...(rev === null ? {} : { rev: Number(rev) }),
    ...(block ? { block } : {}),
  };
}
