-- Daily cost and tool calls over the period.
SELECT
  strftime(ts, '%Y-%m-%d')                          AS day,
  round(sum(coalesce(cost_usd, 0)), 2)              AS cost_usd,
  count(*) FILTER (WHERE event_type = 'tool_call')  AS calls
FROM scoped
WHERE ts IS NOT NULL
GROUP BY 1
ORDER BY 1;
