// Shared unpriced-model warning for build and status: rows come from queries/unpriced-models.sql.
import { join } from 'node:path'
import type { Row } from './duck.ts'
import { plural } from './ui.ts'

export const unpricedSql = await Bun.file(
  join(import.meta.dir, '..', 'queries/unpriced-models.sql'),
).text()

export function unpricedWarning(rows: Row[]): string | null {
  if (rows.length === 0) return null
  const models = rows.map((r) => `${r.model} (${plural(Number(r.sessions), 'session')})`)
  return `warning: no price for ${models.join(', ')}. Run ./sync-pricing.ts && ./llmlake build, or add them to PRICING in pricing.ts`
}
