-- Parser health dashboard. One check per row. Re-run after each parser fix.
-- Hypotheses are based on reading parse-session.ts and sampling raw JSONL.
--
-- HOW TO READ
--   check       : which anomaly
--   agent       : which parser to blame
--   n           : how many rows match (the metric to drive down — or up — with fixes)
--   example     : <source_file>:<source_line> to grep into for a sample
--   hypothesis  : likely cause + fix location

WITH checks AS (

  -- pi: meta events tagged 'other' (model_change / thinking_level_change)
  SELECT 'pi: any other-tagged rows' AS check,
         'pi'                                                                   AS agent,
         count(*)                                                               AS n,
         any_value(source_file || ':' || source_line)                           AS example,
         'parsePi should map every ev.type to a real event_type. Any ''other'' = an unhandled branch.' AS hypothesis
  FROM events WHERE agent='pi' AND event_type='other'

  UNION ALL

  -- claude: unrecognized housekeeping types → event_type='other'
  SELECT 'claude: any other-tagged rows',
         'claude',
         count(*),
         any_value(source_file || ':' || source_line),
         'parseClaude should label every ev.type. Anything in ''other'' means CLAUDE_META_TYPES is missing an entry.'
  FROM events WHERE agent='claude' AND event_type='other'

  UNION ALL

  -- codex: catchall — any 'other' that isn't one of the known sub-buckets
  SELECT 'codex: any other-tagged rows',
         'codex',
         count(*),
         any_value(source_file || ':' || source_line),
         'parseCodex should label every top-level ev.type and every response_item payload.type.'
  FROM events WHERE agent='codex' AND event_type='other'

  UNION ALL

  -- INVARIANT: every tool_result has a matching tool_call (same id, same session)
  SELECT 'all: orphan tool_result (no matching tool_call)',
         e.agent,
         count(*),
         any_value(e.source_file || ':' || e.source_line),
         'Tool_result with no matching tool_call. Likely the call was dropped during parsing or the tool_call_id pairing is wrong.'
  FROM events e
  WHERE e.event_type = 'tool_result' AND e.tool_call_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM events c
      WHERE c.session_id = e.session_id
        AND c.agent      = e.agent
        AND c.event_type = 'tool_call'
        AND c.tool_call_id = e.tool_call_id
    )
  GROUP BY e.agent

  UNION ALL

  -- INVARIANT: a tool_call should be answered by a tool_result (excluding aborts).
  -- Trailing un-answered calls at session-end are natural; this fires when many pile up.
  SELECT 'all: orphan tool_call (call without result, not aborted)',
         e.agent,
         count(*),
         any_value(e.source_file || ':' || e.source_line),
         'Tool_call with no matching tool_result and stop_reason != ''aborted''. A few are natural (last call in unfinished session); many = a parser regression on the result side.'
  FROM events e
  WHERE e.event_type = 'tool_call' AND e.tool_call_id IS NOT NULL
    AND coalesce(e.stop_reason, '') NOT IN ('aborted')
    AND NOT EXISTS (
      SELECT 1 FROM events r
      WHERE r.session_id = e.session_id
        AND r.agent      = e.agent
        AND r.event_type = 'tool_result'
        AND r.tool_call_id = e.tool_call_id
    )
  GROUP BY e.agent
  HAVING count(*) > 5

  UNION ALL

  -- INVARIANT: row_id is globally unique (split rows must suffix it)
  SELECT 'all: duplicate row_id',
         CAST(NULL AS VARCHAR),
         count(*),
         CAST(NULL AS VARCHAR),
         'baseRow() hashes source_file:line. Split rows must suffix row_id (-tc, -0, -1, ...). A dup means a split forgot to suffix.'
  FROM (
    SELECT row_id FROM events GROUP BY 1 HAVING count(*) > 1
  )

  UNION ALL

  -- INVARIANT: event_id unique within (agent, session_id). Splits suffix the
  -- event_id; same-uuid raw lines are deduped in parseClaude.
  SELECT 'all: duplicate event_id within session',
         agent,
         count(*),
         CAST(NULL AS VARCHAR),
         'Split rows must suffix event_id. Two rows sharing event_id in one session means a split forgot the suffix, or the same uuid was emitted twice (parser dedup missing for this agent).'
  FROM (
    SELECT agent, session_id, event_id, count(*) AS c
    FROM events
    WHERE event_id IS NOT NULL
    GROUP BY 1,2,3
    HAVING count(*) > 1
  )
  GROUP BY agent

  UNION ALL

  -- INVARIANT: tokens belong to one row per raw line (no duplication on splits)
  SELECT 'all: tokens duplicated across split rows',
         agent,
         count(*),
         any_value(source_file || ':' || source_line),
         'When a raw line emits multiple rows (split), only one row may carry input/output tokens. Duplication doubles per-session totals.'
  FROM (
    SELECT agent, source_file, source_line, count(*) AS c
    FROM events
    WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL
    GROUP BY 1,2,3
    HAVING count(*) > 1
  )
  GROUP BY agent

  UNION ALL

  -- INVARIANT: cost_usd belongs to one row per raw line
  SELECT 'all: cost duplicated across split rows',
         agent,
         count(*),
         any_value(source_file || ':' || source_line),
         'Like tokens: cost must live on a single row per raw line, or per-session cost doubles.'
  FROM (
    SELECT agent, source_file, source_line, count(*) AS c
    FROM events
    WHERE cost_usd IS NOT NULL
    GROUP BY 1,2,3
    HAVING count(*) > 1
  )
  GROUP BY agent

  UNION ALL

  -- INVARIANT: meaningful events should have a timestamp
  SELECT 'all: NULL ts on a content-bearing event',
         agent,
         count(*),
         any_value(source_file || ':' || source_line),
         'user/assistant/tool/reasoning/compacted/usage rows always have a ts in raw. NULL means the parser failed to pluck it.'
  FROM events
  WHERE ts IS NULL
    AND event_type IN ('user_message','assistant_message','tool_call','tool_result','reasoning','compacted','usage')
  GROUP BY agent

  UNION ALL

  -- INVARIANT: a tool_call needs an id so the result can pair
  SELECT 'all: tool_call without tool_call_id',
         agent,
         count(*),
         any_value(source_file || ':' || source_line),
         'tool_call rows must carry a tool_call_id; otherwise no tool_result can ever pair. (codex web_search_call has no id in raw — exempted.)'
  FROM events
  WHERE event_type = 'tool_call' AND tool_call_id IS NULL
    AND NOT (agent = 'codex' AND json_extract_string(raw, '$.payload.type') = 'web_search_call')
  GROUP BY agent

  UNION ALL

  -- INVARIANT: every agent produces some is_error=true rows. A 0 here means
  -- the parser is silently dropping the agent's native error signal
  -- (claude block.is_error, pi message.isError, codex exit-code in output).
  SELECT 'all: agent has zero is_error=true tool_results',
         agent,
         1,
         CAST(NULL AS VARCHAR),
         'Parser is not extracting the agent''s error flag. Check the tool_result branch in parse-session.ts.'
  FROM events
  WHERE event_type='tool_result'
  GROUP BY agent
  HAVING count(*) FILTER (WHERE is_error IS TRUE) = 0

  UNION ALL

  -- INVARIANT: is_error should be non-null on tool_results for agents whose
  -- format always carries the flag (claude block.is_error, pi message.isError).
  -- Codex is exempt: its exit code is only present for exec-style tools.
  SELECT 'all: tool_result with NULL is_error (claude/pi)',
         agent,
         count(*),
         any_value(source_file || ':' || source_line),
         'claude block.is_error and pi message.isError are always present in raw. NULL means the parser missed it.'
  FROM events
  WHERE event_type='tool_result' AND agent IN ('claude','pi') AND is_error IS NULL
  GROUP BY agent

  UNION ALL

  -- generic: events with no session_id at all (state machine failure)
  SELECT 'all: events with no session_id',
         agent,
         count(*),
         any_value(source_file || ':' || source_line),
         'session_id is carried in ParseState. A NULL means the session header was missing or appeared after the event.'
  FROM events
  WHERE session_id IS NULL
  GROUP BY agent

)
SELECT * FROM checks
WHERE n > 0
ORDER BY agent NULLS FIRST, n DESC;
