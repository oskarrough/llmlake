-- Models with token usage but no price: the model has no row in data/prices.json (LiteLLM + PRICING in pricing.ts, refreshed every build) and the log reported no cost. Local models are free, so they're skipped.
SELECT
  model,
  count(DISTINCT session_id) AS sessions
FROM scoped
WHERE model IS NOT NULL
  AND cost_usd IS NULL
  AND coalesce(provider, '') NOT IN ('lmstudio', 'ollama')
  AND coalesce(input_tokens, 0) + coalesce(output_tokens, 0)
    + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0) > 0
GROUP BY model
ORDER BY sessions DESC;
