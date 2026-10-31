// Build-time price table: refresh LiteLLM (last download, then the committed snapshot, when offline), resolve one row per model seen in the lake, write data/prices.json for lib/events.sql to join. Cheap enough to run every build, and never touches parquet.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createPriceLookup,
  fetchLitellm,
  priceRow,
  SNAPSHOT_PATH,
  type Litellm,
  type PriceRow,
} from '../pricing.ts'
import { runQuestions } from './duck.ts'

const dataDir = join(import.meta.dir, '..', 'data')
export const PRICES_PATH = join(dataDir, 'prices.json')
const DOWNLOAD_PATH = join(dataDir, 'litellm-pricing.json')

// Fresh list when online; otherwise the newest copy on disk, with a warning naming its age.
async function loadLitellm(): Promise<{ litellm: Litellm; warning: string | null }> {
  try {
    const litellm = await fetchLitellm()
    await Bun.write(DOWNLOAD_PATH, JSON.stringify(litellm))
    return { litellm, warning: null }
  } catch (e) {
    const fallback = (await Bun.file(DOWNLOAD_PATH).exists()) ? DOWNLOAD_PATH : SNAPSHOT_PATH
    const age = new Date((await stat(fallback)).mtimeMs).toISOString().slice(0, 10)
    return {
      litellm: (await Bun.file(fallback).json()) as Litellm,
      warning: `warning: couldn't fetch prices (${(e as Error).message}), using the copy from ${age}`,
    }
  }
}

export async function writePrices(parquetGlob: string): Promise<{ warning: string | null }> {
  const [{ litellm, warning }, { models = [] }] = await Promise.all([
    loadLitellm(),
    runQuestions('', {
      models: `SELECT DISTINCT model FROM read_parquet('${parquetGlob}', union_by_name=true) WHERE model IS NOT NULL`,
    }),
  ])
  const lookup = createPriceLookup(litellm)
  const rows: PriceRow[] = []
  for (const { model } of models) {
    const match = lookup(String(model))
    if (match) rows.push(priceRow(String(model), match))
  }
  await Bun.write(PRICES_PATH, JSON.stringify(rows))
  return { warning }
}
