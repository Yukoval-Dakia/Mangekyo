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
  const parsed = parseEventRefKey(event.ref);
  const explicitItem = typeof event.item_id === 'string' && event.item_id.length > 0 ? event.item_id : null;
  const effectiveItem = explicitItem ?? parsed.itemId;
  if (event.fact_ref && typeof event.fact_ref.id === 'string') {
    candidates.push({ id: event.fact_ref.id, rev: event.fact_ref.rev, itemId: effectiveItem });
  }
  candidates.push({ id: parsed.baseId, rev: event.rev, itemId: effectiveItem });
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

export function eventSourceKey(event: OmissionMatchableEvent): string {
  const parsed = parseEventRefKey(event.ref);
  const factId = event.fact_ref && typeof event.fact_ref.id === 'string' ? event.fact_ref.id : parsed.baseId;
  const itemId = typeof event.item_id === 'string' && event.item_id.length > 0 ? event.item_id : parsed.itemId;
  return itemId !== null ? JSON.stringify([factId, itemId]) : factId;
}

export function eventIsOmitted(event: OmissionMatchableEvent, omissions: readonly SliceOmission[]): boolean {
  return omissions.some(omission => omissionMatchesEvent(event, omission));
}

export type CriterionKcLinkLike = {
  readonly kc_id: string;
  readonly weight?: number;
};

export type CriterionLike = {
  readonly outcome?: string;
  readonly maximum?: number | null;
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

export type KcOutcome = 'correct' | 'incorrect' | 'partial' | 'unknown';

/**
 * Effective scored outcome for `kcId`, matching `cognition.py`'s criterion-first
 * attribution rules. Positive-weight scored criteria supersede the parent event
 * outcome; mixed outcomes for the same KC collapse to `partial`.
 */
export function eventKcOutcome(event: unknown, kcId: string): KcOutcome {
  if (typeof event !== 'object' || event === null) return 'unknown';
  if (eventAttributedKcIds(event) === null) {
    const outcome = (event as { readonly outcome?: string }).outcome;
    return outcome === 'correct' || outcome === 'incorrect' || outcome === 'partial' ? outcome : 'unknown';
  }
  const criteria = (event as { readonly criteria?: readonly CriterionLike[] }).criteria ?? [];
  const outcomes = new Set<Exclude<KcOutcome, 'unknown'>>();
  for (const criterion of criteria) {
    if (criterion.outcome !== 'correct' && criterion.outcome !== 'incorrect' && criterion.outcome !== 'partial') continue;
    if (criterion.maximum == null) continue;
    const linked = (criterion.kc_links ?? []).some(link =>
      link.kc_id === kcId && (typeof link.weight !== 'number' || !Number.isFinite(link.weight) || link.weight > 0));
    if (linked) outcomes.add(criterion.outcome);
  }
  if (outcomes.size === 0) return 'unknown';
  if (outcomes.size === 1) return [...outcomes][0]!;
  return 'partial';
}

export function eventHasPositiveKcLink(event: unknown, kcId: string): boolean {
  if (typeof event !== 'object' || event === null) return false;
  if (eventAttributedKcIds(event) === null) {
    const concepts = (event as { readonly concept_ids?: readonly string[] }).concept_ids;
    return Array.isArray(concepts) && concepts.includes(kcId);
  }
  const criteria = (event as { readonly criteria?: readonly CriterionLike[] }).criteria ?? [];
  return criteria.some(criterion =>
    (criterion.kc_links ?? []).some(link =>
      link.kc_id === kcId && (typeof link.weight !== 'number' || !Number.isFinite(link.weight) || link.weight > 0)));
}

/**
 * Whether an event supplies at least one positive-weight scored observation
 * for `kcId`, matching `cognition.py`'s criterion-first attribution rules.
 */
export function eventHasScoredKcOutcome(event: unknown, kcId: string): boolean {
  return eventKcOutcome(event, kcId) !== 'unknown';
}
