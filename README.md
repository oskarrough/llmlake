# llmlake

A local tool that helps you learn from your (possibly many) LLM sessions across agents (Claude Code, Pi, Codex, Hermes): it transforms the raw session files into denormalized .parquet files you can query with DuckDB and turn into (HTML) insights using installable agent skills.

```
  ~/.claude  ~/.codex  ~/.pi  ~/.hermes
      └──────────┴──┬───┴─────────┘
                    ▼
                 collect → data/sessions (↔ optional rsync)
                    │
                    ▼
                 build → data/parquet
                    │
         ┌──────────┴──────────┐
       query               ai skills
       (SQL)            (HTML insights)
```

---

Install [Duckdb](https://duckdb.org/install/) and `git clone https://github.com/oskarrough/llmlake`.

Install the skills into any supported coding agent:

```sh
bunx skills add oskarrough/llmlake
```

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

## Skills

After `collect` and `build`, open any coding agent with skills support in this repo and run one of these:

- `llmlake:explore-lake` — ask questions about sessions, costs, tools, models, projects, or activity patterns.
- `llmlake:generate-insights` — create an HTML report for a period, such as last week, last month, or all time.
- `llmlake:inspect-session` — create a focused HTML deep-dive for one session id.

## File overview for contributors

- `collect-{claude,codex,hermes, pi}` — copy sessions
- `build` — parse every collected JSONL file into parquet 
- `build-one` — parse a single raw JSONL file into parquet
- `query` — duckdb shell over `data/parquet/` with an `events` view
