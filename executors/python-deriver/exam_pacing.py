"""Descriptive pacing review over authorized attempts of the same frozen exam."""

import json
import sys
from datetime import datetime
from itertools import combinations

from schema_validation import is_evidence_slice


METHOD_VERSION = "plan/exam-pacing@1"
MAX_ATTEMPTS = 8
FIELDS = ("effective_duration_ms", "score")
BASIS = ("paper_key", "scale_key")
CANONICAL_FIELDS = (*FIELDS, *BASIS)


def _record(value, required, optional=()):
    return isinstance(value, dict) and set(required) <= value.keys() <= set(required) | set(optional)


def _number(value, low, high):
    return type(value) in (int, float) and low <= value <= high


def _duration(value):
    return _number(value, 1, 86_400_000) and value == int(value)


def _item_duration(value):
    return _number(value, 0, 86_400_000) and value == int(value)


def _score(value):
    return (
        _record(value, ("earned", "maximum"))
        and _number(value["maximum"], 0, sys.float_info.max)
        and value["maximum"] > 0
        and _number(value["earned"], 0, value["maximum"])
    )


def _key(value):
    return isinstance(value, str) and bool(value.strip())


def _attempts(value, validate):
    return (
        isinstance(value, list)
        and len(value) <= MAX_ATTEMPTS
        and all(validate(row) and _key(row["id"]) for row in value)
        and len({row["id"] for row in value}) == len(value)
    )


def _time(value):
    instant, _, fraction = value[:-1].partition(".")
    return datetime.fromisoformat(instant + "." + fraction.ljust(3, "0") + "+00:00")


def _evidence_window(value):
    cutoff = _time(value["as_of_at"])
    deadlines = {}
    for deadline in value["constraints"]["deadlines"]:
        ref = deadline["ref"]
        deadlines[ref] = min(deadlines.get(ref, cutoff), _time(deadline["at"]))
    omitted = {(entry["ref"]["id"], entry["ref"]["rev"]) for entry in value.get("omissions", [])}

    def eligible(event, *refs):
        return ((event["ref"], event["rev"]) not in omitted and _time(event["occurred_at"]) <=
                min(deadlines.get(ref, cutoff) for ref in (event["ref"], *refs)))

    return eligible


def _eligible_events(value):
    eligible = _evidence_window(value)
    return [
        event for event in value["events"]
        if "exam_pacing" in event and eligible(event, event["exam_pacing"].get("paper_key"))
    ]


def _recent_attempts(value):
    return sorted(_eligible_events(value), key=lambda event: _time(event["occurred_at"]), reverse=True)[:MAX_ATTEMPTS]


def is_pacing_input(value):
    def valid(row):
        return (
            _record(row, ("id",), FIELDS)
            and (row.get("effective_duration_ms") is None or _duration(row["effective_duration_ms"]))
            and (row.get("score") is None or _score(row["score"]))
        )

    if _record(value, ("attempts",)):
        return _attempts(value["attempts"], valid)
    if not is_evidence_slice(value):
        return False
    for event in value["events"]:
        item = event.get("exam_pacing_item")
        if item is not None and not (
            _key(event["ref"]) and _key(item["item_id"]) and item["position"] <= item["item_count"]
            and ("score" not in item or _key(item.get("scale_key")))
            and ("effective_duration_ms" not in event or _item_duration(event["effective_duration_ms"]))
        ):
            return False
        if "exam_pacing" not in event:
            continue
        details = event["exam_pacing"]
        if not (
            _key(event["ref"]) and _record(details, (), (*BASIS, "score"))
            and all(field not in details or _key(details[field]) for field in BASIS)
            and ("score" not in details or _score(details["score"]))
        ):
            return False
    refs = [event["ref"] for event in _eligible_events(value)]
    return len(set(refs)) == len(refs)


def _observe(row, required):
    missing = [field for field in required if row.get(field) is None]
    if missing:
        return {"id": row["id"], "kind": "unknown", "missing": missing}
    score = row["score"]
    return {**row, "kind": "observed", "score_rate": score["earned"] / score["maximum"]}


def _observations(evidence):
    if "attempts" in evidence:
        return [_observe(row, FIELDS) for row in evidence["attempts"]]
    attempts = []
    for event in _recent_attempts(evidence):
        row = {"id": event["ref"], **event["exam_pacing"]}
        duration = event.get("effective_duration_ms")
        if _duration(duration):
            row["effective_duration_ms"] = duration
        attempts.append(_observe(row, CANONICAL_FIELDS))
    return attempts


def _read_items(items):
    return {"kind": "observed", "items": items} if items else {"kind": "unknown"}


def _attempt_items(attempt, items):
    attempt_ref = {"id": attempt["ref"], "rev": attempt["rev"]}
    pacing = attempt["exam_pacing"]
    paper_key = pacing.get("paper_key")
    submitted_at = _time(attempt["occurred_at"])
    positions, ids, scores = {}, {}, {}
    process = []
    count = halfway = 0
    process_ids = set()
    duplicate_score = False
    for event, item in items:
        if item["attempt_ref"] != attempt_ref or item["paper_key"] != paper_key:
            continue
        occurred_at = event["occurred_at"]
        time = _time(occurred_at)
        elapsed = event.get("effective_duration_ms")
        # Process precedes submission. A formal score may settle later within the evidence window.
        has_process = time <= submitted_at and (item.get("skipped") or item.get("returned") or _item_duration(elapsed))
        score = item.get("score") if time >= submitted_at and pacing.get("scale_key") == item.get("scale_key") else None
        if not (has_process or score):
            continue
        if count == 0:
            count = int(item["item_count"])
            halfway = (count + 1) // 2
        item_id, position = item["item_id"], item["position"]
        if (item["item_count"] != count or positions.get(position, item_id) != item_id
                or ids.get(item_id, position) != position):
            return {"attempt_ref": attempt_ref, "process": _read_items([]), "later_scores": _read_items([])}
        positions[position], ids[item_id] = item_id, position
        anchor = {"item_id": item_id, "position": position, "evidence_ref": {"id": event["ref"], "rev": event["rev"]},
                  "occurred_at": occurred_at}
        estimate = item.get("estimated_duration_ms")
        if has_process:
            if item_id in process_ids:
                return {"attempt_ref": attempt_ref, "process": _read_items([]), "later_scores": _read_items([])}
            process_ids.add(item_id)
            row = {**anchor, **{key: item[key] for key in ("skipped", "returned", "estimated_duration_ms") if key in item}}
            if _item_duration(elapsed):
                row["effective_duration_ms"] = elapsed
                if estimate is not None:
                    row["over_estimate"] = 5 * elapsed > 9 * estimate
            process.append(row)
        if position > halfway and score:
            duplicate_score = duplicate_score or position in scores
            scores[position] = {**anchor, "score": score}
    later = [scores[pos] for pos in sorted(scores)] if not duplicate_score and len(scores) == count - halfway else []
    earned_later = any(row["score"]["earned"] > 0 for row in later)
    missed_later = any(row["score"]["earned"] < row["score"]["maximum"] for row in later)
    for row in process:
        if row["position"] > halfway:
            continue
        if row.get("skipped") and row.get("over_estimate") is False and earned_later:
            row["later_score_context"] = "timely-skip-with-later-credit"
        if row.get("over_estimate") and missed_later:
            row["later_score_context"] = "overrun-with-later-shortfall"
    return {"attempt_ref": attempt_ref, "process": _read_items(process), "later_scores": _read_items(later)}


def _within_attempt(evidence):
    if "attempts" in evidence:
        return None
    eligible = _evidence_window(evidence)
    items = [(event, item) for event in evidence["events"] if (item := event.get("exam_pacing_item"))
             and eligible(event, item["paper_key"], item["attempt_ref"]["id"])]
    if not items:
        return None
    return [_attempt_items(attempt, items) for attempt in _recent_attempts(evidence)]


def _diagnosis(attempts):
    observed = [row for row in attempts if row["kind"] == "observed"]
    comparisons = []
    comparable = False
    for first, second in combinations(observed, 2):
        if first["score"]["maximum"] != second["score"]["maximum"] or any(
            first.get(field) != second.get(field) for field in BASIS
        ):
            continue
        comparable = True
        faster, slower = sorted((first, second), key=lambda row: row["effective_duration_ms"])
        extra = slower["effective_duration_ms"] - faster["effective_duration_ms"]
        if extra > 0 and faster["score"]["earned"] >= slower["score"]["earned"]:
            comparisons.append({
                "slower_attempt_id": slower["id"],
                "faster_attempt_id": faster["id"],
                "extra_duration_ms": extra,
                "score_rate_gap": faster["score_rate"] - slower["score_rate"],
            })
    if not comparable:
        return {"kind": "unknown", "reason": "insufficient-comparable-attempts"}
    return {"kind": "observed", "comparisons": comparisons}


def is_pacing_result(value, evidence=None):
    def valid(row):
        if _record(row, ("id", "kind", "missing")) and row["kind"] == "unknown":
            missing = row["missing"]
            return isinstance(missing, list) and bool(missing) and missing == [key for key in CANONICAL_FIELDS if key in missing]
        return (
            _record(row, ("id", "kind", *FIELDS, "score_rate"), BASIS)
            and (all(_key(row.get(field)) for field in BASIS) or all(field not in row for field in BASIS))
            and row["kind"] == "observed"
            and _duration(row["effective_duration_ms"])
            and _score(row["score"])
            and _number(row["score_rate"], 0, 1)
            and row["score_rate"] == row["score"]["earned"] / row["score"]["maximum"]
        )

    if not (
        _record(value, ("method_version", "attempts", "strategy"), ("within_attempt",))
        and value["method_version"] == METHOD_VERSION
        and _attempts(value["attempts"], valid)
    ):
        return False
    if evidence is not None and (not is_pacing_input(evidence) or value["attempts"] != _observations(evidence)):
        return False
    within = _within_attempt(evidence) if evidence is not None else None
    if within is None:
        if "within_attempt" in value:
            return False
    elif json.dumps(value.get("within_attempt"), sort_keys=True) != json.dumps(within, sort_keys=True):
        return False
    strategy = value["strategy"]
    expected = _diagnosis(value["attempts"])
    return strategy == expected and (
        expected["kind"] == "unknown"
        or all(
            _duration(row["extra_duration_ms"]) and _number(row["score_rate_gap"], 0, 1)
            for row in strategy["comparisons"]
        )
    )


def derive(evidence, *, method_version=METHOD_VERSION):
    if method_version != METHOD_VERSION or not is_pacing_input(evidence):
        raise ValueError("invalid exam pacing input or method")
    attempts = _observations(evidence)
    result = {"method_version": method_version, "attempts": attempts, "strategy": _diagnosis(attempts)}
    within = _within_attempt(evidence)
    if within is not None:
        result["within_attempt"] = within
    return result


TIME_VALUE_METHOD = "plan/exam-pacing@2"


def is_time_value_input(value):
    if not _record(value, ("slice", "attempt_ref")) or not is_evidence_slice(value["slice"]):
        return False
    ref = value["attempt_ref"]
    return (_record(ref, ("id", "rev")) and _key(ref["id"])
            and _number(ref["rev"], 1, 2**53 - 1) and ref["rev"] == int(ref["rev"]))


def _item_state(process, formal, estimate):
    if formal is None:
        return "unknown"
    marker = process["exam_pacing_item"]
    score = formal["exam_pacing_item"]["score"]
    earned, maximum = score["earned"], score["maximum"]
    if marker.get("skipped") and marker.get("returned") and earned > 0:
        return "recovered-skip"
    if earned == maximum:
        return "steady"
    if estimate is None:
        return "unknown"
    elapsed = process["effective_duration_ms"]
    expected = estimate["exam_pacing_item"]["estimated_duration_ms"]
    if 5 * elapsed > 9 * expected:
        return "time-sink"
    if elapsed < expected and formal.get("error_stage") in ("reading", "execution"):
        return "fast-slip"
    return "unknown"


def _time_value_summary(items):
    labels = (("steady", "拿满分"), ("fast-slip", "低耗时失分"),
              ("time-sink", "超估时失分"), ("recovered-skip", "回访得分"))
    observations = []
    for state, label in labels:
        count = sum(row["state"] == state for row in items)
        if count:
            observations.append(f"{count} 题{label}")
    if not observations:
        return "本卷各题的节奏证据仍不足。"
    unknown = sum(row["state"] == "unknown" for row in items)
    suffix = f"，另有 {unknown} 题节奏未确认。" if unknown else "。"
    return "本卷有 " + "、".join(observations) + suffix


def _item_role(event, submitted_at, scale_key):
    item = event["exam_pacing_item"]
    time = _time(event["occurred_at"])
    has_process = "effective_duration_ms" in event or "skipped" in item
    has_estimate = "estimated_duration_ms" in item
    has_score = "score" in item
    if sum((has_process, has_estimate, has_score)) != 1:
        return None
    if has_process and time <= submitted_at:
        return "process"
    if has_estimate and time <= submitted_at:
        return "estimate"
    if has_score and time >= submitted_at and _key(scale_key) and item["scale_key"] == scale_key:
        return "formal"
    return None


def derive_time_value(value):
    evidence, ref = value["slice"], value["attempt_ref"]
    base = {"method_version": TIME_VALUE_METHOD, "attempt_ref": ref}
    unknown = {**base, "kind": "unknown"}
    eligible = _evidence_window(evidence)
    attempts = [event for event in _eligible_events(evidence)
                if event["ref"] == ref["id"] and event["rev"] == ref["rev"]]
    if len(attempts) != 1:
        return unknown
    attempt = attempts[0]
    paper_key = attempt["exam_pacing"].get("paper_key")
    if not _key(paper_key):
        return unknown
    submitted_at = _time(attempt["occurred_at"])
    scale_key = attempt["exam_pacing"].get("scale_key")
    items, positions = {}, {}
    process_witnesses = set()
    counts = set()
    classifications = []
    for event in evidence["events"]:
        item = event.get("exam_pacing_item")
        if not item or item["attempt_ref"] != ref or item["paper_key"] != paper_key:
            continue
        if not eligible(event, paper_key, ref["id"]):
            continue
        role = _item_role(event, submitted_at, scale_key)
        if role is None or not _key(event["ref"]):
            continue
        if role != "process":
            classifications.append((role, event))
            continue
        item_id, position = item["item_id"], item["position"]
        if not _key(item_id) or item_id in items or position in positions:
            return unknown
        witness = (event["ref"], event["rev"])
        if witness in process_witnesses:
            return unknown
        process_witnesses.add(witness)
        positions[position] = item_id
        counts.add(item["item_count"])
        items[item_id] = {"process": event}
    if counts != {len(positions)}:
        return unknown

    # Process rows projected from the frozen paper define coverage and order.
    for role, event in classifications:
        item = event["exam_pacing_item"]
        row = items.get(item["item_id"])
        if row is None:
            continue
        process = row["process"]
        anchor = process["exam_pacing_item"]
        if (item["position"] != anchor["position"] or item["item_count"] != anchor["item_count"]
                or event["ref"] == process["ref"]):
            continue
        row[role] = event if role not in row else None
    outputs = []
    for position, item_id in sorted(positions.items()):
        row = items[item_id]
        process = row["process"]
        if not _item_duration(process.get("effective_duration_ms")):
            return unknown
        formal, estimate = row.get("formal"), row.get("estimate")
        if formal and estimate and formal["ref"] == estimate["ref"]:
            estimate = None
        outputs.append({"item_id": item_id, "position": position, "effective_duration_ms": process["effective_duration_ms"],
                        "state": _item_state(process, formal, estimate)})
    total = sum(row["effective_duration_ms"] for row in outputs)
    whole_duration = attempt.get("effective_duration_ms")
    if total == 0 or (whole_duration is not None and (not _item_duration(whole_duration) or total > whole_duration)):
        return unknown
    return {**base, "kind": "observed", "total_duration_ms": total, "items": outputs,
            "summary": _time_value_summary(outputs)}
