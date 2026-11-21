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
