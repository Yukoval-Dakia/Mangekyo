"""Descriptive pacing review over authorized attempts of the same frozen exam."""

import sys
from itertools import combinations


METHOD_VERSION = "plan/exam-pacing@1"
MAX_ATTEMPTS = 8
FIELDS = ("effective_duration_ms", "score")


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


def _attempts(value, validate):
    return (
        isinstance(value, list)
        and len(value) <= MAX_ATTEMPTS
        and all(validate(row) and isinstance(row["id"], str) and row["id"].strip() for row in value)
        and len({row["id"] for row in value}) == len(value)
    )


def is_pacing_input(value):
    def valid(row):
        return (
            _record(row, ("id",), FIELDS)
            and (row.get("effective_duration_ms") is None or _duration(row["effective_duration_ms"]))
            and (row.get("score") is None or _score(row["score"]))
        )

    return _record(value, ("attempts",)) and _attempts(value["attempts"], valid)


def _observe(row):
    missing = [field for field in FIELDS if row.get(field) is None]
    if missing:
        return {"id": row["id"], "kind": "unknown", "missing": missing}
    score = row["score"]
    return {**row, "kind": "observed", "score_rate": score["earned"] / score["maximum"]}


def _diagnosis(attempts):
    observed = [row for row in attempts if row["kind"] == "observed"]
    comparisons = []
    comparable = False
    for first, second in combinations(observed, 2):
        if first["score"]["maximum"] != second["score"]["maximum"]:
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


def is_pacing_result(value):
    def valid(row):
        if _record(row, ("id", "kind", "missing")) and row["kind"] == "unknown":
            missing = row["missing"]
            return isinstance(missing, list) and bool(missing) and missing == [key for key in FIELDS if key in missing]
        return (
            _record(row, ("id", "kind", *FIELDS, "score_rate"))
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
    attempts = [_observe(row) for row in evidence["attempts"]]
    return {"method_version": method_version, "attempts": attempts, "strategy": _diagnosis(attempts)}
