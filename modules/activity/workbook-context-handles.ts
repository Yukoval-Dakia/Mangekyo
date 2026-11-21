import type { BoundWorkbookMount } from './workbook-context-read.ts';

const kinds = ['archetype','backtrace','notion'] as const;
export type WorkbookCapsuleKind = typeof kinds[number];

/** Two 128-bit MACs preserve the opaque 43-character handle. The outer MAC
 * authenticates the category and mount before any candidate reads. */
export function workbookCapsuleHandles(sign: (...claims: unknown[]) => string, equal: (a: Uint8Array,b: Uint8Array) => boolean) {
  const mac = (...claims: unknown[]) => Buffer.from(sign(...claims),'base64url').subarray(0,16);
  const tag = (kind: WorkbookCapsuleKind, mount: BoundWorkbookMount, item: string, proof: Buffer) =>
    mac('paper-capsule-kind',kind,mount,item,proof.toString('base64url'));
  return {
    seal(kind: WorkbookCapsuleKind, mount: BoundWorkbookMount, item: string, basis: unknown) {
      const proof = mac('paper-capsule-proof',kind,basis);
      return Buffer.concat([proof,tag(kind,mount,item,proof)]).toString('base64url');
    },
    kind(ref: string, mount: BoundWorkbookMount, item: string) {
      const token = Buffer.from(ref,'base64url');
      if (token.length!==32 || token.toString('base64url')!==ref) return undefined;
      const proof = token.subarray(0,16), bound = token.subarray(16);
      return kinds.find(kind=>equal(bound,tag(kind,mount,item,proof)));
    },
  };
}
