-- Models with token usage but no price: Claude and Codex rows are priced at parse time from pricing.ts, so a NULL cost means the model is missing from the snapshot (fix: ./sync-pricing.ts, then build).
SELECT
  model,
  count(DISTINCT session_id) AS sessions
FROM scoped
WHERE agent IN ('claude', 'codex')
  AND model IS NOT NULL
  AND cost_usd IS NULL
  AND coalesce(input_tokens, 0) + coalesce(output_tokens, 0)
    + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0) > 0
GROUP BY model
ORDER BY sessions DESC;
