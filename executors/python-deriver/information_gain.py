"""Expected information from an independent answer to a planning candidate."""
from collections import defaultdict

from cognition import dimensions, estimate, information, instant, unknown


def derive(evidence):
    now = instant(evidence["as_of_at"])
    omitted = {(entry["ref"]["id"], entry["ref"]["rev"]) for entry in evidence.get("omissions", [])}
    unavailable = {ref for ref, _ in omitted} | set(evidence["constraints"]["locks"])
    groups = defaultdict(dict)
    for event in evidence["events"]:
        at = instant(event["occurred_at"])
        if at > now or (event["ref"], event["rev"]) in omitted:
            continue
        unavailable.add(event["ref"])
        if event["help_level"] != "independent" or event["outcome"] == "unknown":
            continue
        for key in dimensions(event):
            group = groups[key]
            previous = group.get(event["ref"])
            if previous is not None and previous[1] != event:
                raise ValueError("conflicting observations of one source in one dimension")
            group[event["ref"]] = (at, event)

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
        missing = any(bucket is None for bucket in buckets)
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
