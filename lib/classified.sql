-- Policy: claude/codex are subscription-backed login CLIs and pi's route is its provider, so cost_usd is always an API-equivalent estimate — never a billed amount.
CREATE OR REPLACE VIEW classified AS
SELECT
  s.*,
  s.cost_usd                            AS estimated_value_usd,
  NULL::DOUBLE                          AS billed_spend_usd,
  CASE
    WHEN s.agent IN ('claude', 'codex') THEN 'subscription'
    WHEN s.provider IN ('openai-codex', 'claude-code-subscription') THEN 'subscription'
    WHEN s.provider IN ('lmstudio', 'ollama') THEN 'local'
    WHEN s.agent = 'hermes' THEN 'unknown' -- platform tag, not a model route
    WHEN s.provider IS NOT NULL THEN 'api'
    ELSE 'unknown'
  END                                   AS billing_mode,
  CASE
    WHEN s.agent IN ('claude', 'codex') THEN 'parser_estimate'
    WHEN s.agent = 'pi' THEN 'source_rate_estimate'
    ELSE 'unavailable'
  END                                   AS cost_provenance,
  CASE
    WHEN s.model IS NULL THEN 'unknown'
    WHEN s.model ILIKE '~deepseek/%' THEN 'deepseek' -- openrouter ~vendor alias
    WHEN s.model ILIKE 'zai/%' THEN 'z-ai'
    WHEN s.model ILIKE 'moonshotai/%' THEN 'moonshot'
    WHEN strpos(s.model, '/') > 0 THEN lower(split_part(s.model, '/', 1))
    WHEN lower(s.model) LIKE 'claude%' THEN 'anthropic'
    WHEN lower(s.model) LIKE 'gpt%' OR lower(s.model) LIKE 'codex%' THEN 'openai'
    WHEN lower(s.model) LIKE 'deepseek%' THEN 'deepseek'
    WHEN lower(s.model) LIKE 'qwen%' THEN 'qwen'
    WHEN lower(s.model) LIKE 'glm%' THEN 'z-ai'
    WHEN lower(s.model) LIKE 'kimi%' THEN 'moonshot'
    WHEN lower(s.model) LIKE 'gemini%' OR lower(s.model) LIKE 'gemma%' THEN 'google'
    ELSE 'unknown'
  END                                   AS vendor,
  CASE
    WHEN s.agent = 'claude' THEN 'claude-code'
    WHEN s.agent = 'codex' THEN 'codex-cli'
    WHEN s.agent = 'cursor' THEN 'cursor'
    ELSE coalesce(s.provider, 'unknown')
  END                                   AS route
FROM scoped s;
