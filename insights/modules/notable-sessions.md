---
id: notable-sessions
heading: Notable sessions
when: always, unless fewer than 3 sessions in the period
---

Outliers worth a second look — longest, costliest, most errors.

## Query

```sql
SELECT
  session_id,
  agent,
  any_value(model)                        AS model,
  any_value(cwd)                          AS cwd,
  count(*)                                AS events,
  round(epoch(max(ts) - min(ts)) / 60, 1) AS duration_min,
  round(sum(coalesce(cost_usd, 0)), 4)    AS cost_usd,
  count(*) FILTER (WHERE is_error)        AS errors,
  min(ts)                                 AS started
FROM events
WHERE ts BETWEEN '{{period_start}}' AND '{{period_end}}'
  {{scope_filter}}
GROUP BY 1, 2
ORDER BY cost_usd DESC
LIMIT 50;
```

## Render

- `<p class="lede">` naming the single most striking session and why
  (e.g. "longest session — 3.4 hours, ended in a tool_error").
- A `<table>` with: session_id (linked or first 8 chars), agent, model, cwd,
  duration_min, cost_usd, errors. Up to three rows after dedup — top by
  cost, top by duration, top by errors. If one session tops two categories,
  it gets one row and the lede mentions both.

## Rules

- Mark each row's "why" (cost / duration / errors) in the lede, not as an
  extra table column.
- End the section with one sentence telling the reader they can dig into
  any of these with the `inspect-session` skill (e.g. "Inspect any of
  these with the `llmlake:inspect-session` skill — pass the
  `session_id`.").
- `cwd` may be long — truncate to the last two path segments.
