-- What tools am I actually using, and how often do they error? Error detection is best-effort: tool_output JSON containing "error"/"Error" or stop_reason='tool_error'.
WITH t AS (
  SELECT
    agent,
    tool_name,
    tool_call_id,
    tool_output::VARCHAR AS out_str
  FROM events
  WHERE event_type = 'tool_result'
)
SELECT
  e.agent,
  e.tool_name,
  count(*)                                       AS calls,
  count(t.tool_call_id)                          AS results,
  count(*) FILTER (WHERE t.out_str ILIKE '%"error"%'
                      OR t.out_str ILIKE '%"is_error":true%') AS errors,
  round(100.0 * count(*) FILTER (WHERE t.out_str ILIKE '%"error"%'
                                    OR t.out_str ILIKE '%"is_error":true%')
                / nullif(count(t.tool_call_id), 0), 1) AS error_pct
FROM events e
LEFT JOIN t USING (agent, tool_call_id)
WHERE e.event_type = 'tool_call' AND e.tool_name IS NOT NULL
GROUP BY 1, 2
ORDER BY 1, calls DESC;
