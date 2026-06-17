-- Most-used tools by call count.
SELECT
  tool_name,
  count(*) AS calls
FROM scoped
WHERE event_type = 'tool_call' AND tool_name IS NOT NULL
GROUP BY 1
ORDER BY calls DESC
LIMIT 12;
