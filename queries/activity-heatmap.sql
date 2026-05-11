-- When do I work? Events by day-of-week × hour-of-day (local time = whatever ts is stored as).
-- dow: 0=Sun .. 6=Sat
SELECT
  dayofweek(ts) AS dow,
  hour(ts)      AS hour,
  count(DISTINCT session_id) AS sessions,
  count(*)                   AS events
FROM events
GROUP BY 1, 2
ORDER BY 1, 2;
