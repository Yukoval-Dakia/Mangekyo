# @mangekyo/python-deriver

The long-lived pure-computation worker uses line-delimited JSON (kernel design §11).
The TypeScript caller awaits `createPythonDeriverHost().derive(deriver, input)`
and closes the host during shutdown.

| Deriver route | Method version |
| --- | --- |
| `learner/cognition@1` | `cognition@1` |
| `learner/retention-forecast@1` | `dimensioned-retention@1` |

Both routes accept only the v1 slice defined by [schema.json](./schema.json).
`schema.ts` exports `CanonicalEvidenceSlice`, `CognitionResult` and their guards
for composition callers. Ticks are unsigned decimal strings. Timestamps use UTC
`Z` and millisecond precision. Scores and confidence use the unit interval.

The worker receives only `{id, deriver, input}`. It replies with
`{id, value: {kind: "value", value: result}}` or `{id, error}`. An estimate
with `state: "unknown"` is a value. Process failures resolve as `kind: "failed"`.
The host matches active request ids and kills a timed-out process. It starts
a fresh process on a subsequent call after the configured restart delay.

The child receives no inherited environment. Use the absolute interpreter path
in `MANGEKYO_PYTHON` or the host's `python` option if needed. The worker runs
trusted repository code and passes the validated slice to the sibling
`cognition.py` with the selected method version.

Studio must gather the authorized slice and seal its manifest in the kernel,
then submit the worker's result using the same work generation and sealed
candidate id. Temporal owns retries. Keep unobserved independence in the
original sealed input without relabelling it in the v1 projection.

`host.test.ts` uses the same fixed-clock sample through the TS host and the raw
Python protocol. Historical PostgreSQL and Temporal evidence for the reused
host at `61ca686` remains in `executors/python-deriver/evidence/retention-acceptance.json`
in that commit. That run used the pre-v1 projection and covered issuance,
independent submission, reconciliation, Shadow and revocation.
