-- Tool reliability: call and error rates per tool (names case-folded so claude's Bash and pi's bash count as one tool); errors matched by joining tool_call → tool_result within the same agent+session, then checking is_error or an error marker in the output.
WITH calls AS (
  -- DISTINCT collapses replay dups (codex forks re-emit same call); different payload survives.
  SELECT DISTINCT agent, session_id, tool_call_id, tool_name
  FROM scoped
  WHERE event_type = 'tool_call' AND tool_name IS NOT NULL AND tool_call_id IS NOT NULL
),
results AS (
  -- one row per key (bool_or, same error semantics): a replayed key cannot fan the join out.
  SELECT
    agent,
    session_id,
    tool_call_id,
    bool_or(
      coalesce(is_error, false)
      OR tool_output::VARCHAR ILIKE '%"is_error":true%'
      OR tool_output::VARCHAR ILIKE '%"error"%'
    ) AS err
  FROM scoped
  WHERE event_type = 'tool_result' AND tool_call_id IS NOT NULL
  GROUP BY 1, 2, 3
)
SELECT
  mode(c.tool_name)                                                AS tool_name, -- most common spelling
  count(*)                                                         AS calls,
  count(*) FILTER (WHERE r.err)                                    AS errors,
  round(100.0 * count(*) FILTER (WHERE r.err) / nullif(count(r.tool_call_id), 0), 1) AS error_pct
FROM calls c
LEFT JOIN results r USING (agent, session_id, tool_call_id)
GROUP BY lower(c.tool_name)
ORDER BY calls DESC
LIMIT 12;
