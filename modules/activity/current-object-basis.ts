export type StudyObjectWitness = {id: string; rev: number; epoch: string; type: string; mode: 'pinned' | 'following'};

// Preserve the canonical field order of the digest already bound to submitted turns.
export async function studyObjectBasisDigest(basis: readonly StudyObjectWitness[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(basis.map(({epoch, id, mode, rev, type}) => ({epoch, id, mode, rev, type}))));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
