"""Descriptive pacing review over authorized attempts of the same frozen exam."""

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


def _eligible_events(value):
    cutoff = _time(value["as_of_at"])
    deadlines = {}
    for deadline in value["constraints"]["deadlines"]:
        ref = deadline["ref"]
        deadlines[ref] = min(deadlines.get(ref, cutoff), _time(deadline["at"]))
    omitted = {(entry["ref"]["id"], entry["ref"]["rev"]) for entry in value.get("omissions", [])}
    return [
        event for event in value["events"]
        if "exam_pacing" in event and (event["ref"], event["rev"]) not in omitted
        and _time(event["occurred_at"]) <= min(
            deadlines.get(event["ref"], cutoff), deadlines.get(event["exam_pacing"].get("paper_key"), cutoff)
        )
    ]


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
    events = sorted(_eligible_events(evidence), key=lambda event: _time(event["occurred_at"]), reverse=True)
    attempts = []
    for event in events[:MAX_ATTEMPTS]:
        row = {"id": event["ref"], **event["exam_pacing"]}
        duration = event.get("effective_duration_ms")
        if _duration(duration):
            row["effective_duration_ms"] = duration
        attempts.append(_observe(row, CANONICAL_FIELDS))
    return attempts


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
        _record(value, ("method_version", "attempts", "strategy"))
        and value["method_version"] == METHOD_VERSION
        and _attempts(value["attempts"], valid)
    ):
        return False
    if evidence is not None and (not is_pacing_input(evidence) or value["attempts"] != _observations(evidence)):
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
    return {"method_version": method_version, "attempts": attempts, "strategy": _diagnosis(attempts)}
