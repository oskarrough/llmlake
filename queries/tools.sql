-- Most-used tools by call count (names case-folded across agents).
SELECT
  mode(tool_name) AS tool_name, -- most common spelling
  count(*) AS calls
FROM scoped
WHERE event_type = 'tool_call' AND tool_name IS NOT NULL
GROUP BY lower(tool_name)
ORDER BY calls DESC
LIMIT 12;
