-- All-time activity per month, per agent: sessions, events, and total tokens (in + out) so claude/codex/pi are comparable.
SELECT
  date_trunc('month', ts)               AS month,
  agent,
  count(DISTINCT session_id)            AS sessions,
  count(*)                              AS events,
  sum(coalesce(input_tokens, 0))        AS in_tok,
  sum(coalesce(output_tokens, 0))       AS out_tok,
  sum(coalesce(cache_read_tokens, 0))   AS cache_read_tok,
  round(sum(coalesce(cost_usd, 0)), 4)  AS cost_usd
FROM events
GROUP BY 1, 2
ORDER BY 1, 2;
