-- Single-session deep dive. Edit the session_id below.
-- Run after `top-sessions.sql` to inspect an interesting one.
WITH s AS (
  SELECT * FROM events
  WHERE session_id = 'PASTE_SESSION_ID_HERE'
)
SELECT
  row_number() OVER (ORDER BY ts) AS n,
  ts,
  event_type,
  role,
  tool_name,
  coalesce(input_tokens, 0)       AS in_tok,
  coalesce(output_tokens, 0)      AS out_tok,
  round(coalesce(cost_usd, 0), 4) AS cost_usd,
  left(coalesce(text, ''), 120)   AS preview
FROM s
ORDER BY ts
LIMIT 200;
