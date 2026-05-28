---
name: llmlake:inspect-session
description: Generate a tight HTML deep-dive for a single session. Use when the user asks to inspect / dig into / explain a specific session by id, or wants to know "what happened in" a session.
---

You are reconstructing what happened in one session as a short, readable
HTML report. The whole report fits the same `insights/skeleton.html` used
by period reports — section ids and SQL filenames must match for the
verifier to work if invoked later.

**Token budget: aim for <20k.** That means: up to 4 SQL queries (summary
and asks always; trace and errors only when the survey shows tool calls
or errors), render once, no verifier pass, no retrospective. The user can
invoke `llmlake:verify-insights` separately if they want a fact-check.

## Inputs

Session id (full uuid or unique prefix). Resolve a prefix:

```sql
SELECT DISTINCT session_id
FROM events
WHERE session_id LIKE '<prefix>%'
LIMIT 5;
```

0 or >1 hits → tell the user, stop.

## Procedure

**Before anything else**, create the report directory and its `queries/`
subfolder. Every saved SQL goes there. Order is fixed: save the .sql,
*then* run it, *then* keep going.

```bash
TS=$(date -u +%Y-%m-%d-%H%M)
mkdir -p data/reports/${TS}-session-<sid8>/queries
```

1. **Survey query.** Save as `queries/summary.sql`, then run:

   ```sql
   SELECT
     min(ts)                                AS started,
     max(ts)                                AS ended,
     round(epoch(max(ts) - min(ts)) / 60, 1) AS duration_min,
     any_value(agent)                       AS agent,
     any_value(cwd)                         AS cwd,
     any_value(model)                       AS model,
     count(*)                               AS events,
     count(*) FILTER (WHERE event_type = 'user_message')      AS user_msgs,
     count(*) FILTER (WHERE event_type = 'assistant_message') AS assistant_msgs,
     count(*) FILTER (WHERE event_type = 'tool_call')         AS tool_calls,
     count(*) FILTER (WHERE is_error)                         AS errors,
     round(sum(coalesce(cost_usd, 0)), 4)                     AS cost_usd,
     sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) AS tokens,
     any_value(stop_reason)                 AS final_stop_reason
   FROM events
   WHERE session_id = '<session_id>';
   ```

   If `events = 0`, stop.

2. **User prompts.** Save as `queries/asks.sql`:

   ```sql
   SELECT ts, text
   FROM events
   WHERE session_id = '<session_id>'
     AND event_type = 'user_message'
     AND text IS NOT NULL
     AND trim(text) <> ''
   ORDER BY ts;
   ```

   **codex sessions** inject pseudo-prompts as `user_message` rows that
   are not things the user typed. They are reliably identifiable: the text
   starts with an XML-style tag (`<permissions instructions>`,
   `<turn_aborted>`, `<environment_context>`, `<collaboration_mode>`,
   `<user_instructions>`) or with `# AGENTS.md instructions for `. Genuine
   prompts never start that way. If the survey shows `agent = 'codex'`,
   filter them and record the filtered category in the meta line (below):

   ```sql
   -- append before ORDER BY for codex sessions
     AND text NOT LIKE '<%'
     AND text NOT LIKE '# AGENTS.md instructions for %'
   ```

3. **Tool stats** (only if survey.tool_calls > 0). Save as `queries/trace.sql`, then run:

   ```sql
   WITH tr AS (
     SELECT tool_call_id, is_error
     FROM events
     WHERE session_id = '<session_id>' AND event_type = 'tool_result'
   )
   SELECT
     e.tool_name,
     count(*)                                              AS calls,
     count(*) FILTER (WHERE tr.is_error)                   AS errors,
     round(100.0 * count(*) FILTER (WHERE tr.is_error)
                   / nullif(count(tr.tool_call_id), 0), 1) AS error_pct
   FROM events e
   LEFT JOIN tr USING (tool_call_id)
   WHERE e.session_id = '<session_id>'
     AND e.event_type = 'tool_call'
     AND e.tool_name IS NOT NULL
   GROUP BY 1
   ORDER BY calls DESC;
   ```

4. **Error detail** (only if survey.errors > 0). Save as `queries/errors.sql`, then run:

   ```sql
   WITH calls AS (
     SELECT tool_call_id, tool_name
     FROM events
     WHERE session_id = '<session_id>' AND event_type = 'tool_call'
   )
   SELECT
     e.ts,
     c.tool_name,
     substr(coalesce(e.tool_output::VARCHAR, ''), 1, 200) AS snippet
   FROM events e
   LEFT JOIN calls c USING (tool_call_id)
   WHERE e.session_id = '<session_id>'
     AND e.event_type = 'tool_result'
     AND e.is_error = true
   ORDER BY e.ts;
   ```

That's all the SQL — up to 4 queries depending on what the survey
showed. The takeaway synthesizes from what you already have.

## Render

Fill `insights/skeleton.html`. Sections, in order:

- `{{title}}` = `Session <sid8> — <agent>, <YYYY-MM-DD>`
- `{{period_start_*}}` = session start, `{{period_end_*}}` = session end
- `{{scope_summary}}` = e.g. `claude-opus-4-7 in ~/Sites/llmlake`
- `{{modules}}`, in order:

  1. **`<section id="summary">`** — `<h2>Summary</h2>`, one `<p class="lede">`
     naming the most striking attribute (or "Routine session, completed
     cleanly" if not), then a `<dl>` with: started, ended, duration
     (`Nh Nm` or `Nm Ns`), agent, model, cwd, events, user_msgs,
     assistant_msgs, tool_calls, errors, cost_usd, tokens,
     final_stop_reason. `—` for null.

  2. **`<section id="asks">`** — `<h2>What the user asked for</h2>`. If
     1 ask: a single `<blockquote>`. Otherwise `<ol>` of `<blockquote>`s
     in order, **one `<li>` for every row in `asks.sql`** (count must
     equal survey.user_msgs unless you explicitly filtered — see below).
     Quote verbatim; if a single message exceeds 280 chars, truncate the
     visible text with `…` and put the full text inside a `<details>`
     in the same `<li>` — that's how long messages stay readable, **not**
     by dropping rows. Slash commands render the command line in
     `<code>`. **Sampling the list is forbidden** — "first 5 of 34 for
     readability" is a bug. The only allowed reason to omit rows is
     filtering a clearly identifiable category — in practice that means
     the codex pseudo-prompts caught by the two `NOT LIKE` clauses in
     `asks.sql` (tag-prefixed or `# AGENTS.md instructions for …`). Do not
     invent other categories. If you filter, add a
     `<p class="meta">Showing N of M; omitted &lt;category&gt;.</p>`
     above the list naming the category.

  3. **`<section id="errors">`** — only if survey.errors > 0. Uses
     `queries/errors.sql`. `<h2>Errors hit</h2>`, one `<p class="lede">`
     counting and (if discernible) naming the dominant failure mode.
     `<table>` with columns: time (HH:MM:SS), tool, reason (first ~120
     chars of snippet; full snippet in a `<details>` in the same cell).
     One `<tr>` per error row from the query — never an empty `<tbody>`.
     Max 10 rows visible; if more, collapse the rest into a `<details>`
     block.

  4. **`<section id="trace">`** — only if survey.tool_calls > 0. Uses
     `queries/trace.sql`. `<h2>Tools used</h2>`, one `<p class="lede">`
     naming the top tool by calls and (if any) the worst-error-rate tool
     with ≥3 calls. `<table>` of tool / calls / errors / error_pct,
     sorted by calls desc, top 10.

  5. **`<section id="takeaway">`** — `<h2>` with a *specific* heading
     naming the arc ("Stuck in a Bash retry loop", "Refactored the
     parquet writer", etc. — never "Takeaway" or "What happened").
     Then one `<p class="lede">` stating the arc in one sentence,
     followed by 2–4 sentences in `<p>` tags with concrete numbers
     and (if relevant) one short quote from `asks` or `errors`. Don't
     moralize. No separate query — synthesize from the data already
     in the report.

- `{{queries_used}}` — `<ul>` linking each saved SQL.
- `{{data_quality}}` — short `<ul>` of caveats (truncated snippets,
  missing cost, etc.) or `<li>None.</li>` if clean.
- `{{generated_at}}` — `date -u +%Y-%m-%dT%H:%M:%SZ`.

## Pre-write checklist

Before saving `report.html`, run through this list. Don't skip any item.

- [ ] `queries/summary.sql` exists on disk.
- [ ] `queries/asks.sql` exists on disk.
- [ ] If survey.tool_calls > 0: `queries/trace.sql` exists on disk.
- [ ] If survey.errors > 0: `queries/errors.sql` exists on disk.
- [ ] Every section in the HTML has a non-empty body. A `<table>` with
      `<tbody></tbody>` is a bug — drop the whole section or fill it.
- [ ] `<section id="asks">` is present whenever survey.user_msgs > 0,
      and its `<ol>` contains **one `<li>` per row** in `asks.sql`. The
      list length equals survey.user_msgs unless you filtered a stated
      category — in which case the meta line ("Showing N of M; omitted
      &lt;category&gt;") appears above the list. "First N for
      readability" / "sample" / "selected highlights" are all bugs;
      per-message truncation handles long text instead.
- [ ] Section count matches: summary + asks + (errors if errors>0) +
      (trace if tool_calls>0) + takeaway. No extras, no omissions.

## Write & finish

Save to `data/reports/<YYYY-MM-DD-HHMM>-session-<sid8>/report.html`
(`HHMM` is UTC: `date -u +%Y-%m-%d-%H%M`).

Print the report path and one line — e.g. `23.8h session, 18 errors in
the first hour, ended cleanly`. Don't paste the report. Don't run the
verifier. Don't write run-notes.md.

## Rules

- Every number in prose must come from a row in a saved SQL file.
- Quote user messages verbatim. Don't paraphrase.
- Use timestamps as stored (timezone-aware). If you reference a time in
  prose, render it as `HH:MM <tz>` matching the stored value — don't
  invent a "UTC" claim from data stored in a different zone.
- Use `./llmlake query`, never raw `duckdb`. The shell only accepts
  inline SQL via `-c` (there is no `-f`); run a saved file with
  `./llmlake query -c "$(cat queries/<id>.sql)"`.
- All three queries are tight enough to run sequentially without
  parallelism overhead.
