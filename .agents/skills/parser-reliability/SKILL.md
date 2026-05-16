---
name: llmlake:parser-reliability
description: Use when editing parse-session.ts, adding an agent parser, or when query numbers look off. Guards against silent parser bugs that quietly distort every downstream query.
---

# Parser reliability

`queries/parser-sanity.sql` is the parser's test suite. **0 rows = healthy.** Run it before and after any `parse-session.ts` change.

```sh
./query queries/parser-sanity.sql
```

## Invariants

- Every `tool_result` has a matching `tool_call` (same `tool_call_id`, same session).
- Token / cost sums per session are unchanged after row splits — put them on the parent row only, never duplicate.
- `event_type` is never `'other'`. Add a new variant before letting anything fall through.
- Split rows get unique `row_id` and `event_id` (suffix the block index).

## Workflow

1. Edit parser.
2. Rebuild the affected agent: `rm -rf data/parquet/agent=<agent> && bun run build.ts`
3. `./query queries/parser-sanity.sql` — expect 0 rows.
4. Diff event_type counts vs. before. Surprise drops = lost rows.
5. Spot-check one session: `jq` the raw, compare to `queries/session-detail.sql`.

When discovering a new failure mode: **add a check to `parser-sanity.sql` before fixing it.** The baseline n becomes the "this got fixed" signal.

## Anti-patterns (real bugs)

- `??=` on tool blocks → only first parallel call captured.
- State updates without setting `event_type` → silent `'other'` bucket.
- Trusting line 1 for `session_id` → Codex housekeeping lines lack it; fall back to filename uuid.
- Reasoning + tool_use on one row → tool_call_id lands on a `'reasoning'` row, pairing breaks. Split it.
