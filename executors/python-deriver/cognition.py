"""Versioned read-time estimates over the authorized, fixed-clock evidence slice."""
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from itertools import groupby
from math import fsum, log2, sqrt

DAY_SECONDS = 86_400
CROSSING = 0.60
NOVELTY = {"same": 0.4, "isomorphic": 0.8, "transfer": 1.0}
HELP = {"independent": 1.0, "hinted": 0.3, "solution_seen": 0.2}
GRADED_HELP = {**HELP, "hint_l1": 0.55, "hint_l2": 0.25}
# A slip is weaker evidence of a conceptual gap. Unclassified errors retain full weight.
ERROR_LOSS = {"reading": 0.75, "modeling": 1.0, "strategy": 1.0, "execution": 0.5, "expression": 0.4}
LOW_CONFIDENCE_MAX = 0.35
LOW_CONFIDENCE_GAIN = 0.25
AXES = ("representation", "context", "method")


def instant(value):
    body = value.removesuffix("Z")
    seconds, dot, fraction = body.partition(".")
    if dot:
        seconds += "." + fraction.ljust(3, "0")
    return datetime.fromisoformat(seconds + "+00:00")


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def dimensions(item):
    for concept in sorted(set(item["concept_ids"])):
        yield (concept, *(item.get(axis) for axis in AXES), item["item_novelty"])


def parse_ref_key(ref):
    """Split a composite submission-item reference into (base_id, item_id).

    Producers key multi-item evidence either as `${submissionId}#${itemId}` or
    `JSON.stringify([submissionId, itemId])`; plain references carry no item.
    """
    if isinstance(ref, str):
        if ref.startswith('["'):
            try:
                parsed = json.loads(ref)
            except ValueError:
                parsed = None
            if (isinstance(parsed, list) and len(parsed) >= 2
                    and all(isinstance(part, str) for part in parsed[:2])):
                return parsed[0], parsed[1]
        base, sep, item = ref.partition("#")
        if sep:
            return base, item
    return ref, None


def event_source_key(event):
    """Canonical `(fact_id, fact_rev, item_id)` source identity for dedup and grouping."""
    base, item = parse_ref_key(event["ref"])
    fact_ref = event.get("fact_ref")
    fact_id = fact_ref["id"] if isinstance(fact_ref, dict) and isinstance(fact_ref.get("id"), str) else base
    fact_rev = (
        fact_ref["rev"]
        if isinstance(fact_ref, dict) and type(fact_ref.get("rev")) is int
        else event["rev"]
    )
    explicit_item = event.get("item_id")
    item_id = explicit_item if isinstance(explicit_item, str) and explicit_item else (item or "")
    return (fact_id, fact_rev, item_id)


def observation_signature(event, observation, weight):
    """Canonical semantic signature ignoring surface ref/fact_ref/concept_ids encoding."""
    return (
        event_source_key(event),
        instant(observation["occurred_at"]),
        observation["item_novelty"],
        observation["help_level"],
        observation["outcome"],
        observation.get("score_norm"),
        observation.get("error_stage"),
        observation.get("confidence"),
        observation.get("effective_duration_ms"),
        tuple(observation.get("claim_ids", ())),
        tuple(observation.get(axis) for axis in AXES),
        weight,
    )


def omission_matches(event, omissions):
    """Canonical omission shielding (P0-1).

    An item-scoped omission with `item_id` blocks exactly that item's events
    for the fact revision, whether the event carries a plain, `#`-suffixed or
    JSON-array composite reference or an explicit `fact_ref`/`item_id`. A
    fact-level omission without `item_id` blocks every event of the fact
    revision, including all synthesized per-item events.
    """
    base, item = parse_ref_key(event["ref"])
    explicit_item = event.get("item_id")
    effective_item = explicit_item if isinstance(explicit_item, str) and explicit_item else item
    candidates = []
    fact_ref = event.get("fact_ref")
    if isinstance(fact_ref, dict) and isinstance(fact_ref.get("id"), str):
        candidates.append((fact_ref["id"], fact_ref.get("rev"), effective_item))
    candidates.append((base, event["rev"], effective_item))
    if item is not None:
        candidates.append((event["ref"], event["rev"], None))
    for omission in omissions:
        ref = omission["ref"]
        want_item = omission.get("item_id")
        for candidate_id, candidate_rev, candidate_item in candidates:
            if candidate_id == ref["id"] and candidate_rev == ref["rev"]:
                if want_item is None or candidate_item == want_item:
                    return True
    return False


def _link_weight(link):
    weight = link.get("weight")
    if isinstance(weight, (int, float)) and not isinstance(weight, bool) and weight >= 0:
        return float(weight)
    return 1.0


def event_attributions(event):
    """Per-KC observation synthesis for one evidence event.

    Criterion-first attribution (P0-3): when any criterion carries non-empty
    kc_links, evidence flows only into the linked KCs at each link's weight,
    with the criterion's own outcome/score/error stage. A multi-KC event with
    no criterion mapping splits its weight evenly instead of replicating one
    full-weight observation into every concept.
    """
    criteria = event.get("criteria")
    if isinstance(criteria, list):
        observations = []
        for index, criterion in enumerate(criteria):
            if not isinstance(criterion, dict):
                continue
            links = criterion.get("kc_links")
            if not isinstance(links, list):
                continue
            for link in links:
                if not isinstance(link, dict) or not isinstance(link.get("kc_id"), str):
                    continue
                outcome = criterion.get("outcome")
                if outcome not in ("correct", "incorrect", "partial") or criterion.get("maximum") is None:
                    outcome = "unknown"
                observation = dict(event)
                observation.pop("criteria", None)
                observation["outcome"] = outcome
                score_norm = criterion.get("score_norm")
                if score_norm is None and outcome != "unknown":
                    earned = criterion.get("earned")
                    maximum = criterion.get("maximum")
                    if (isinstance(earned, (int, float)) and not isinstance(earned, bool)
                            and isinstance(maximum, (int, float)) and not isinstance(maximum, bool)
                            and maximum > 0):
                        score_norm = min(1.0, max(0.0, float(earned) / float(maximum)))
                if score_norm is not None:
                    observation["score_norm"] = score_norm
                else:
                    observation.pop("score_norm", None)
                if criterion.get("error_stage") is not None:
                    observation["error_stage"] = criterion["error_stage"]
                else:
                    observation.pop("error_stage", None)
                observations.append((link["kc_id"], observation, _link_weight(link), index))
        if observations:
            return observations
    concepts = sorted(set(event["concept_ids"]))
    share = 1.0 / len(concepts) if len(concepts) > 1 else 1.0
    return [(concept, event, share, None) for concept in concepts]


def unknown(reason):
    needed = "select-target-dimension" if reason == "multiple-dimensions" else "independent-scored-attempt-in-target-dimension"
    return {"kind": "unknown", "reason": reason, "needed": needed}


def entropy(p):
    if p <= 0 or p >= 1:
        return 0.0
    return -p * log2(p) - (1 - p) * log2(1 - p)


# Shared with the original dimensioned-retention@1 estimator: decay only
# pseudo-counts in excess of the Beta(1,1) prior.
def _decay(alpha, beta, days, half_life):
    keep = 2 ** (-days / half_life)
    return 1 + (alpha - 1) * keep, 1 + (beta - 1) * keep


def _interval(alpha, beta):
    total = alpha + beta
    mean = alpha / total
    variance = alpha * beta / (total * total * (total + 1))
    spread = 1.96 * sqrt(variance)
    return max(0.0, mean - spread), min(1.0, mean + spread)


def estimate(dimension, observations, now, dynamic, graded, confidence_weighted):
    """Leaky Beta evidence counts; spaced independent retrieval changes the decay time."""
    ordered = sorted(observations, key=lambda triple: (triple[0], event_source_key(triple[1]), triple[1]["ref"], triple[1]["rev"]))
    row = dict(zip(("concept_id", *AXES, "item_novelty"), dimension))
    refs = []
    ref_keys = set()
    for _, event, weight in ordered:
        if weight <= 0:
            continue
        key = (event["ref"], event["rev"])
        if key not in ref_keys:
            ref_keys.add(key)
            refs.append(key)
    row["evidence_refs"] = [{"ref": ref, "rev": rev} for ref, rev in refs]
    if not any(event["help_level"] == "independent" and event["outcome"] != "unknown" and weight > 0
               for _, event, weight in ordered):
        return dict(row, state="unknown", uncertainty=unknown("missing-independent-scored-evidence")), None

    scored = [triple for triple in ordered if triple[1]["outcome"] != "unknown" and triple[2] > 0]
    attempt_key = lambda triple: (triple[0], event_source_key(triple[1]), triple[1]["help_level"])
    scored.sort(key=attempt_key)
    a = b = 1.0
    half_life = 2.0 if dynamic else 7.0
    gaps = []
    previous = last_independent = None
    for (at, _, help_level), group in groupby(scored, key=attempt_key):
        gap = (at - previous).total_seconds() / DAY_SECONDS if previous else 0.0
        if previous is not None:
            gaps.append(gap)
        # Old responses contribute less following an extended gap.
        a, b = _decay(a, b, gap, half_life)
        help_weight = GRADED_HELP[help_level] if graded else HELP.get(help_level, HELP["hinted"])
        weights, gains, losses = [], [], []
        for _, event, attribution_weight in group:
            weight = NOVELTY[event["item_novelty"]] * help_weight * attribution_weight
            if event["outcome"] == "correct":
                score = 1.0
            elif event["outcome"] == "partial":
                score = 0.5
            else:
                score = 0.0
            if dynamic:
                score_norm = event.get("score_norm")
                if score_norm is not None:
                    score = min(1.0, max(0.0, float(score_norm)))
            gain = weight * score
            if (confidence_weighted and help_level == "independent" and event["outcome"] == "correct"
                    and event.get("confidence", 1) <= LOW_CONFIDENCE_MAX):
                gain *= LOW_CONFIDENCE_GAIN
            loss = 1 - score
            if graded and event["outcome"] in ("incorrect", "partial") and loss > 0:
                loss *= ERROR_LOSS.get(event.get("error_stage"), 1.0)
            weights.append(weight)
            gains.append(gain)
            losses.append(weight * loss)
        weight_total = fsum(weights)
        gain_total = fsum(gains)
        loss_weight_total = fsum(losses)
        a += gain_total
        b += loss_weight_total
        if dynamic and help_level == "independent" and weight_total > 0:
            avg_loss = loss_weight_total / weight_total
            spacing = (at - last_independent).total_seconds() / DAY_SECONDS if last_independent else 0.0
            half_life = min(365.0, max(0.5, half_life * (1 - 0.35 * avg_loss)
                                      + gain_total * (1 + min(spacing, half_life))))
            last_independent = at
        previous = at

    mastery = a / (a + b)
    age = (now - previous).total_seconds() / DAY_SECONDS
    anchor = last_independent if dynamic else previous
    retrieval_age = (now - anchor).total_seconds() / DAY_SECONDS
    decay = 2 ** (-retrieval_age / half_life)
    alpha_t, beta_t = _decay(a, b, age, half_life)
    p = mastery * decay if dynamic else alpha_t / (alpha_t + beta_t)
    low, high = _interval(alpha_t, beta_t)
    if dynamic:
        # Old evidence slowly loses precision; keep the model interval around
        # the projected retrieval probability, bounded by the Bernoulli scale.
        center = alpha_t / (alpha_t + beta_t)
        low, high = max(0, p - (center - low)), min(1, p + (high - center))
    row.update(state="known", mastery_prob=mastery, r_now=p, last_at=iso(anchor),
               interval_days=gaps, stability_days=half_life, difficulty=1 - mastery,
               effective_evidence=alpha_t + beta_t - 2,
               uncertainty={"kind": "interval", "low": low, "high": high})
    if p > CROSSING:
        if dynamic:
            days = half_life * log2(p / CROSSING)
        else:
            excess = (alpha_t - 1) - CROSSING * (alpha_t + beta_t - 2)
            days = half_life * log2(excess / (2 * CROSSING - 1))
        if days <= 2:
            row["crossing_at"] = iso(now + timedelta(days=days))
    return row, (alpha_t, beta_t)


def information(posterior, novelty):
    # Expected entropy reduction for one independent item. Beta(1,1) is
    # only a design prior for selecting probes; it is never a learner estimate.
    a, b = posterior or (1.0, 1.0)
    total = a + b
    p = a / total
    weight = NOVELTY[novelty]
    after_correct = entropy((a + weight) / (total + weight))
    after_error = entropy(a / (total + weight))
    return max(0.0, entropy(p) - p * after_correct - (1 - p) * after_error)


def derive(slice, method_version="cognition@1"):
    if method_version not in ("cognition@1", "cognition@2", "cognition@3", "dimensioned-retention@1"):
        raise ValueError("unsupported cognition method")
    now = instant(slice["as_of_at"])
    dynamic = method_version != "dimensioned-retention@1"
    graded = method_version in ("cognition@2", "cognition@3")
    confidence_weighted = method_version == "cognition@3"
    omissions = slice.get("omissions", [])
    groups = defaultdict(list)
    seen = {}
    anomalies = defaultdict(set)
    probe_sources = defaultdict(set)
    for event in slice["events"]:
        at = instant(event["occurred_at"])
        if at > now or omission_matches(event, omissions):
            continue
        attributions = event_attributions(event)
        if not attributions:
            if event["outcome"] == "incorrect" and event.get("confidence", 0) >= 0.8:
                anomalies[event.get("error_stage") if graded else None].add((event["ref"], event["rev"]))
        source_key = event_source_key(event)
        for kc_id, observation, attribution_weight, criterion_index in attributions:
            key = (kc_id, *(observation.get(axis) for axis in AXES), observation["item_novelty"])
            identity = (key, source_key, None if criterion_index is None else (criterion_index, kc_id))
            sig = observation_signature(event, observation, attribution_weight)
            if identity in seen:
                if seen[identity] != sig:
                    raise ValueError("conflicting observations of one source in one dimension")
                continue
            seen[identity] = sig
            groups[key].append((at, observation, attribution_weight))
            if (observation["outcome"] == "incorrect" and observation.get("confidence", 0) >= 0.8
                    and attribution_weight > 0):
                anomalies[observation.get("error_stage") if graded else None].add((event["ref"], event["rev"]))
                if graded:
                    probe_sources[key[:-1]].add((event["ref"], event["rev"]))

    vector = []
    posteriors = {}
    for key in sorted(groups, key=lambda k: tuple(part or "" for part in k)):
        row, posterior = estimate(key, groups[key], now, dynamic, graded, confidence_weighted)
        vector.append(row)
        posteriors[key] = posterior
    ranked = []
    for item in slice["candidate_pool"]:
        keys = list(dimensions(item))
        if not keys:
            continue
        gain = sum(information(posteriors.get(key), item["item_novelty"]) for key in keys) / len(keys)
        reason = "probe-unknown" if any(not posteriors.get(k) for k in keys) else "reduce-uncertainty"
        candidate = {"ref": item["ref"], "est_min": item["est_min"], "info_gain": gain, "reason_code": reason}
        if item["item_novelty"] != "same":
            sources = set().union(*(probe_sources.get(key[:-1], ()) for key in keys))
            if sources:
                candidate.update(reason_code="probe-high-confidence-error",
                                 evidence_refs=[{"ref": ref, "rev": rev} for ref, rev in sorted(sources)])
        ranked.append(candidate)
    ranked.sort(key=lambda item: ("evidence_refs" not in item,
                                 item["est_min"] if "evidence_refs" in item else 0,
                                 -item["info_gain"], item["ref"]))
    signals = []
    for stage, sources in sorted(anomalies.items(), key=lambda pair: pair[0] or ""):
        signal = {"type": "high-confidence-error", "refs": sorted({ref for ref, _ in sources})}
        if graded:
            signal["evidence_refs"] = [{"ref": ref, "rev": rev} for ref, rev in sorted(sources)]
            if stage:
                signal["error_stage"] = stage
        signals.append(signal)
    uncertainty = vector[0]["uncertainty"] if len(vector) == 1 else unknown(
        "multiple-dimensions" if vector else "missing-independent-scored-evidence")
    result = {"method_version": method_version, "state": "known" if any(posteriors.values()) else "unknown",
              "state_vector": vector, "uncertainty": uncertainty, "ranked_candidates": ranked,
              "anomalies": signals}
    if len(vector) == 1 and vector[0]["state"] == "known":
        result["r_now"] = vector[0]["r_now"]
        if "crossing_at" in vector[0]:
            result["crossing_at"] = vector[0]["crossing_at"]
    return result
