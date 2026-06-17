-- Tool reliability: how often each tool is called and how often it errors.
-- Errors are matched by joining tool_call → tool_result on tool_call_id and
-- checking the result's is_error flag or an error marker in its output.
WITH calls AS (
  SELECT tool_call_id, tool_name
  FROM scoped
  WHERE event_type = 'tool_call' AND tool_name IS NOT NULL AND tool_call_id IS NOT NULL
),
results AS (
  SELECT
    tool_call_id,
    (
      coalesce(is_error, false)
      OR tool_output::VARCHAR ILIKE '%"is_error":true%'
      OR tool_output::VARCHAR ILIKE '%"error"%'
    ) AS err
  FROM scoped
  WHERE event_type = 'tool_result' AND tool_call_id IS NOT NULL
)
SELECT
  c.tool_name,
  count(*)                                                         AS calls,
  count(*) FILTER (WHERE r.err)                                    AS errors,
  round(100.0 * count(*) FILTER (WHERE r.err) / nullif(count(r.tool_call_id), 0), 1) AS error_pct
FROM calls c
LEFT JOIN results r USING (tool_call_id)
GROUP BY 1
ORDER BY calls DESC
LIMIT 12;
