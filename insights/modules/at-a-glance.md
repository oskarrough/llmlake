---
id: at-a-glance
heading: At a glance
when: always
---

Top-of-report summary. Two or three sentences max plus a tight stats block.

## Query

```sql
SELECT
  count(DISTINCT session_id)               AS sessions,
  count(*)                                 AS events,
  round(sum(coalesce(cost_usd, 0)), 2)     AS cost_usd,
  sum(coalesce(input_tokens, 0)
      + coalesce(output_tokens, 0))        AS tokens,
  min(ts) AS first_ts,
  max(ts) AS last_ts
FROM events
WHERE ts BETWEEN '{{period_start}}' AND '{{period_end}}'
  {{scope_filter}};
```

## Render

- A short `<p class="lede">` naming the single most useful fact you can stand
  behind. If nothing surprised you, say so plainly — don't invent drama.
- A `<dl>` with: sessions, events, total cost (USD, 2dp), total tokens
  (thousand-separated), span (format: `first_ts → last_ts (Nd Nh)` using
  ISO date + 24h time, no seconds; abbreviate to `Nh Nm` if span < 1 day).

## Rules

- Numbers only with the SQL row that produced them. No vibes.
- If the period has fewer than 3 sessions, say the sample is too small to
  generalize and shrink the rest of the report accordingly.
