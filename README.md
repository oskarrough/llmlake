# llmlake

A local tool that helps you learn from your (possibly many) LLM sessions across agents (Claude Code, Pi, Codex, Hermes): it transforms the raw session files into denormalized .parquet files you can query with DuckDB and turn into (HTML) insights using the built-in AI skills.

---

Install [Duckdb](https://duckdb.org/install/) and `git clone git@github.com/oskarrough/llmlake`.

Once inside the cloned repo, you can _collect_ sessions, _build_ them into .parquet files, _query_ the DB with SQL.

`./llmlake collect`

Moves all raw session files from your local computer into `./data/sessions`. The `data` folder is gitignored.

`./llmlake build`

Transforms them into parquet files inside `data/parquet`.

```sh
./llmlake query -c "SELECT session_id, count(*) FROM events WHERE agent='pi' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;"
```

Query the parquet with duckdb (or ask your agent to do it)

`./llmlake sync <path>`

Bonus feature: two-way rsync between `data/sessions/` and a shared folder, so multiple devices share one library. For example, I use it to store my data in dropbox: `./llmlake sync ~/Dropbox/my-ai-sessions`.

## Insights

After `collect` and `build`, open an AI coder in this repo (Claude Code, Codex, ...) and run a skill:

- `generate-insights` — an HTML report for a period (a week, a month, all time)
- `inspect-session` — a deep-dive into one session
- `explore-lake` — ask questions about the data and get answers

## Files

- `collect-claude` — copy from `~/.claude/projects/`
- `collect-pi` — copy Pi sessions
- `collect-codex` — copy from `~/.codex/sessions/`
- `build` — parse every collected JSONL file into parquet under `agent=<x>/`
- `build-one` — parse a single raw JSONL file into parquet
- `query` — duckdb shell over `data/parquet/` with an `events` view
