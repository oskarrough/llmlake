---
name: llmlake:generate-insights
description: Generate an HTML insights report for a period from the parquet lake. Use when the user asks for a report, weekly review, monthly summary, or "what have I been doing".
---

You are generating an HTML report from `data/parquet/` using the skeleton +
modules system at `insights/`. Read `insights/README.md` once for the
shape — it is short.

## Inputs

If the user didn't specify, ask in one message:

- **Period.** Default: last 7 days. Accept "last month", date range, "all".
- **Scope.** Default: all agents and all cwds. Accept agent filter (e.g.
  `claude` only) or cwd filter.

Convert relative periods to absolute ISO timestamps before any query.

## Procedure

1. **Survey the lake first.** Run `./llmlake query` with no args to confirm
   schema and counts. Then check the lake's time bounds and shift the
   requested window if it ends after the data:

   ```sql
   SELECT min(ts) AS min_ts, max(ts) AS max_ts FROM events;
   ```

   If your requested `<end>` is after `max_ts`, shift the window so it ends
   at `max_ts` and keeps the same length. Record the shift verbatim in the
   `{{data_quality}}` block (e.g. "requested 2026-05-11 → 2026-05-18; lake
   ends 2026-05-11, shifted to 2026-05-04 → 2026-05-11"). Don't silently
   adjust.

   Then run one scoped count query against the (possibly shifted) window:

   ```sql
   SELECT count(*) AS events, count(DISTINCT session_id) AS sessions
   FROM events
   WHERE ts BETWEEN '<start>' AND '<end>' <scope_filter>;
   ```

   If sessions < 3, tell the user the sample is thin and ask whether to
   continue or widen the period.

2. **Pick modules.** Read every file in `insights/modules/`. For each,
   evaluate its `when:` condition against the survey result. Build a list
   of modules to include. Always include `at-a-glance`. Decide on
   `freeform-a` and (only if warranted) `freeform-b` based on what
   surprised you while surveying — don't decide their content yet.

3. **Run module queries.** For each fixed module, run its query (with the
   period and scope substituted) via `./llmlake query -c "..."`. Save the
   exact SQL you ran into `data/reports/<ts>/queries/<module-id>.sql` so
   the verifier can re-run it.

4. **Render fragments.** For each module, produce an HTML `<section>` with
   `id="<module-id>"`, an `<h2>` of the module's heading, and the body
   described in the module spec. Use the rendering rules in the module
   spec verbatim. If a module's query returns zero rows, **skip the
   module** rather than rendering an empty section.

5. **Freeform sections.** Now decide what goes in `freeform-a` (and
   maybe `-b`). Look at what you saw across the queries. Run additional
   exploratory queries as needed and save them as `queries/freeform-a.sql`
   and `queries/freeform-b.sql` (exactly those filenames — the verifier
   looks them up by id, not by topic). The freeform prose must cite that
   saved query via the `<details>` block per the spec.

6. **Assemble.** Read `insights/skeleton.html`, fill the placeholders:
   - `{{title}}` — e.g. "Activity report — 2026-05-11 to 2026-05-18"
   - `{{period_start_iso}}`, `{{period_start_label}}`, etc.
   - `{{scope_summary}}` — one phrase ("all agents, all projects" or
     "claude only, in `~/Sites/llmlake`")
   - `{{modules}}` — concatenated `<section>` fragments in this order:
     `at-a-glance`, then any picked fixed modules in the order they appear
     in the modules folder, then `freeform-a`, then `freeform-b`.
   - `{{queries_used}}` — a `<ul>` linking each saved `queries/<id>.sql`.
   - `{{data_quality}}` — short `<ul>` of caveats you noticed (heuristic
     error detection, missing cost data for an agent, etc.).
   - `{{generated_at}}` — current ISO timestamp.

7. **Write.** Save the rendered HTML to
   `data/reports/<YYYY-MM-DD-HHMM>/report.html`. `HHMM` is UTC — run
   `date -u +%Y-%m-%d-%H%M` to get it.

8. **Verify.** Invoke the `llmlake:verify-insights` skill on the report
   directory. Wait for its review, then if it flagged anything, fix the
   report in place (or note in `review.md` why the flag is acceptable).

9. **Retrospective.** Write `data/reports/<ts>/run-notes.md` — a short
   record of friction running this skill, so the next run is smoother.
   This is iteration-phase scaffolding and will be removed once the spec
   stabilizes. Be specific and terse: quote the exact line of a SKILL.md
   or module spec when it caused friction. No general praise, no rewrites.
   Cover what applies, skip the rest. Under ~400 words.

   - **Ambiguous instructions.** Where in `generate-insights/SKILL.md` or a
     module spec did you have to guess? Quote the line and say what you did.
   - **Render specs.** Which module's "Render" section under-specified (you
     had to invent shape) or over-specified (you had to fight it)? Name the
     module and the line.
   - **`when` conditions.** Vague or unmeasurable ("when warranted",
     arbitrary thresholds)? Did any module fire or skip in a way that felt
     wrong given the data?
   - **Queries.** Any module query that returned an unexpected shape, hit a
     missing column, or needed material reshaping? Paste the diff between
     the spec's query and what you actually ran.
   - **Skeleton placeholders.** Anything in `insights/skeleton.html` you
     couldn't fill cleanly, or wanted a slot for and didn't have?
   - **Freeform slots.** Did the rules ("must cite a query", "specific
     heading") help or get in the way? One slot enough, two too many, or
     vice versa?
   - **Verifier handoff.** Was the saved-query contract obvious? Anything
     the verifier would need that you weren't told to save?
   - **Bugs / dead refs.** Typos, broken file references, commands that
     didn't work as written.
   - **One concrete edit.** If you could change exactly one file under
     `insights/` or `.claude/skills/` to make the next run smoother, which
     file and what change?

10. **Report back.** Print the path to the report and a one-line summary.
    Don't paste the report.

## Rules

- Numbers in prose must come from a row in a saved SQL file. No vibes.
- Don't pad. A module whose `when` doesn't fire is omitted. A freeform
  slot you can't fill well becomes "Nothing stood out" or is dropped.
- Use `./llmlake query`, never raw `duckdb` invocations — that's the
  project's shell.
- Spawn subagents for parallelizable query runs only if the report is
  large; a single agent is usually fine.
