-- What kinds of tasks am I doing? Group tool calls into families.
WITH labeled AS (
  SELECT
    CASE
      WHEN lower(tool_name) IN ('read', 'glob', 'ls')                          THEN 'read/list'
      WHEN lower(tool_name) IN ('edit', 'write', 'notebookedit', 'apply_patch') THEN 'edit/write'
      WHEN lower(tool_name) IN ('grep', 'search', 'toolsearch')                THEN 'search'
      WHEN lower(tool_name) IN ('bash', 'shell', 'exec_command', 'write_stdin', 'run_terminal_cmd') THEN 'shell'
      WHEN lower(tool_name) IN ('webfetch', 'websearch')                       THEN 'web'
      WHEN tool_name LIKE 'Task%' OR lower(tool_name) IN ('agent', 'spawn_agent', 'wait_agent', 'update_plan') THEN 'tasks/agents'
      WHEN tool_name LIKE 'mcp__%'                                             THEN 'mcp'
      WHEN tool_name IS NULL                                                   THEN NULL
      ELSE 'other'
    END AS family
  FROM scoped
  WHERE event_type = 'tool_call'
)
SELECT
  family,
  count(*)                                            AS calls,
  round(100.0 * count(*) / sum(count(*)) OVER (), 1)  AS pct
FROM labeled
WHERE family IS NOT NULL
GROUP BY 1
ORDER BY calls DESC;
