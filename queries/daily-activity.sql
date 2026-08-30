-- Daily estimated value and tool calls over the period.
SELECT
  strftime(ts, '%Y-%m-%d')                          AS day,
  round(sum(coalesce(estimated_value_usd, 0)), 2)   AS estimated_value_usd,
  count(*) FILTER (WHERE event_type = 'tool_call')  AS calls
FROM classified
WHERE ts IS NOT NULL
GROUP BY 1
ORDER BY 1;
