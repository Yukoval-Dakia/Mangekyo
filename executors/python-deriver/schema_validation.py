import json
import re
import sys
from datetime import datetime
from pathlib import Path

SCHEMA = json.loads(Path(__file__).with_name("schema.json").read_text(encoding="utf-8"))
DEFINITIONS = SCHEMA["$defs"]
DERIVERS = SCHEMA["x-derivers"]


def _is_utc_timestamp(value):
    if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z", value) is None:
        return False
    try:
        # Python 3.9 accepts millisecond precision after normalization.
        instant, _, fraction = value[:-1].partition(".")
        datetime.fromisoformat(instant + "." + fraction.ljust(3, "0") + "+00:00")
        return True
    except ValueError:
        return False


def _matches(schema, value):
    if "$ref" in schema:
        name = schema["$ref"].removeprefix("#/$defs/")
        return _matches(DEFINITIONS[name], value)
    if "const" in schema:
        return value is schema["const"]
    if "not" in schema and _matches(schema["not"], value):
        return False
    if "anyOf" in schema:
        if not any(_matches(branch, value) for branch in schema["anyOf"]):
            return False
        if "type" not in schema:
            return True
    if "enum" in schema:
        return value in schema["enum"]

    kind = schema["type"]
    if kind == "object":
        properties = schema.get("properties", {})
        return (
            isinstance(value, dict)
            and all(key in value for key in schema.get("required", []))
            and all(
                _matches(properties[key], field) if key in properties else schema.get("additionalProperties", True)
                for key, field in value.items()
            )
            and (schema is not DEFINITIONS["examScore"] or value["earned"] <= value["maximum"])
            and (schema is not DEFINITIONS["itemPacing"] or value["position"] <= value["item_count"])
        )
    if kind == "array":
        return (isinstance(value, list) and ("maxItems" not in schema or len(value) <= schema["maxItems"])
                and all(_matches(schema["items"], item) for item in value))
    if kind == "null":
        return value is None
    if kind == "boolean":
        return type(value) is bool
    if kind == "string":
        return (
            isinstance(value, str)
            and len(value) >= schema.get("minLength", 0)
            and ("pattern" not in schema or re.search(schema["pattern"], value) is not None)
            and (schema.get("format") != "date-time" or _is_utc_timestamp(value))
        )
    if kind in ("number", "integer"):
        return (
            type(value) in (int, float)
            and abs(value) <= sys.float_info.max
            and (kind != "integer" or int(value) == value)
            and ("minimum" not in schema or value >= schema["minimum"])
            and ("maximum" not in schema or value <= schema["maximum"])
            and ("exclusiveMinimum" not in schema or value > schema["exclusiveMinimum"])
        )
    return False


def is_evidence_slice(value):
    if not _matches(DEFINITIONS["input"], value):
        return False
    if value.get("schema_version") == "v2":
        return "authorization" in value and all(
            "fact_ref" in event and "attribution_status" in event for event in value["events"]
        )
    return True


def is_information_gain_result(value):
    return _matches(DEFINITIONS["informationGainResult"], value)


def is_cognition_result(value):
    return _matches(DEFINITIONS["output"], value)
