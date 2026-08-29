-- Cross-model tool-call behavior: where the improvement leverage is (five lenses, comment/uncomment as you go). NOTE: pi tool_calls are currently undercounted ~4× (see parser-sanity.sql).
-- Numbers below are still useful for *ratios within an agent* but absolute
-- pi tool_call counts will jump after the parser fix.

-- ── 1. Volume + parallelism: how many tools per assistant turn? ──────────
-- A tool_call row currently represents the *first* toolCall block in a turn
-- (claude/codex are fine, pi is buggy). After the pi fix this becomes a real
-- "tools per turn" stat. For now it's a proxy.
SELECT '1. tools per session' AS section, agent, model,
       count(*) FILTER (WHERE event_type='tool_call')            AS tool_calls,
       count(DISTINCT session_id)                                AS sessions,
       round(count(*) FILTER (WHERE event_type='tool_call')
             / nullif(count(DISTINCT session_id), 0)::DOUBLE, 1) AS calls_per_session
FROM events
WHERE model IS NOT NULL
GROUP BY agent, model
HAVING count(*) FILTER (WHERE event_type='tool_call') > 0

UNION ALL

-- ── 2. Tool diversity per model: are we using the toolbox or one hammer? ─
SELECT '2. tool diversity', agent, model,
       count(DISTINCT tool_name) AS distinct_tools,
       count(*)                  AS calls,
       NULL
FROM events
WHERE event_type='tool_call' AND model IS NOT NULL
GROUP BY agent, model

UNION ALL

-- ── 3. Top tool per model: what each model leans on most ────────────────
SELECT '3. top tool', agent, model || ' → ' || tool_name,
       count(*), NULL, NULL
FROM events
WHERE event_type='tool_call' AND model IS NOT NULL
GROUP BY agent, model, tool_name
QUALIFY row_number() OVER (PARTITION BY agent, model ORDER BY count(*) DESC) = 1

ORDER BY section, agent, model;
