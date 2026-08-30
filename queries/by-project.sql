-- Which projects (cwd) carry the most estimated value? Shows the last two path segments so /Users/me/Sites/llmlake reads as Sites/llmlake.
SELECT
  CASE
    WHEN cwd LIKE '%/%/%' THEN regexp_extract(cwd, '([^/]+/[^/]+)$')
    ELSE cwd
  END                                        AS project,
  round(sum(coalesce(estimated_value_usd, 0)), 2) AS estimated_value_usd,
  count(DISTINCT session_id)                 AS sessions
FROM classified
WHERE cwd IS NOT NULL
GROUP BY 1
ORDER BY estimated_value_usd DESC
LIMIT 10;
