-- At a glance: estimated value, activity, and cache efficiency for the period. Reads FROM classified so it works unchanged from ./llmlake status and ./llmlake query.
SELECT
  round(sum(coalesce(estimated_value_usd, 0)), 2)               AS estimated_value_usd,
  -- Label only when the number alone would mislead: 'sub' if every token-bearing event is subscription-backed, 'unpriced' if nothing is priced.
  CASE
    WHEN bool_and(billing_mode = 'subscription') FILTER (
      WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL
        OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL
    ) THEN 'sub'
    WHEN coalesce(sum(estimated_value_usd), 0) = 0 THEN 'unpriced'
  END                                                           AS estimated_value_usd_label,
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
FROM classified;
