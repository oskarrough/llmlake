-- Token spend by model.
SELECT
  model,
  round(sum(coalesce(cost_usd, 0)), 2)  AS cost_usd,
  count(*)                              AS events
FROM scoped
WHERE model IS NOT NULL
GROUP BY 1
ORDER BY cost_usd DESC
LIMIT 10;
