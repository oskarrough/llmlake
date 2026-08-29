-- Tool-call deep dive #2: error rates, retry patterns, expensive tools (three small queries — run one at a time by uncommenting).

-- ── A. Error rate per (agent, model, tool) ───────────────────────────────
-- Uses the parser-extracted is_error flag (claude block.is_error,
-- pi message.isError, codex exit code / metadata).
WITH calls AS (
  SELECT agent, session_id, model, tool_name, tool_call_id
  FROM events WHERE event_type='tool_call' AND model IS NOT NULL
),
results AS (
  SELECT agent, session_id, tool_call_id, is_error
  FROM events WHERE event_type='tool_result'
)
SELECT
  c.agent, c.model, c.tool_name,
  count(*)                                          AS calls,
  count(r.tool_call_id)                             AS results,
  count(*) FILTER (WHERE r.is_error)                AS errors,
  round(100.0 * count(*) FILTER (WHERE r.is_error)
              / nullif(count(r.tool_call_id), 0), 1) AS error_pct
FROM calls c
LEFT JOIN results r USING (agent, session_id, tool_call_id)
GROUP BY c.agent, c.model, c.tool_name
HAVING count(*) >= 20
ORDER BY error_pct DESC NULLS LAST
LIMIT 30;

-- ── B. Retry chains: same tool called repeatedly within a session ────────
-- Uncomment to run instead of (A).
-- SELECT agent, model, tool_name, session_id, count(*) AS in_session
-- FROM events
-- WHERE event_type='tool_call' AND model IS NOT NULL
-- GROUP BY agent, model, tool_name, session_id
-- HAVING count(*) >= 20
-- ORDER BY in_session DESC LIMIT 20;

-- ── C. Tool inputs: most common Bash command starts (claude-specific) ────
-- Uncomment to run instead.
-- SELECT
--   substr(json_extract_string(tool_input, '$.command'), 1, 40) AS cmd_start,
--   count(*) AS n
-- FROM events
-- WHERE event_type='tool_call' AND tool_name='Bash' AND agent='claude'
-- GROUP BY 1 ORDER BY 2 DESC LIMIT 30;
