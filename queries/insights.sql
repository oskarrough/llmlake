-- Actionable findings: each branch emits a row only when its heuristic crosses a threshold worth acting on (a healthy lake returns nothing); ord orders, title is the headline, detail is the concrete fix.
WITH tc AS (
  SELECT agent, tool_call_id, lower(tool_name) AS t, tool_name, session_id, tool_input
  FROM scoped
  WHERE event_type = 'tool_call' AND tool_name IS NOT NULL
),
results AS (
  SELECT
    agent,
    session_id,
    tool_call_id,
    (
      coalesce(is_error, false)
      OR tool_output::VARCHAR ILIKE '%"is_error":true%'
      OR tool_output::VARCHAR ILIKE '%"error"%'
    ) AS err
  FROM scoped
  WHERE event_type = 'tool_result' AND tool_call_id IS NOT NULL
),
tool_err AS (
  SELECT tc.tool_name, count(*) AS n, count(*) FILTER (WHERE r.err) AS errs
  FROM tc
  JOIN results r USING (agent, session_id, tool_call_id)
  GROUP BY 1
),
reads AS (
  SELECT
    session_id,
    coalesce(
      json_extract_string(tool_input, '$.file_path'),
      json_extract_string(tool_input, '$.path'),
      json_extract_string(tool_input, '$.target_file')
    ) AS path
  FROM tc
  WHERE t = 'read'
),
reread AS (
  SELECT sum(cnt - 1) AS redundant
  FROM (
    SELECT session_id, path, count(*) AS cnt
    FROM reads
    WHERE path IS NOT NULL
    GROUP BY 1, 2
    HAVING count(*) >= 3
  )
)
-- 1. Low cache hit rate — cached input is ~10x cheaper than fresh input.
SELECT
  1 AS ord,
  'Low cache hit rate (' || round(100.0 * cr / (inp + cr)) || '%)' AS title,
  'Cached input tokens are far cheaper than fresh ones. Cache drops when you '
    || 'edit files mid-conversation or leave long gaps between turns. Keep a '
    || 'session focused on one task and let it run to avoid re-priming context.' AS detail
FROM (SELECT sum(coalesce(input_tokens, 0)) AS inp, sum(coalesce(cache_read_tokens, 0)) AS cr FROM scoped)
WHERE inp + cr > 50000 AND 100.0 * cr / (inp + cr) < 60

UNION ALL
-- 2. Editing far more than reading — a retry smell.
SELECT
  2,
  'Editing more than reading (' || edits || ' edits vs ' || reads || ' reads)',
  'Healthy sessions read 2-4x more than they edit. Editing a file the agent '
    || 'hasn''t read leads to wrong edits and retries. Tell it to read the file '
    || '(and grep for callers) before changing it.'
FROM (
  SELECT
    count(*) FILTER (WHERE t IN ('read', 'glob', 'ls')) AS reads,
    count(*) FILTER (WHERE t IN ('edit', 'write', 'notebookedit', 'apply_patch', 'multiedit')) AS edits
  FROM tc
)
WHERE edits >= 20 AND reads < edits

UNION ALL
-- 3. A tool that errors a lot — burns turns and tokens.
SELECT
  3,
  tool_name || ' fails often (' || round(100.0 * errs / n) || '% of ' || n || ' calls)',
  'Repeated ' || tool_name || ' failures waste turns. Look at the common cause '
    || '(bad arguments, stale file before an edit, a missing dependency) and add '
    || 'a note to your AGENTS.md / CLAUDE.md so the agent avoids it.'
FROM tool_err
WHERE n >= 10 AND 100.0 * errs / n >= 20

UNION ALL
-- 4. Re-reading the same files — reloads identical content into context.
SELECT
  4,
  'Re-reading the same files (' || redundant || ' redundant reads)',
  'Each re-read reloads identical content into the context window. Point the '
    || 'agent at exact locations ("in <file> lines 40-80, look at <fn>") instead '
    || 'of having it re-scan whole files across turns.'
FROM reread
WHERE redundant >= 10

ORDER BY ord;
