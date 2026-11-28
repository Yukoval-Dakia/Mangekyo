"""Expected information from an independent answer to a planning candidate."""
from collections import defaultdict

from cognition import (
    AXES, dimensions, estimate, event_attributions, event_source_key, information, instant, observation_signature,
    omission_matches, unknown,
)


def derive(evidence):
    now = instant(evidence["as_of_at"])
    omissions = evidence.get("omissions", [])
    unavailable = {entry["ref"]["id"] for entry in omissions} | set(evidence["constraints"]["locks"])
    groups = defaultdict(dict)
    seen_obs = {}
    for event in evidence["events"]:
        at = instant(event["occurred_at"])
        if at > now or omission_matches(event, omissions):
            continue
        unavailable.add(event["ref"])
        if event["help_level"] != "independent":
            continue
        source_key = event_source_key(event)
        for kc_id, observation, weight, criterion_index in event_attributions(event):
            key = (kc_id, *(observation.get(axis) for axis in AXES), observation["item_novelty"])
            identity = (key, source_key, None if criterion_index is None else (criterion_index, kc_id))
            sig = observation_signature(event, observation, weight)
            if identity in seen_obs:
                if seen_obs[identity] != sig:
                    raise ValueError("conflicting observations of one source in one dimension")
                continue
            seen_obs[identity] = sig
            if observation["outcome"] == "unknown" or weight <= 0:
                continue
            groups[key][(source_key, criterion_index, kc_id)] = (at, observation, weight)

    # Only observations establish a posterior. The cold-start prior used by
    # information() selects a probe without creating an estimate for it.
    posterior_by_dimension = {
        key: estimate(key, observations.values(), now, dynamic=True, graded=True, confidence_weighted=False)
        for key, observations in groups.items()
    }
    ranked = []
    seen = set()
    for item in evidence["candidate_pool"]:
        ref = item["ref"]
        if ref in seen:
            raise ValueError("duplicate planning candidate")
        seen.add(ref)
        keys = list(dimensions(item))
        if ref in unavailable or not keys:
            continue
        buckets = [posterior_by_dimension.get(key) for key in keys]
        gain = sum(information(bucket[1] if bucket else None, item["item_novelty"]) for bucket in buckets)
        missing = any(bucket is None or bucket[1] is None for bucket in buckets)
        if missing:
            uncertainty = unknown("missing-independent-scored-evidence")
        elif len(buckets) > 1:
            uncertainty = unknown("multiple-dimensions")
        else:
            uncertainty = buckets[0][0]["uncertainty"]
        ranked.append({"ref": ref, "est_min": item["est_min"], "info_gain": gain / len(keys),
                       "reason_code": "probe-unknown" if missing else "reduce-uncertainty",
                       "uncertainty": uncertainty})
    ranked.sort(key=lambda row: (-row["info_gain"], row["ref"]))
    return {"method_version": "plan/information-gain@1", "ranked_candidates": ranked}
