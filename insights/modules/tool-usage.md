---
id: tool-usage
heading: Tools you actually use
when: tool_call events > 20 in the period
---

What tools dominated, and which ones failed often.

## Query

`is_error` lives on `tool_result` events. Join calls to their results by
`(agent, tool_call_id)` and count `is_error = true`:

```sql
WITH t AS (
  SELECT agent, tool_call_id, is_error
  FROM events
  WHERE event_type = 'tool_result'
    AND ts BETWEEN '{{period_start}}' AND '{{period_end}}'
)
SELECT
  e.agent,
  e.tool_name,
  count(*)                                                  AS calls,
  count(*) FILTER (WHERE t.is_error)                        AS errors,
  round(100.0 * count(*) FILTER (WHERE t.is_error)
                / nullif(count(t.tool_call_id), 0), 1)      AS error_pct
FROM events e
LEFT JOIN t USING (agent, tool_call_id)
WHERE e.event_type = 'tool_call'
  AND e.tool_name IS NOT NULL
  AND e.ts BETWEEN '{{period_start}}' AND '{{period_end}}'
  {{scope_filter}}
GROUP BY 1, 2
ORDER BY 1, calls DESC;
```

## Render

- `<p class="lede">` calling out the top tool by volume and any tool with
  >10% error rate and >10 calls. If none, skip the error sentence — don't
  pad.
- A `<table>` showing top 10 tools by calls.

## Rules

- A tool_call with no matching tool_result (e.g. in-flight at period end)
  contributes to `calls` but not to `errors` — that's fine, don't filter it.
