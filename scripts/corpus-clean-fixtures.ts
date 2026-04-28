// scripts/corpus-clean-fixtures.ts
//
// Removes fixture files that no longer correspond to a corpus entry,
// or where the captured `resolvedMint` doesn't match the corpus entry's
// expected `ca` (the wrong-mint case from the busted CG resolver).
//
// The accuracy backtest reads fixtures keyed by symbol. If two corpus
// entries had the same symbol but different mints, the second capture
// clobbered the first. This cleanup catches that.

import { promises as fs } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CORPUS } from "../__tests__/backtest/corpus"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, "..", "__tests__", "backtest", "fixtures")

interface MaybeMint { resolvedMint?: string }

async function main() {
  const corpusBySymbol = new Map<string, string>() // symbol.lower → expected ca
  for (const e of CORPUS) corpusBySymbol.set(e.symbol.toLowerCase(), e.ca)

  const files = await fs.readdir(FIXTURES_DIR)
  let kept = 0
  let removedOrphan = 0
  let removedMismatch = 0

  for (const f of files) {
    if (!f.endsWith(".json")) continue
    const symbol = f.replace(/\.json$/i, "")
    const path = join(FIXTURES_DIR, f)
    const expectedCa = corpusBySymbol.get(symbol)

    if (!expectedCa) {
      // Symbol no longer in corpus → orphan fixture
      await fs.unlink(path)
      console.log(`  removed ORPHAN ${f}`)
      removedOrphan++
      continue
    }

    try {
      const raw = await fs.readFile(path, "utf-8")
      const data = JSON.parse(raw) as MaybeMint
      const actualCa = data.resolvedMint
      if (actualCa && actualCa !== expectedCa) {
        await fs.unlink(path)
        console.log(`  removed MISMATCH ${f} (fixture ${actualCa.slice(0,10)}… vs corpus ${expectedCa.slice(0,10)}…)`)
        removedMismatch++
        continue
      }
      kept++
    } catch (e) {
      console.log(`  read failed for ${f}: ${e instanceof Error ? e.message : e}`)
    }
  }

  console.log()
  console.log(`Done. kept=${kept} removed_orphan=${removedOrphan} removed_mismatch=${removedMismatch}`)
}

void main()
