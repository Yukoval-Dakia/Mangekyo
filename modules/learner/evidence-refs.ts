/**
 * Shared canonical evidence-key helpers (Wave A P0-1/P0-2/P0-3).
 *
 * Multi-item evidence is keyed either as `${submissionId}#${itemId}` or
 * `JSON.stringify([submissionId, itemId])`; V2 events may also carry an
 * explicit `fact_ref` plus `item_id`. Omission shielding, anchor pairing and
 * concept bucketing must all resolve these forms identically.
 */

export type ParsedEventRefKey = {
  readonly baseId: string;
  readonly itemId: string | null;
};

export function parseEventRefKey(ref: string): ParsedEventRefKey {
  if (ref.startsWith('["')) {
    try {
      const parsed: unknown = JSON.parse(ref);
      if (Array.isArray(parsed) && parsed.length >= 2 &&
          typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
        return { baseId: parsed[0], itemId: parsed[1] };
      }
    } catch {
      // Not a JSON composite reference; fall through to the plain form.
    }
  }
  const separator = ref.indexOf('#');
  if (separator >= 0) return { baseId: ref.slice(0, separator), itemId: ref.slice(separator + 1) };
  return { baseId: ref, itemId: null };
}

export type SliceOmission = {
  readonly ref: { readonly id: string; readonly rev: number };
  readonly item_id?: string;
  readonly reason: string;
};

export type OmissionMatchableEvent = {
  readonly ref: string;
  readonly rev: number;
  readonly item_id?: string;
  readonly fact_ref?: { readonly id: string; readonly rev: number };
};

/**
 * Identity candidates of one event, in the same order the Python deriver uses:
 * explicit V2 coordinates first, then the parsed composite key, then the raw
 * legacy `(ref, rev)` pair.
 */
export function eventRefCandidates(event: OmissionMatchableEvent): readonly {
  readonly id: string;
  readonly rev: number;
  readonly itemId: string | null;
}[] {
  const candidates: { id: string; rev: number; itemId: string | null }[] = [];
  if (event.fact_ref && typeof event.fact_ref.id === 'string') {
    candidates.push({ id: event.fact_ref.id, rev: event.fact_ref.rev, itemId: event.item_id ?? null });
  }
  const parsed = parseEventRefKey(event.ref);
  candidates.push({ id: parsed.baseId, rev: event.rev, itemId: parsed.itemId });
  if (parsed.itemId !== null) candidates.push({ id: event.ref, rev: event.rev, itemId: null });
  return candidates;
}

export function omissionMatchesEvent(event: OmissionMatchableEvent, omission: SliceOmission): boolean {
  for (const candidate of eventRefCandidates(event)) {
    if (candidate.id === omission.ref.id && candidate.rev === omission.ref.rev &&
        (omission.item_id === undefined || candidate.itemId === omission.item_id)) return true;
  }
  return false;
}

export function eventIsOmitted(event: OmissionMatchableEvent, omissions: readonly SliceOmission[]): boolean {
  return omissions.some(omission => omissionMatchesEvent(event, omission));
}

export type CriterionKcLinkLike = {
  readonly kc_id: string;
  readonly weight?: number;
};

export type CriterionLike = {
  readonly kc_links?: readonly CriterionKcLinkLike[];
};

/**
 * Criterion-first attribution targets (P0-3): when any criterion carries
 * non-empty kc_links, the event attributes exclusively to the union of linked
 * KCs. Returns null when the event has no criterion mapping, meaning the
 * caller falls back to the legacy concept_ids semantics.
 */
export function eventAttributedKcIds(event: unknown): readonly string[] | null {
  if (typeof event !== 'object' || event === null) return null;
  const criteria = (event as { readonly criteria?: readonly CriterionLike[] }).criteria;
  if (!Array.isArray(criteria)) return null;
  const targets = new Set<string>();
  let hasLinks = false;
  for (const criterion of criteria) {
    if (!criterion || !Array.isArray(criterion.kc_links)) continue;
    for (const link of criterion.kc_links) {
      if (link && typeof link.kc_id === 'string' && link.kc_id) {
        hasLinks = true;
        targets.add(link.kc_id);
      }
    }
  }
  return hasLinks ? [...targets].sort() : null;
}
