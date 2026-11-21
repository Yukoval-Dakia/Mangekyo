#!/usr/bin/env python3
import json
import sys
from pathlib import Path

# The host starts Python in isolated mode. Load only sibling worker modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from schema_validation import DERIVERS, is_cognition_result, is_evidence_slice, is_information_gain_result


def handle(request):
    if not isinstance(request, dict) or not isinstance(request.get("id"), str):
        return {"id": None, "error": "invalid request"}
    request_id = request["id"]
    deriver = request.get("deriver")
    version = DERIVERS.get(deriver) if isinstance(deriver, str) else None
    if version is None or request.keys() != {"id", "deriver", "input"}:
        return {"id": request_id, "error": "invalid request"}

    evidence = request["input"]
    try:
        if version == "intervention-lift@1":
            from intervention_lift import derive
            return {"id": request_id, "value": derive(evidence, method_version=version)}
        if version == "plan/exam-pacing@1":
            import exam_pacing
            if not exam_pacing.is_pacing_input(evidence):
                return {"id": request_id, "error": "invalid exam pacing input"}
            result = exam_pacing.derive(evidence, method_version=version)
            if not exam_pacing.is_pacing_result(result, evidence):
                return {"id": request_id, "error": "invalid exam pacing output"}
            return {"id": request_id, "value": {"kind": "value", "value": result}}
        if not is_evidence_slice(evidence):
            return {"id": request_id, "error": "invalid CanonicalEvidenceSlice@v1"}
        if version == "plan/information-gain@1":
            import information_gain

            result = information_gain.derive(evidence)
            if not is_information_gain_result(result):
                return {"id": request_id, "error": "invalid information gain output"}
            return {"id": request_id, "value": {"kind": "value", "value": result}}
        from cognition import derive

        result = derive(evidence, method_version=version)
        if not is_cognition_result(result) or result["method_version"] != version:
            return {"id": request_id, "error": "invalid cognition output"}
        return {"id": request_id, "value": {"kind": "value", "value": result}}
    except Exception:
        return {"id": request_id, "error": "deriver computation failed"}


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
