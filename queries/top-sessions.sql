-- Top 20 sessions by cost. Tweak LIMIT / ORDER BY.
SELECT
  session_id,
  agent,
  any_value(model)                     AS model,
  any_value(cwd)                       AS cwd,
  count(*)                             AS events,
  round(epoch(max(ts) - min(ts)) / 60, 1) AS duration_min,
  sum(coalesce(input_tokens, 0))       AS in_tok,
  sum(coalesce(output_tokens, 0))      AS out_tok,
  sum(coalesce(cache_read_tokens, 0))  AS cache_read,
  round(sum(coalesce(cost_usd, 0)), 4) AS cost_usd,
  min(ts)                              AS started
FROM events
GROUP BY 1, 2
ORDER BY cost_usd DESC
LIMIT 20;
