-- Which projects (cwd) cost the most? Shows the last two path segments so
-- "/Users/me/Sites/llmlake" reads as "Sites/llmlake".
SELECT
  CASE
    WHEN cwd LIKE '%/%/%' THEN regexp_extract(cwd, '([^/]+/[^/]+)$')
    ELSE cwd
  END                                        AS project,
  round(sum(coalesce(cost_usd, 0)), 2)       AS cost_usd,
  count(DISTINCT session_id)                 AS sessions
FROM scoped
WHERE cwd IS NOT NULL
GROUP BY 1
ORDER BY cost_usd DESC
LIMIT 10;
