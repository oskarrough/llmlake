-- Token volume and API-equivalent value per (agent, model, route) from classified (cost_provenance is agent-determined; see classified); estimated_value_usd is published-rate value, never billed spend.
SELECT
  agent,
  coalesce(model, '(unknown model)')   AS model,
  vendor,
  route,
  billing_mode,
  count(DISTINCT session_id)           AS sessions,
  count(*)                             AS events,
  sum(coalesce(input_tokens, 0))       AS input_tokens,
  sum(coalesce(output_tokens, 0))      AS output_tokens,
  sum(coalesce(cache_read_tokens, 0))  AS cache_read_tokens,
  sum(coalesce(cache_write_tokens, 0)) AS cache_write_tokens,
  round(sum(estimated_value_usd), 4)   AS estimated_value_usd
FROM classified
WHERE model IS NOT NULL
  OR input_tokens IS NOT NULL OR output_tokens IS NOT NULL
  OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL
GROUP BY 1, 2, 3, 4, 5
ORDER BY estimated_value_usd DESC;
