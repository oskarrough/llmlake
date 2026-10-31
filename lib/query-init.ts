// Init SQL for ./query on stdout: events, its unfiltered `scoped` twin, classified.
import { join } from 'node:path'
import { eventsSql } from './lake.ts'

console.log(
  [
    await eventsSql(),
    // `scoped` is the unfiltered twin of the view `status` builds, so queries/*.sql work here too.
    'CREATE OR REPLACE VIEW scoped AS SELECT * FROM events;',
    await Bun.file(join(import.meta.dir, 'classified.sql')).text(),
  ].join('\n'),
)
