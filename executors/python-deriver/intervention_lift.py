"""Deterministic reconciliation of prospectively paired teaching interventions."""
from datetime import datetime, timezone
from math import isfinite, log, sqrt
import re

METHOD_VERSION = "intervention-lift@1"
_MIN_ELIGIBLE = 8  # Smallest cohort whose bounded interval can exclude zero.
_MAX_SAFE_INTEGER = 2**53 - 1
_DAY_MS = 86_400_000
_ID = re.compile(r"[0-9A-HJKMNP-TV-Z]{26}")
_EPOCH = re.compile(r"0|[1-9][0-9]*")
_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")
_JS_SPACE = " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_IDENTITY = ("playbookId", "version", "strategyId")
_PLAN = ("plannedBaselineItem", "plannedPosttestItem", "comparisonKey")


def _object(value, keys):
    return isinstance(value, dict) and value.keys() == set(keys)


def _integer(value):
    return type(value) in (float, int) and 1 <= value <= _MAX_SAFE_INTEGER and int(value) == value


def _matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _instant(value):
    if not _matches(_TIME, value):
        raise ValueError("expected canonical UTC timestamp")
    at = datetime.fromisoformat(value[:-1] + "+00:00")
    elapsed = at - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return elapsed.days * _DAY_MS + elapsed.seconds * 1000 + elapsed.microseconds // 1000


def _ref(value):
    return (_object(value, ("id", "rev", "accessEpoch")) and _matches(_ID, value["id"])
            and _integer(value["rev"]) and _matches(_EPOCH, value["accessEpoch"]))


def _assessment(value):
    if value is None:
        return True
    if not _object(value, ("item", "comparisonKey", "submission", "occurredAt", "novelty", "independence", "score")):
        return False
    _instant(value["occurredAt"])
    score = value["score"]
    return (isinstance(value["item"], str) and isinstance(value["comparisonKey"], str)
            and _ref(value["submission"])
            and value["novelty"] in ("same", "isomorphic", "transfer", "unknown")
            and value["independence"] in ("independent", "assisted", "unknown")
            and (score is None or (type(score) in (float, int) and 0 <= score <= 1 and isfinite(score))))


def is_lift_input(value):
    if not _object(value, (*_IDENTITY, "asOf", "interventions")):
        return False
    if (not _matches(_ID, value["playbookId"]) or not _integer(value["version"])
            or not isinstance(value["strategyId"], str) or not value["strategyId"].strip(_JS_SPACE)
            or not isinstance(value["interventions"], list)):
        return False
    try:
        _instant(value["asOf"])
        for pair in value["interventions"]:
            if (not _object(pair, (*_IDENTITY, *_PLAN, "intervention", "deliveredAt", "baseline", "posttest"))
                    or not _integer(pair["version"]) or any(pair[key] != value[key] for key in _IDENTITY)
                    or not all(isinstance(pair[key], str) for key in _PLAN)
                    or not _ref(pair["intervention"]) or not _assessment(pair["baseline"])
                    or not _assessment(pair["posttest"])):
                return False
            _instant(pair["deliveredAt"])
    except ValueError:
        return False
    return True


def _eligible(assessment, item, comparison):
    return (assessment is not None and assessment["item"] == item
            and assessment["comparisonKey"] == comparison
            and assessment["independence"] == "independent" and assessment["score"] is not None)


def derive(input, method_version=METHOD_VERSION):
    if method_version != METHOD_VERSION or not is_lift_input(input):
        raise ValueError("invalid intervention-lift@1 input or method")
    as_of = _instant(input["asOf"])
    interventions, submissions = set(), set()
    refs = []
    total = 0.0
    eligible = unresolved = pending = 0
    for pair in input["interventions"]:
        start = _instant(pair["deliveredAt"])
        if start > as_of:
            continue
        intervention = pair["intervention"]
        if intervention["id"] in interventions or intervention["id"] in submissions:
            raise ValueError("duplicate intervention")
        interventions.add(intervention["id"])
        if as_of < start + 14 * _DAY_MS:
            pending += 1
            continue
        refs.append(intervention)
        before, after = pair["baseline"], pair["posttest"]
        pre, post, comparison = (pair[key] for key in _PLAN)
        if (not all(field.strip(_JS_SPACE) for field in (pre, post, comparison)) or pre == post
                or not _eligible(before, pre, comparison) or not _eligible(after, post, comparison)
                or after["novelty"] not in ("isomorphic", "transfer") or _instant(before["occurredAt"]) >= start
                or not start + 3 * _DAY_MS <= _instant(after["occurredAt"]) <= start + 14 * _DAY_MS):
            unresolved += 1
            continue
        for assessment in (before, after):
            ref = assessment["submission"]
            if ref["id"] in submissions or ref["id"] in interventions:
                raise ValueError("duplicate independent submission")
            submissions.add(ref["id"])
            refs.append(ref)
        eligible += 1
        total += after["score"] - before["score"]
    if eligible < _MIN_ELIGIBLE:
        return {"kind": "unknown", "reason": f"已满 14 天的可比独立前后测不足（{eligible}/{_MIN_ELIGIBLE}）。"}

    # Missing or contaminated pairs remain in the denominator. Bound each
    # missing difference by [-1,1] and use the original two-sided 95% interval.
    closed = eligible + unresolved
    radius = sqrt(2 * log(40) / closed)
    low = max(-1, (total - unresolved) / closed - radius)
    high = min(1, (total + unresolved) / closed + radius)
    verdict = "positive" if low > 0 else "negative" if high < 0 else "inconclusive"
    return {"kind": "value", "value": {
        **{key: input[key] for key in _IDENTITY}, "verdict": verdict, "interval": [low, high],
        "pairedMean": total / eligible, "eligible": eligible, "unresolved": unresolved, "pending": pending,
        "verificationRefs": refs,
    }}
