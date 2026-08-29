-- What tools am I actually using, and how often do they error? Error detection is best-effort: tool_output JSON containing "error"/"Error" or stop_reason='tool_error'.
WITH t AS (
  -- one row per key (bool_or is_error+markers) prevents fan-out; session_id required: ids repeat across sessions.
  SELECT
    agent,
    session_id,
    tool_call_id,
    bool_or(
      coalesce(is_error, false)
      OR tool_output::VARCHAR ILIKE '%"error"%'
      OR tool_output::VARCHAR ILIKE '%"is_error":true%'
    ) AS err
  FROM events
  WHERE event_type = 'tool_result'
  GROUP BY 1, 2, 3
),
calls AS (
  -- keyed DISTINCT collapses replay dups; NULL-id calls must stay verbatim (UNION ALL): NULL never matches a key.
  SELECT DISTINCT agent, session_id, tool_call_id, tool_name
  FROM events
  WHERE event_type = 'tool_call' AND tool_name IS NOT NULL AND tool_call_id IS NOT NULL
  UNION ALL
  SELECT agent, session_id, tool_call_id, tool_name
  FROM events
  WHERE event_type = 'tool_call' AND tool_name IS NOT NULL AND tool_call_id IS NULL
)
SELECT
  e.agent,
  e.tool_name,
  count(*)                                       AS calls,
  count(t.tool_call_id)                          AS results,
  count(*) FILTER (WHERE t.err)                  AS errors,
  round(100.0 * count(*) FILTER (WHERE t.err)
                / nullif(count(t.tool_call_id), 0), 1) AS error_pct
FROM calls e
LEFT JOIN t USING (agent, session_id, tool_call_id)
GROUP BY 1, 2
ORDER BY 1, calls DESC;
