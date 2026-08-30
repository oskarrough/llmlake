# Status and parser findings — 2026-08-29

This report records issues found while collecting, building, querying, and inspecting
`llmlake status`. It is an investigation backlog, not a claim that every anomaly is a
parser bug.

## Executive summary

The most important product issue is that the dashboard currently conflates three
different things:

1. **Usage** — input, output, cache, sessions, calls, and events.
2. **Estimated model value** — what those tokens would cost at published API rates.
3. **Actually billed spend** — API charges, excluding subscription-backed usage.

Provider information is sufficient to separate some Pi routes, but there is no explicit
billing mode. As a result, subscription usage can look free (`$0.00`) in one path and
look like paid API spend in another.

The parser's own health query also currently returns multiple failures. The highest-risk
one for numerical accuracy is duplicate keyed Claude usage, because it can duplicate
token and cost totals. Duplicate identifiers, unhandled event types, missing session IDs,
and unmatched tool calls/results need investigation too.

## Findings to investigate

### 1. Cost is not the same as billed spend

**Observed**

- Claude Opus 5 had substantial usage but displayed `$0.00` in the model panel.
- Claude Code events usually have no provider value.
- Codex events contain tokens but no cost values.
- Pi separates `openrouter` from `openai-codex`, but both can carry a numeric
  `cost_usd` value supplied by Pi.
- The parser computes published-rate estimates for Claude and Codex when pricing is
  available, while Pi's cost is taken from the source event. These values have different
  semantics but share one column.

**Why it matters**

A numeric cost can mean either an estimate or a source-reported value. Neither proves
that the user was actually billed. Conversely, `$0.00` can mean subscription-backed,
unpriced, missing data, or genuinely free.

**Suggested direction**

- Add an explicit billing classification such as `subscription`, `api`, `unknown`.
- Track cost provenance separately: `source_reported`, `estimated`, `missing`.
- Keep estimated value separate from billed spend in the schema and dashboard.
- Render known subscription-backed usage as `sub`, as suggested by the user.
- Render missing pricing as `unpriced`, not `$0.00`.
- Verify how Pi defines `usage.cost` for `openai-codex`: actual charge or equivalent API
  value.

### 2. Provider routing is partly present but incomplete

**Observed in the recent audit window**

| Agent  | Provider       | Events | Token-bearing events | Cost-bearing events |
| ------ | -------------- | -----: | -------------------: | ------------------: |
| Claude | missing        | 45,467 |               10,834 |                 633 |
| Pi     | `openai-codex` | 33,719 |                7,035 |               7,035 |
| Codex  | `openai`       | 12,585 |                1,569 |                   0 |
| Pi     | `openrouter`   |  9,007 |                2,893 |               2,893 |
| Pi     | missing        |    282 |                    0 |                   0 |

**Why it matters**

The same model can be used through a paid API route and a subscription route. Grouping
only by model cannot answer how it was accessed or billed.

**Suggested direction**

- Make model reports group by or expose `provider` and billing mode.
- Add a parser-sanity check for token-bearing rows with missing provider where the raw
  format is expected to contain it.
- Decide whether provider should describe the model vendor (`openai`) or access route
  (`openrouter`, `openai-codex`). If both matter, store both.

### 3. The “By Model” trailing number is ambiguous

**Observed**

The model panel renders `events` after the cost without a visible label. For example,
the GLM 5.3 Flash row showed `$2.25  6,764`; `6,764` is the count of event rows, not
tokens, calls, or sessions.

**Why it matters**

An unlabeled count beside a dollar amount is easy to interpret as tokens or requests.
Event count is also dominated by message/tool structure and is not necessarily the most
useful model-usage unit.

**Suggested direction**

- Label the value explicitly as `events`, or replace it with calls/token-bearing events.
- Consider showing compact input/output token totals per model.
- Include provider or billing mode when identical models can be reached through
  different routes.

### 4. Token totals need named semantics

**Observed**

Adding input, output, cache-read, and cache-write tokens produced a large “total” that
was not comparable to the status dashboard's `in` number. The dashboard correctly shows
the buckets separately, but ad-hoc queries can easily combine them into a misleading
headline.

**Suggested direction**

- Avoid a generic `total_tokens` metric unless its formula is explicit.
- Prefer named metrics: `input`, `output`, `cache read`, and `cache write`.
- If a combined figure is useful, call it `processed tokens including cache`, not simply
  `tokens used`.
- Add documented query examples that match the overview panel exactly.

### 5. Possible future timestamps or timezone mismatch

**Observed**

At approximately 02:50 local time on 2026-08-29, the database contained events through
10:18 local offset on the same date. A query with only a lower date bound therefore
included records later than the user's stated current time.

**Why it matters**

Future-dated rows can inflate “today”, rolling-period, and ad-hoc date-range results.
This may be a source clock issue, timezone normalization issue, or an incorrect
assumption about the user's local timezone.

**Suggested direction**

- Compare raw timestamps with parsed timestamps for the affected source files.
- Confirm whether `ts` is normalized consistently across agents.
- Add a parser-sanity row for events implausibly later than the build time.
- Make rolling-period queries cap the range at the query's current timestamp.

### 6. Parser-health suite currently reports failures

Running `./query queries/parser-sanity.sql` returned the following findings. The suite
states that zero rows is healthy.

| Check                                   | Agent  |   Count |
| --------------------------------------- | ------ | ------: |
| Unhandled `other` event types           | Claude |  22,413 |
| Duplicate event IDs within a session    | Claude |   3,912 |
| Duplicate event IDs within a session    | Pi     |   2,193 |
| Duplicate row IDs                       | all    |   1,390 |
| Unhandled `other` event types           | Codex  |     935 |
| Unhandled `other` event types           | Pi     |     746 |
| Orphan tool calls without results       | Cursor |     227 |
| Duplicate keyed assistant usage         | Claude |     224 |
| Events with no session ID               | Claude |     156 |
| Duplicate event IDs within a session    | Hermes |      34 |
| Orphan tool calls without results       | Pi     |      34 |
| Orphan tool calls without results       | Claude |      32 |
| Orphan tool calls without results       | Codex  |      23 |
| Orphan tool results without calls       | Claude |       7 |
| No extracted error-bearing tool results | Hermes | 1 check |

**Priority interpretation**

1. **Duplicate keyed Claude usage** — directly threatens token and cost accuracy.
2. **Duplicate row/event IDs** — threatens stable identity, joins, and deduplication;
   determine whether token-bearing rows are affected.
3. **Unhandled event types** — can silently lose semantics and distort activity reports.
4. **Missing session IDs** — can break per-session aggregation and pairing.
5. **Orphan tool calls/results** — may distort tool reliability; some unfinished calls
   are natural, so sample before treating all as parser defects.
6. **Hermes error extraction** — likely makes Hermes tool reliability look healthier
   than it is.

## Recommended investigation order

1. Reproduce and eliminate duplicate keyed Claude usage; compare token sums before and
   after.
2. Sample duplicate row/event IDs and determine whether they come from row splitting,
   repeated raw events, or cross-file collection overlap.
3. Classify the largest Claude, Codex, and Pi `other` event variants and add explicit
   mappings plus regression checks.
4. Define `billing_mode`, `cost_provenance`, estimated value, and billed spend.
5. Verify Pi's `openai-codex` cost semantics and ensure OpenRouter and subscription usage
   remain separately reportable for the same model.
6. Investigate future timestamps and add a guardrail.
7. Improve dashboard labels only after the underlying semantics are explicit.

## Verification after fixes

- Rebuild only the affected agent partition.
- Run `./query queries/parser-sanity.sql`; expect zero rows or documented accepted
  exceptions.
- Compare token, cost, event-type, provider, and model aggregates before and after.
- Spot-check raw sessions for each fixed parser path.
- Run `bun run check` as required by the repository instructions.

## Relevant code and queries

- `parse-session.ts` — agent parsing and field extraction.
- `pricing.ts` — estimated Claude/Codex pricing and model normalization.
- `queries/parser-sanity.sql` — parser integrity checks.
- `queries/by-model.sql` — model panel query; currently returns cost plus event count.
- `queries/overview.sql` — dashboard token and cost headline metrics.
- `status.ts` — panel labels and rendering.

## Verified things we want to improve

- [x] Separate API-equivalent estimated value from actually billed spend, and expose `billing_mode` plus `cost_provenance`. The shared classified view now labels published-rate value explicitly and keeps billed spend null because no invoice data exists.
- [x] Render subscription-backed usage as `sub` and missing pricing as `unpriced`, rather than coercing either to `$0.00`. Subscription models missing rates display both facts as `sub · unpriced`.
- [x] Expose model vendor and access route separately, including route and billing mode in model reports. These are derived from raw agent/provider/model fields so policy changes need no parquet rebuild.
- [x] Give every bar-panel extra a visible label (`calls`, `sessions`, `events`, or `%`). The By Model trailing number now explicitly says `events`.
- [x] Make token metrics and examples use explicit, consistent bucket names: input, output, cache read, and cache write. README now documents the cache-hit formula and avoids unnamed generic token totals.
- [x] Keep unknown model/provider usage visible instead of silently dropping it from model reports. All 1,106 Cursor rows with token data but no source model now appear under `(unknown model)` with route and billing context.
- [x] Cap `today`, month, and rolling-period scopes at `current_timestamp`. A synthetic future-row probe confirmed every bounded dashboard scope excludes it while `all` remains unbounded.
- [x] Normalize timezone-naive Hermes timestamps explicitly. All 97 Hermes rows now preserve their raw local wall-clock time.
- [x] Make incremental builds prune parquet whose raw source was deleted or renamed and rebuild after parser/schema logic changes. The 17 verified stale Pi parquet files were removed, clearing 2,193 duplicate events, and builds now use a code marker to prevent stale derived data from surviving future changes.
- [x] Make aggregate joins defensive against duplicate event/tool keys so stale or overlapping sources cannot multiply rows many-to-many. All tool aggregates now use session-scoped keys and collapse replay duplicates before joining.
- [x] Give every normalized split row a unique `row_id` and `event_id`. Cursor and Hermes now have zero duplicate row IDs, and Hermes now has zero duplicate event IDs.
- [x] Replace all remaining `other` event types with explicit semantics: housekeeping is metadata, Pi compactions are `compacted`, and meaningful Pi/Codex subagent, tool-search, bash-execution, and realtime events are preserved. The rebuilt lake has zero `other` rows, so future unknown variants remain visible as regressions.
- [x] Parse Claude workflow journals as synthetic child sessions. All five journals now have stable workflow and parent session IDs; zero Claude rows remain without a session ID.
- [x] Split Claude assistant rows that contain both text and `tool_use` into message plus tool-call rows. All seven formerly orphaned Claude tool results now have matching calls, including parallel-call support without duplicated usage.
- [x] Extract Hermes tool errors from structured tool output. The three non-zero exit-code results are now recorded as errors.
- [x] Preserve stop/abort metadata on split tool-call rows and refine orphan-call checks around unfinished captures. Pi split calls now retain abort/error reasons; its remaining 16 unmatched calls are genuine incomplete `toolUse` captures rather than parser defects.
- [x] Make parser-sanity failures actionable and capable of returning zero. True parser invariants remain strict, while small measured allowances track source-inherent incomplete calls and default new agents to zero tolerance.
