-- Head-to-head per agent: how heavy is the average session, what do I lean on.
WITH per_session AS (
  SELECT
    agent,
    session_id,
    count(*)                                AS events,
    sum(coalesce(input_tokens, 0))          AS in_tok,
    sum(coalesce(output_tokens, 0))         AS out_tok,
    sum(coalesce(cache_read_tokens, 0))     AS cache_read,
    sum(coalesce(cost_usd, 0))              AS cost_usd,
    epoch(max(ts) - min(ts))                AS duration_s,
    count(*) FILTER (WHERE tool_name IS NOT NULL) AS tool_events
  FROM events
  GROUP BY 1, 2
)
SELECT
  agent,
  count(*)                       AS sessions,
  round(avg(events), 1)          AS avg_events,
  round(avg(duration_s) / 60, 1) AS avg_min,
  round(avg(in_tok))             AS avg_in_tok,
  round(avg(out_tok))            AS avg_out_tok,
  round(avg(cache_read))         AS avg_cache_read,
  round(avg(tool_events), 1)     AS avg_tool_calls,
  round(avg(cost_usd), 4)        AS avg_cost_usd,
  round(sum(cost_usd), 2)        AS total_cost_usd
FROM per_session
GROUP BY 1
ORDER BY sessions DESC;
