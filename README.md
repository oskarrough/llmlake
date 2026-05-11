# llmlake

A local tool for learning from LLM session logs across agents (Claude Code, Pi, Codex, ...).

---

Git clone github.org/oskarrough/llmlake and install [Duckdb](https://duckdb.org/install/)

`./llmlake collect` 

Moves all raw session files from your local computer into `./data/sessions`. The `data` folder is gitignored.

`./llmlake build` 

Transforms them into parquet files inside `data/parquet`.


```sh
./llmlake query -c "SELECT session_id, count(*) FROM events WHERE agent='pi' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;"
```

Query the parquet with duckdb.

Open a Codex (or similar) session in this folder and ask it to explore the data for you.

## Files

- `collect-claude` — copy from `~/.claude/projects/`
- `collect-pi` — copy Pi sessions
- `collect-codex` — copy from `~/.codex/sessions/`
- `build-parquet` — parse one raw JSONL file into normalized parquet under `agent=<x>/`
- `build` — parse every collected JSONL file
- `query` — duckdb shell over `data/parquet/` with an `events` view
