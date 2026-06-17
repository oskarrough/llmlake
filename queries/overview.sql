-- At a glance: cost, activity, and cache efficiency for the period.
-- Reads from `scoped` (the period/agent/cwd-filtered view) so it works
-- unchanged from `./llmlake status` and `./llmlake query`.
SELECT
  round(sum(coalesce(cost_usd, 0)), 2)                          AS cost_usd,
  count(*) FILTER (WHERE event_type = 'tool_call')              AS tool_calls,
  count(DISTINCT session_id)                                    AS sessions,
  sum(coalesce(input_tokens, 0))                                AS input_tokens,
  sum(coalesce(output_tokens, 0))                               AS output_tokens,
  sum(coalesce(cache_read_tokens, 0))                           AS cache_read_tokens,
  sum(coalesce(cache_write_tokens, 0))                          AS cache_write_tokens,
  round(
    100.0 * sum(coalesce(cache_read_tokens, 0))
    / nullif(sum(coalesce(input_tokens, 0)) + sum(coalesce(cache_read_tokens, 0)), 0),
    1
  )                                                             AS cache_hit_pct
FROM scoped;
