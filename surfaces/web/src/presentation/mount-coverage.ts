// The host accepts up to 64 repeated, session-local ULID hints per request.
export interface PartialMountPermissions {
  mountPermissionsPartial?: boolean;
  unconfirmedMountIds?: string[];
}

export function mountBatches(ids: Iterable<string>) {
  const distinct = [...new Set(ids)].filter(id => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id));
  const batches: string[][] = [];
  for (let i = 0; i < distinct.length; i += 64) batches.push(distinct.slice(i, i + 64));
  return batches;
}

export function mountQuery(path: string, ids: readonly string[]) {
  if (!ids.length) return path;
  const query = new URLSearchParams();
  for (const id of ids) query.append('knownMountIds', id);
  return path + (path.includes('?') ? '&' : '?') + query;
}

export function unresolved(frame: PartialMountPermissions, id: string, covered: ReadonlySet<string>) {
  return frame.mountPermissionsPartial === true && (!covered.has(id) ||
    !Array.isArray(frame.unconfirmedMountIds) || frame.unconfirmedMountIds.includes(id));
}
