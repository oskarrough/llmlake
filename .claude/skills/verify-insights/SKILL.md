---
name: llmlake:verify-insights
description: Audit a generated insights report against the parquet lake. Re-runs each saved query and flags numbers or prose the data does not support. Use after `generate-insights`, or when the user asks to verify a report.
---

You are an adversarial verifier. Your job is to find places where the
report claims something the data does not actually say.

## Inputs

A report directory: `data/reports/<ts>/`, containing `report.html` and
`queries/<module-id>.sql`. If the user didn't give one, pick the most
recent under `data/reports/`.

## Procedure

1. **Re-run every saved query** via `./llmlake query`. Capture the rows.

2. **For each `<section>` in the report:**
   - Extract every number, percentage, model name, tool name, session id,
     and named claim from the prose and tables.
   - Locate the saved query for that module (`queries/<section-id>.sql`).
     Confirm each claimed value appears in the re-run rows. If a value
     does not appear, that's a **flag**.
   - Check that the lede sentence is supported by the query rows — not
     just numerically, but the *qualitative* claim too. E.g. if the lede
     says "errors concentrated in `Bash`", confirm `Bash` actually has the
     highest absolute error count among tools with enough calls to
     compare.

3. **For freeform sections:** confirm the cited `<details>` query
   exists as a saved SQL file and that the prose claims match its rows.
   If a freeform section makes a claim with no embedded query, that's a
   flag.

4. **Cross-checks worth running:**

   *Period reports* (the report has `at-a-glance` / `cost-breakdown` /
   `notable-sessions` sections):
   - Sum of per-row costs in `cost-breakdown` matches the total in
     `at-a-glance` within rounding (±$0.01).
   - Sessions count in `at-a-glance` matches the sessions count you get
     re-running the same period filter.
   - `notable-sessions` rows actually exist in the lake (re-query by
     `session_id`).

   *Session reports* (the report has a `summary` section and a single
   `session_id` scope):
   - Counts in `summary` (events, user_msgs, tool_calls, errors) match
     re-running its query for the same `session_id`.
   - Sum of `tool-trace` rows' `calls` equals `summary.tool_calls`.
   - Sum of `tool-trace` rows' `errors` equals `summary.errors` (or
     differs by exactly the count of tool_call events with no matching
     tool_result — note that under Notes, not a flag).
   - Number of rows in `asks` equals `summary.user_msgs`.

5. **Write `review.md`** in the report directory. Format:

   ```markdown
   # Review of report.html

   Verifier ran <N> queries. Found <M> flags.

   ## Flags

   - **<module-id>** — <one-sentence description of the discrepancy>.
     Expected from query: <value>. Report says: <value>.

   ## Cross-checks

   - <name>: pass / FAIL (<detail>)

   ## Notes

   - <anything notable that isn't a flag but is worth knowing>
   ```

   If there are zero flags, say so plainly and keep `review.md` short.

## Rules

- You are looking for things to flag. Do not soften findings.
- Rounding differences within ±1% on an aggregate are not flags. State
  them under Notes if at all.
- If a saved query is missing for a module that has a section in the
  report, flag it — the report is not reproducible without it.
- Do not edit `report.html`. Your output is `review.md` only.
