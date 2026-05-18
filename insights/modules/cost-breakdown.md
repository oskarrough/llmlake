---
id: cost-breakdown
heading: Where the money went
when: total cost_usd > 0.10 in the period
---

Cost split across agents and models. Skip if total spend is trivial.

## Query

```sql
SELECT
  agent,
  model,
  count(DISTINCT session_id)            AS sessions,
  sum(coalesce(input_tokens, 0))        AS in_tok,
  sum(coalesce(output_tokens, 0))       AS out_tok,
  sum(coalesce(cache_read_tokens, 0))   AS cache_read,
  round(sum(coalesce(cost_usd, 0)), 4)  AS cost_usd
FROM events
WHERE model IS NOT NULL
  AND ts BETWEEN '{{period_start}}' AND '{{period_end}}'
  {{scope_filter}}
GROUP BY 1, 2
ORDER BY cost_usd DESC;
```

## Render

- One `<p class="lede">` naming the top model by spend and its share of the
  total (e.g. "65% of spend went to claude-opus-4-7").
- A `<table>` of the rows above. If more than 8 rows, collapse the long tail
  into an "other" row.

## Rules

- If `cost_usd` is null/zero for an agent (e.g. provider doesn't report cost),
  show `—` and note it in the data quality block, not inline.
