"""Versioned read-time estimates over the authorized, fixed-clock evidence slice."""
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from math import log2, sqrt

DAY_SECONDS = 86_400
CROSSING = 0.60
NOVELTY = {"same": 0.4, "isomorphic": 0.8, "transfer": 1.0}
HELP = {"independent": 1.0, "hinted": 0.3, "solution_seen": 0.2}
GRADED_HELP = {**HELP, "hint_l1": 0.55, "hint_l2": 0.25}
# A slip is weaker evidence of a conceptual gap. Unclassified errors retain full weight.
ERROR_LOSS = {"reading": 0.75, "modeling": 1.0, "strategy": 1.0, "execution": 0.5, "expression": 0.4}
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


def estimate(dimension, observations, now, dynamic, graded):
    """Leaky Beta evidence counts; spaced independent retrieval changes the decay time."""
    ordered = sorted(observations, key=lambda pair: (pair[0], pair[1]["ref"], pair[1]["rev"]))
    row = dict(zip(("concept_id", *AXES, "item_novelty"), dimension))
    row["evidence_refs"] = [{"ref": e["ref"], "rev": e["rev"]} for _, e in ordered]
    scored = [(at, e) for at, e in ordered if e["outcome"] != "unknown"]
    if not any(e["help_level"] == "independent" for _, e in scored):
        return dict(row, state="unknown", uncertainty=unknown("missing-independent-scored-evidence")), None

    a = b = 1.0
    half_life = 2.0 if dynamic else 7.0
    gaps = []
    previous = last_independent = None
    for at, event in scored:
        gap = (at - previous).total_seconds() / DAY_SECONDS if previous else 0.0
        if previous is not None:
            gaps.append(gap)
        # Old responses contribute less following an extended gap.
        a, b = _decay(a, b, gap, half_life)
        help_level = event["help_level"]
        help_weight = GRADED_HELP[help_level] if graded else HELP.get(help_level, HELP["hinted"])
        weight = NOVELTY[event["item_novelty"]] * help_weight
        score = float(event["outcome"] == "correct")
        if dynamic:
            score = event.get("score_norm", score)
        a += weight * score
        loss = 1 - score
        if graded and event["outcome"] == "incorrect":
            loss *= ERROR_LOSS.get(event.get("error_stage"), 1.0)
        b += weight * loss
        if dynamic and help_level == "independent":
            spacing = (at - last_independent).total_seconds() / DAY_SECONDS if last_independent else 0.0
            half_life = min(365.0, max(0.5, half_life * (1 - 0.35 * loss)
                                      + weight * score * (1 + min(spacing, half_life))))
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
    if method_version not in ("cognition@1", "cognition@2", "dimensioned-retention@1"):
        raise ValueError("unsupported cognition method")
    now = instant(slice["as_of_at"])
    dynamic = method_version != "dimensioned-retention@1"
    graded = method_version == "cognition@2"
    omitted = {(item["ref"]["id"], item["ref"]["rev"]) for item in slice.get("omissions", [])}
    groups = defaultdict(list)
    seen = {}
    anomalies = defaultdict(set)
    probe_sources = defaultdict(set)
    for event in slice["events"]:
        at = instant(event["occurred_at"])
        if at > now or (event["ref"], event["rev"]) in omitted:
            continue
        high_error = event["outcome"] == "incorrect" and event.get("confidence", 0) >= 0.8
        if high_error:
            anomalies[event.get("error_stage") if graded else None].add((event["ref"], event["rev"]))
        for key in dimensions(event):
            identity = (key, event["ref"])
            if identity in seen:
                if seen[identity] != event:
                    raise ValueError("conflicting observations of one source in one dimension")
                continue
            seen[identity] = event
            groups[key].append((at, event))
            if graded and high_error:
                probe_sources[key[:-1]].add((event["ref"], event["rev"]))

    vector = []
    posteriors = {}
    for key in sorted(groups, key=lambda k: tuple(part or "" for part in k)):
        row, posterior = estimate(key, groups[key], now, dynamic, graded)
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
