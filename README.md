# llmlake

A small data lake for LLM session logs across agents (Claude Code, Pi, Codex, ...).

---

Install duckdb : https://duckdb.org/install/.

Collect raw session files from your local computer into llmlake/data/sessions. The `data` folder is gitignored.

Transform them into parquet files inside `data/parquet`:

```sh
bun run build
```

Query the parquet with duckdb:

```sh
./query -c "SELECT session_id, count(*) FROM events WHERE agent='pi' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;"
```

That's it!

## Folders

- `data/sessions/` is the source of truth, synced across devices.
- `data/parquet/` is derived; safe to delete and regenerate.
- `data/` as a whole is gitignored.

## Files

- `collect-claude` — copy from `~/.claude/projects/`
- `collect-pi` — copy Pi sessions
- `collect-codex` — copy from `~/.codex/sessions/`
- `build-parquet` — parse one raw JSONL file into normalized parquet under `agent=<x>/`
- `build-all` — parse every collected JSONL file
- `query` — duckdb shell over `data/parquet/` with an `events` view
