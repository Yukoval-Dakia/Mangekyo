# Research triage assets

Local, model-agnostic assets for the Always-Doing sentinel described in `docs/design/always-doing-and-agent-tools.md` §2.2–§2.3.

- `skills.ts` — six fixed skill cards with `when` / `when_not` / `must_check` / `todo_template` / `examples`, plus deterministic selection of 2–3 cards for a wake source.
- `snapshot.ts` — local snapshot shape and validator for facts, events, todos, inventory, forecasts, work, memos, signals, chain and budget. IDs must be snapshot ULIDs; revisions/ticks are strings or positive integers.
- `response.ts` — strict single-JSON response parser. It rejects extra fields, expression-like text, IDs outside the snapshot, and any `emit_todo` fields not copied from the matched card template. Models never write trigger expressions.
- `fixtures.json` — 30 golden triage scenarios covering repeated misconceptions, ready/used/withdrawn inventory, scheduled and due time points, empty water levels, fatigue/undo withdrawals, goal shifts, completed/failed work, ambiguous deep cases, and invalid outputs.
- `fixtures.ts` — fixture loader and scorer. Reports hits, false positives, misses, withdrawal hits/misses, invalid responses, and rates.
- `score-fixtures.mjs` — runnable entry for bundled simulated outputs from the repository root: `pnpm --filter @mangekyo/studio exec tsx runtime/studio/research-triage/score-fixtures.mjs`. These are fixture outputs for scoring/validator regression, not a real-model evaluation.

This directory intentionally has no PG/schema, Temporal, provider, UI, or shared package changes. A later host can materialize the same snapshot from PG, call a cheap model with `triagePromptBlock(wakeSource)`, then pass the raw reply through `parseTriageResponse` before applying orchestration primitives. No credentials or paid model are used here.
