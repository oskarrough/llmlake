# insights

Generates HTML reports from the parquet lake. Three skills:

- `.claude/skills/generate-insights` — period report (weekly / monthly / etc.).
- `.claude/skills/inspect-session` — single-session deep dive by id.
- `.claude/skills/verify-insights` — re-runs each module's saved query, flags prose the data doesn't support. Works for either report type.

## Shape

```
insights/
  skeleton.html      shared wrapper with {{title}} {{modules}} ...
  modules/*.md       section specs for period reports
```

Period reports use the module folder because they have many distinct
section shapes. Session reports have a fixed shape, so
`inspect-session/SKILL.md` inlines the spec rather than splitting it
across files — that keeps a single inspect under ~20k tokens.

A module is a markdown file with frontmatter declaring `id`, `heading`,
`when` (the condition under which to include it), and a body that specifies
the query, the render shape, and the prose lede.

The agent picks which modules apply per report, runs each module's query,
renders an HTML fragment, then concatenates fragments into `{{modules}}`.
Two modules are freeform (`freeform-a.md`, `freeform-b.md`) — heading and
body chosen by the agent based on what it found.

## Output

Reports land in `data/reports/<YYYY-MM-DD-HHMM>/`:

- `report.html` — the rendered report
- `review.md` — verifier output
- `queries/*.sql` — every query the agent actually ran (for reproducibility)
- `run-notes.md` — short retrospective on running the skill (friction,
  ambiguities, suggested edits). **Iteration-phase scaffolding** — remove
  step 9 from `generate-insights/SKILL.md` once the spec stabilizes and
  the notes start saying "nothing notable".
