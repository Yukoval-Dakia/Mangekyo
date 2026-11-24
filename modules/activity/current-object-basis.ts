import type { FactId } from '@mangekyo/kernel';

export type StudyObjectWitness = {id: string; rev: number; epoch: string; type: string; mode: 'pinned' | 'following'};

export type StudioMemoryScope = {
  readonly preference: { readonly subject?: string; readonly activity?: string; readonly context?: string };
  readonly links: readonly { readonly kind: 'source' | 'concept' | 'family'; readonly id: FactId }[];
  readonly conditions?: readonly string[];
  readonly attempt?: { readonly id: string; readonly itemId: string }; readonly experienceTurn?: string;
};

export function memoryScopeForObject(current: {
  readonly root: { readonly id: string }; readonly view: { readonly alias: string };
  readonly answerSlot?: string | undefined;
} | undefined): StudioMemoryScope {
  if (!current) return { preference: {}, links: [], conditions: [] };
  const { root, view } = current;
  return {
    preference: { activity: view.alias === 'current_attempt' ? 'attempt' : 'page', context: root.id },
    links: [{ kind: 'source', id: root.id as FactId }],
    ...(current.answerSlot ? { attempt: { id: root.id, itemId: current.answerSlot } } : {}),
  };
}

// Preserve the canonical field order of the digest already bound to submitted turns.
export async function studyObjectBasisDigest(basis: readonly StudyObjectWitness[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(basis.map(({epoch, id, mode, rev, type}) => ({epoch, id, mode, rev, type}))));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
