#!/usr/bin/env python3
import json
import sys
from pathlib import Path

# The host starts Python in isolated mode. Load only sibling worker modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from schema_validation import DERIVERS, is_cognition_result, is_evidence_slice


def handle(request):
    if not isinstance(request, dict) or not isinstance(request.get("id"), str):
        return {"id": None, "error": "invalid request"}
    request_id = request["id"]
    deriver = request.get("deriver")
    version = DERIVERS.get(deriver) if isinstance(deriver, str) else None
    if version is None or request.keys() != {"id", "deriver", "input"}:
        return {"id": request_id, "error": "invalid request"}

    evidence = request["input"]
    if not is_evidence_slice(evidence):
        return {"id": request_id, "error": "invalid CanonicalEvidenceSlice@v1"}
    try:
        from cognition import derive

        result = derive(evidence, method_version=version)
        if not is_cognition_result(result) or result["method_version"] != version:
            return {"id": request_id, "error": "invalid cognition output"}
        return {"id": request_id, "value": {"kind": "value", "value": result}}
    except Exception:
        return {"id": request_id, "error": "cognition computation failed"}


def main():
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except (ValueError, RecursionError):
            response = {"id": None, "error": "invalid JSON"}
        else:
            response = handle(request)
        sys.stdout.write(json.dumps(response, allow_nan=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
