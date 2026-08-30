-- Estimated value by model+route+billing, ranked by total named tokens so major unpriced models stay visible. NULL models with tokens appear as '(unknown)'.
SELECT
  coalesce(model, '(unknown)') || ' · ' || route   AS model,
  round(sum(coalesce(estimated_value_usd, 0)), 2)  AS estimated_value_usd,
  -- Optional label when the numeric estimate alone would mislead; priced API rows show the number.
  CASE
    WHEN billing_mode = 'subscription' AND coalesce(sum(estimated_value_usd), 0) = 0 THEN 'sub · unpriced'
    WHEN billing_mode = 'subscription' THEN 'sub'
    WHEN billing_mode = 'local' THEN 'local'
    WHEN billing_mode = 'api' AND coalesce(sum(estimated_value_usd), 0) = 0 THEN 'unpriced'
  END                                              AS estimated_value_usd_label,
  sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)
    + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0)) AS tokens,
  count(*)                                         AS events
FROM classified
WHERE model IS NOT NULL
  OR coalesce(input_tokens, 0) + coalesce(output_tokens, 0)
    + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0) > 0
GROUP BY model, route, billing_mode
ORDER BY tokens DESC
LIMIT 10;
