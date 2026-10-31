-- The `events` view: parquet rows with duplicates and prices applied at query time. {parquet}, {prices} and {duplicates} are filled in by lib/lake.ts.
-- A call recorded more than once (data/duplicates.json, see lib/duplicates.sql) counts once: the extra copies keep their rows but lose tokens and cost, and point at the row that counts in duplicate_of. A bridged call's kept row takes the exact model Claude Code logged.
-- cost_usd = the cost the log itself reported when positive (pi), else tokens × the model's row in data/prices.json (written by every build), else NULL (unpriced). source_cost_usd keeps the logged value.
-- Token conventions: codex input includes cached input (fresh = input - cache_read); every other agent reports four disjoint buckets.

-- One bucket's cost; tokens beyond 200k bill at the higher marginal rate when the model has one. Rates are per million.
CREATE OR REPLACE MACRO llmlake_tier(tokens, rate, above) AS
  CASE
    WHEN coalesce(tokens, 0) <= 0 THEN 0
    WHEN above IS NOT NULL AND tokens > 200000 THEN (200000 * rate + (tokens - 200000) * above) / 1e6
    ELSE tokens * rate / 1e6
  END;

CREATE OR REPLACE VIEW prices AS
SELECT * FROM read_json('{prices}', format='array', columns={
  model: 'VARCHAR', matched: 'VARCHAR', input: 'DOUBLE', output: 'DOUBLE', cache_read: 'DOUBLE', cache_write: 'DOUBLE',
  input_above_200k: 'DOUBLE', output_above_200k: 'DOUBLE',
  cache_read_above_200k: 'DOUBLE', cache_write_above_200k: 'DOUBLE'
});

CREATE OR REPLACE VIEW duplicates AS
SELECT * FROM read_json('{duplicates}', format='array', columns={
  dup: 'VARCHAR', kept: 'VARCHAR', reason: 'VARCHAR', model: 'VARCHAR'
});

CREATE OR REPLACE VIEW events AS
WITH lake AS (
  SELECT
    e.* REPLACE (
      coalesce(k.model, e.model) AS model,
      CASE WHEN d.dup IS NULL THEN e.input_tokens END AS input_tokens,
      CASE WHEN d.dup IS NULL THEN e.output_tokens END AS output_tokens,
      CASE WHEN d.dup IS NULL THEN e.cache_read_tokens END AS cache_read_tokens,
      CASE WHEN d.dup IS NULL THEN e.cache_write_tokens END AS cache_write_tokens,
      CASE WHEN d.dup IS NULL THEN e.cost_usd END AS cost_usd
    ),
    d.kept AS duplicate_of
  FROM read_parquet('{parquet}', hive_partitioning=true, union_by_name=true) e
  LEFT JOIN duplicates d ON d.dup = e.row_id
  LEFT JOIN duplicates k ON k.kept = e.row_id AND k.reason = 'bridge'
)
SELECT
  e.* REPLACE (
    CASE
      WHEN e.cost_usd > 0 THEN e.cost_usd
      -- Rows without usage (tool calls, split rows) stay NULL so cost lands on one row per raw line.
      WHEN e.input_tokens IS NULL AND e.output_tokens IS NULL
        AND e.cache_read_tokens IS NULL AND e.cache_write_tokens IS NULL THEN e.cost_usd
      WHEN p.model IS NULL THEN NULL
      WHEN e.agent = 'codex' THEN
        llmlake_tier(greatest(coalesce(e.input_tokens, 0) - coalesce(e.cache_read_tokens, 0), 0), p.input, p.input_above_200k)
        + coalesce(e.cache_read_tokens, 0) * p.cache_read / 1e6
        + llmlake_tier(e.output_tokens, p.output, p.output_above_200k)
      ELSE
        llmlake_tier(e.input_tokens, p.input, p.input_above_200k)
        + llmlake_tier(e.output_tokens, p.output, p.output_above_200k)
        + llmlake_tier(e.cache_read_tokens, p.cache_read, p.cache_read_above_200k)
        + llmlake_tier(e.cache_write_tokens, p.cache_write, p.cache_write_above_200k)
    END AS cost_usd
  ),
  e.cost_usd AS source_cost_usd
FROM lake e
LEFT JOIN prices p ON p.model = e.model;
