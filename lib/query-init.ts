// Init SQL for ./query on stdout (events, its unfiltered `scoped` twin, classified); the stale-parquet warning goes to stderr so it shows without polluting the SQL.
import { join } from 'node:path'
import { AGENTS } from '../parse-session.ts'
import { eventsSql, staleParquetWarning } from './lake.ts'

const warning = await staleParquetWarning(AGENTS)
if (warning) console.error(warning + '\n')

console.log(
  [
    await eventsSql(),
    // `scoped` is the unfiltered twin of the view `status` builds, so queries/*.sql work here too.
    'CREATE OR REPLACE VIEW scoped AS SELECT * FROM events;',
    // The first day the period-based questions (plans.sql) cover: all of the lake.
    'CREATE OR REPLACE VIEW period AS SELECT min(ts)::DATE AS start FROM events;',
    await Bun.file(join(import.meta.dir, 'classified.sql')).text(),
  ].join('\n'),
)
