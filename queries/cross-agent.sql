-- How do your agents compare? Cost, cache efficiency, and tool error rate per agent.
WITH agg AS (
  SELECT
    agent,
    count(DISTINCT session_id)            AS sessions,
    round(sum(coalesce(cost_usd, 0)), 2)  AS cost_usd,
    round(
      100.0 * sum(coalesce(cache_read_tokens, 0))
      / nullif(sum(coalesce(input_tokens, 0)) + sum(coalesce(cache_read_tokens, 0)), 0),
      0
    )                                     AS cache_pct
  FROM scoped
  GROUP BY 1
),
calls AS (
  -- DISTINCT collapses replay dups (codex forks re-emit same call).
  SELECT DISTINCT agent, session_id, tool_call_id
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
),
errs AS (
  SELECT
    c.agent,
    round(100.0 * count(*) FILTER (WHERE r.err) / nullif(count(r.tool_call_id), 0), 1) AS tool_err_pct
  FROM calls c
  LEFT JOIN results r USING (agent, session_id, tool_call_id)
  GROUP BY 1
)
SELECT
  agg.agent,
  agg.sessions,
  agg.cost_usd,
  agg.cache_pct,
  errs.tool_err_pct
FROM agg
LEFT JOIN errs USING (agent)
ORDER BY agg.cost_usd DESC;
