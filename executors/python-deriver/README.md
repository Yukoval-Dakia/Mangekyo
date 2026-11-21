# @mangekyo/python-deriver

The long-lived pure-computation worker uses line-delimited JSON (kernel design §11).
The TypeScript caller awaits `createPythonDeriverHost().derive(deriver, input)`
and closes the host during shutdown.

| Deriver route | Method version |
| --- | --- |
| `learner/cognition@3` | `cognition@3` (an independent correct answer with confidence ≤0.35 contributes one quarter of its positive mastery and stability gain) |
| `learner/cognition@2` | `cognition@2` (graded exposure, error stage and high-confidence probes) |
| `learner/cognition@1` | `cognition@1` |
| `learner/retention-forecast@1` | `dimensioned-retention@1` |
| `learner/intervention-lift@1` | `intervention-lift@1` |
| `plan/exam-pacing@1` | `plan/exam-pacing@1` |
| `plan/exam-pacing@2` | `plan/exam-pacing@2` (one submission’s item time-value bar) |

All four retention routes accept only the v1 slice defined by [schema.json](./schema.json).
`@mangekyo/kernel` exports the input type `CanonicalEvidenceSliceV1`.
`schema.ts` exports `CognitionResult` and the input and output guards
for composition callers. Ticks are unsigned decimal strings. Timestamps use UTC
`Z` and millisecond precision. Scores and confidence use the unit interval.

Lift takes the sealed intervention and prospectively paired baseline and posttest records. The host validates its Outcome against that input. An insufficient sample returns `{kind: "unknown", reason}`. The gather must have research authorization for the full evidence chain.

Exam pacing accepts the v1 slice and selects up to eight authorized whole-paper attempts. It compares attempts with matching frozen paper, scoring scale and maximum score. The earlier sealed attempts input remains supported. Its input contains the actual effective duration and official score for each attempt. Missing observations remain unknown in the result. The caller retains the source revisions and restores their authorization before displaying the diagnosis.

The opt-in `plan/exam-pacing@2` takes `{slice, attempt_ref}`. This route has its
own output contract so a sealed `@1` request still replays its original result.
The exact submission revision must have an eligible `exam_pacing` event with
the frozen `paper_key`. Use the authorized release's `scale_key` when there are
formal item scores. The gather projects these separate neutral `exam_pacing_item`
events, with the same attempt reference, frozen paper key and item ID, position
and count on each event:

- Process records carry the observed `effective_duration_ms` and any recorded
  `skipped` and `returned` flags.
- Estimates carry an authorized item-level `estimated_duration_ms` established
  by submission time.
- Formal assessments carry the actual item score and matching release scale,
  recorded at or after submission. Include `error_stage` only when witnessed
  for that scored item.

Process positions must cover the frozen paper. A missing or conflicting
duration, or a zero total, returns `kind: "unknown"` without item IDs or lengths.
The observed result includes item states in frozen order, the sum of measured
item durations and one descriptive sentence. Segment lengths use measured item
time. The classifier checks recovered skip with positive formal credit first,
then full credit. A shortfall after more than 1.8 times the estimate is a time
sink. A shortfall below the estimate with a reading or execution error is a fast
slip. Insufficient classification evidence yields an unknown item state.

Studio must project only sources read at the fixed watermark with current
purpose and recipient permission. Recheck source revisions and access epochs
before delivering the result. The worker applies the sealed UTC cutoffs and
omissions. Keep source evidence and access checks at the host.

The worker receives only `{id, deriver, input}`. It replies with
`{id, value: {kind: "value", value: result}}` or a Lift unknown Outcome, or `{id, error}`. An estimate
with `state: "unknown"` is a value. Process failures resolve as `kind: "failed"`.
The host matches active request ids and kills a timed-out process. It starts
a fresh process on a subsequent call after the configured restart delay.

The child receives no inherited environment. Use the absolute interpreter path
in `MANGEKYO_PYTHON` or the host's `python` option if needed. The worker runs
trusted repository code and dispatches the validated input to the selected sibling calculator.

Studio must gather the authorized slice and seal its manifest in the kernel,
then submit the worker's result using the same work generation and sealed
candidate id. Temporal owns retries. Keep unobserved independence in the
original sealed input without relabelling it in the v1 projection.

`host.test.ts` uses the same fixed-clock sample through the TS host and the raw
Python protocol. Historical PostgreSQL and Temporal evidence for the reused
host at `61ca686` remains in `executors/python-deriver/evidence/retention-acceptance.json`
in that commit. That run used the pre-v1 projection and covered issuance,
independent submission, reconciliation, Shadow and revocation.
