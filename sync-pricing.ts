#!/usr/bin/env bun
// Refresh the committed LiteLLM snapshot (litellm-pricing.json): the offline fallback when a build can't fetch live prices. Builds fetch their own copy into data/, so run this only to update the fallback.
import { fetchLitellm, SNAPSHOT_PATH } from './pricing.ts'

const litellm = await fetchLitellm()
await Bun.write(SNAPSHOT_PATH, JSON.stringify(litellm))
console.log(
  `wrote ${Object.keys(litellm).length} models → ${SNAPSHOT_PATH} (${(Bun.file(SNAPSHOT_PATH).size / 1024) | 0} KB)`,
)
