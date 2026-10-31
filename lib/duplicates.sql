-- Model calls recorded more than once, so lib/events.sql counts each call's tokens and cost once. {parquet} is filled in by lib/duplicates.ts. One row per extra copy: dup = the row to stop counting, kept = the row that counts, reason, and (bridges) the exact model the call used.
-- copy: the same agent logged the call in several files: Claude resumes/forks repeat history under a new session, pi /fork copies the parent's entries, Codex archives a session by moving its file (collect keeps both). Same millisecond timestamp and all four token counts = same call; the session that started first is the original.
-- bridge: pi's claude-bridge and opencode's claude-agent run calls through the Claude Agent SDK, which logs them again as Claude Code `sdk-ts` sessions. Matched 1:1 on identical tokens within two minutes (separate processes stamp separately); the harness row stays (it's where the user worked) and takes Claude Code's exact model, since opencode logs aliases like `sonnet`.
WITH lake AS (
  SELECT row_id, agent, session_id, source_file, ts, model, raw->>'entrypoint' AS entrypoint,
    coalesce(input_tokens, 0) AS i, output_tokens AS o,
    coalesce(cache_read_tokens, 0) AS cr, coalesce(cache_write_tokens, 0) AS cw
  FROM read_parquet('{parquet}', hive_partitioning=true, union_by_name=true)
  WHERE output_tokens > 0
),
session_start AS (
  SELECT session_id, min(ts) AS started
  FROM read_parquet('{parquet}', hive_partitioning=true, union_by_name=true)
  WHERE ts IS NOT NULL
  GROUP BY 1
),
copies AS (
  SELECT l.*, row_number() OVER (
    PARTITION BY l.agent, l.ts, l.i, l.o, l.cr, l.cw
    ORDER BY s.started NULLS LAST, l.source_file, l.row_id
  ) AS nth,
  first_value(l.row_id) OVER (
    PARTITION BY l.agent, l.ts, l.i, l.o, l.cr, l.cw
    ORDER BY s.started NULLS LAST, l.source_file, l.row_id
  ) AS original
  FROM lake l LEFT JOIN session_start s USING (session_id)
),
calls AS (SELECT * FROM copies WHERE nth = 1),
pairs AS (
  SELECT b.row_id AS kept, c.row_id AS dup, c.model, abs(epoch(c.ts) - epoch(b.ts)) AS gap
  FROM calls b JOIN calls c ON c.i = b.i AND c.o = b.o AND c.cr = b.cr AND c.cw = b.cw
  WHERE b.agent IN ('pi', 'opencode') AND c.agent = 'claude' AND c.entrypoint = 'sdk-ts'
    AND abs(epoch(c.ts) - epoch(b.ts)) < 120
),
bridged AS (
  SELECT kept, dup, model FROM (
    SELECT *,
      row_number() OVER (PARTITION BY kept ORDER BY gap, dup) AS by_kept,
      row_number() OVER (PARTITION BY dup ORDER BY gap, kept) AS by_dup
    FROM pairs
  ) WHERE by_kept = 1 AND by_dup = 1
)
SELECT row_id AS dup, original AS kept, 'copy' AS reason, NULL AS model FROM copies WHERE nth > 1
UNION ALL
SELECT dup, kept, 'bridge', model FROM bridged
