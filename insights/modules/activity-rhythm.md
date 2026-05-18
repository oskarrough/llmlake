---
id: activity-rhythm
heading: When you work
when: data covers >= 5 distinct days (count(DISTINCT date_trunc('day', ts)) in the period)
---

When events actually happen. Skip if the data is bunched into a handful of
days — a heatmap of one bursty hour has no rhythm to show.

## Query

```sql
SELECT
  date_trunc('day', ts) AS day,
  extract(hour FROM ts) AS hour_local,
  count(*)              AS events,
  count(DISTINCT session_id) AS sessions
FROM events
WHERE ts BETWEEN '{{period_start}}' AND '{{period_end}}'
  {{scope_filter}}
GROUP BY 1, 2
ORDER BY 1, 2;
```

## Render

- `<p class="lede">` naming the busiest hour-of-day. If patterns vary across
  days, also mention the busiest day-of-week or the strongest time-of-day
  cluster (e.g. "5–11pm cluster, with Wednesdays the heaviest"). Don't
  invent a day-of-week pattern if the data doesn't show one.
- Either a small inline SVG heatmap (24 hours × N days) or a plain
  `<table>` aggregated by hour-of-day. Whichever you can produce reliably
  from the query rows without external libraries — prefer the table if
  unsure.

## Rules

- Timestamps are stored with timezone; the report is read locally, so
  prefer extracting hour from `ts` without conversion and label it
  "session-local hour" if you're unsure.
