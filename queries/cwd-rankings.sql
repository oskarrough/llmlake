-- Which projects do I spend the most on? cwd is meaningful for claude/codex (pi has near-uniform cwd).
SELECT
  cwd,
  count(DISTINCT agent || '/' || session_id) AS sessions,
  count(*)                                   AS events,
  sum(coalesce(input_tokens, 0))             AS in_tok,
  sum(coalesce(output_tokens, 0))            AS out_tok,
  sum(coalesce(cache_read_tokens, 0))        AS cache_read,
  round(sum(coalesce(cost_usd, 0)), 2)       AS cost_usd,
  min(ts)                                    AS first_seen,
  max(ts)                                    AS last_seen
FROM events
WHERE cwd IS NOT NULL
GROUP BY 1
ORDER BY cost_usd DESC
LIMIT 30;
