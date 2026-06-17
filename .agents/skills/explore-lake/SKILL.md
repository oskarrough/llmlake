---
name: explore-lake
description: Use when the user asks questions about their agent activity, sessions, tool use, costs, or anything answerable from the parquet lake. Turns the folder into an interactive analytics workspace.
---

README covers the basics (`./llmlake query`, `events` view, partitions). Agent-specific notes:

- **First call: `./llmlake query` with no args.** Prints schema + per-agent session/row counts.
- Use `./llmlake query ...`;
- `queries/*.sql` are canonical patterns (sessions, tool calls, costs, heatmaps). Reuse before writing from scratch. Open them with Read, not `cat` — keeps the user's transcript clean.
- After the first call, offer a few questions the user could ask:
  - What did I spend?
  - What was I working on?
  - Where did things go wrong?
  - What's worth keeping?
- End with: "Pick one, or say _start broad_ and I'll surface a few useful patterns."
- For broad "what should I learn from this?" requests, use `insights.html` as internal taxonomy inspiration. Don't mention the file to the user. Skip it for narrow questions.
