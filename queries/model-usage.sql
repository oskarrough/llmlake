-- Token volume and cost per (agent, model).
-- cost_usd: provider-recorded for pi, computed in parse-session for claude/codex.
SELECT
  agent,
  model,
  count(DISTINCT session_id)            AS sessions,
  count(*)                              AS events,
  sum(coalesce(input_tokens, 0))        AS in_tok,
  sum(coalesce(output_tokens, 0))       AS out_tok,
  sum(coalesce(cache_read_tokens, 0))   AS cache_read,
  round(sum(coalesce(cost_usd, 0)), 4)  AS cost_usd
FROM events
WHERE model IS NOT NULL
GROUP BY 1, 2
ORDER BY cost_usd DESC;
