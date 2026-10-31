// Build-time duplicate table: find model calls recorded more than once (lib/duplicates.sql) and write data/duplicates.json for lib/events.sql to join. Like prices, it lives beside the parquet so the raw rows stay as the sessions wrote them.
import { join } from 'node:path'
import { runQuestions } from './duck.ts'

export const DUPLICATES_PATH = join(import.meta.dir, '..', 'data/duplicates.json')

export async function writeDuplicates(parquetGlob: string): Promise<Record<string, number>> {
  const sql = (await Bun.file(join(import.meta.dir, 'duplicates.sql')).text()).replaceAll(
    '{parquet}',
    parquetGlob.replaceAll("'", "''"),
  )
  const { duplicates = [] } = await runQuestions('', { duplicates: sql })
  await Bun.write(DUPLICATES_PATH, JSON.stringify(duplicates))
  const counts: Record<string, number> = {}
  for (const d of duplicates) counts[String(d.reason)] = (counts[String(d.reason)] ?? 0) + 1
  return counts
}
