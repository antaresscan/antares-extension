// scripts/corpus-capture-missing.ts
//
// Capture /api/scan fixtures for any corpus entry whose fixture file
// is missing on disk — regardless of skipFixture flag. Default
// corpus-capture.ts filters out skipFixture entries so freshly
// auto-discovered tokens (which all start as skipFixture: true) never
// get their first fixture from the bulk run; this script unblocks
// that by targeting "no fixture yet" entries directly.
//
// Once the fixture lands the entry can have skipFixture stripped via
// scripts/mark-pending-fixtures.ts (which only ADDs the flag — to
// remove it, the next discovery cycle's merge regenerates the file).
//
// Usage:
//   npx tsx scripts/corpus-capture-missing.ts            # capture all missing
//   npx tsx scripts/corpus-capture-missing.ts --max=200  # cap to N captures
//   npx tsx scripts/corpus-capture-missing.ts --max=0    # dry-run, list only

import { promises as fs } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CORPUS } from "../__tests__/backtest/corpus"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, "..", "__tests__", "backtest", "fixtures")
const SCAN_URL = "https://antares-extension.vercel.app/api/scan"
const ORIGIN = "https://antares-website.vercel.app"

const DELAY_MS = 2500
const RETRY_DELAYS_MS = [3000, 6000]

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

async function captureOne(ca: string, symbol: string): Promise<unknown | null> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1]
      console.log(`    retry ${attempt} in ${delay}ms…`)
      await sleep(delay)
    }
    try {
      const url = `${SCAN_URL}?ca=${encodeURIComponent(ca)}&fresh=1`
      const res = await fetch(url, { headers: { Origin: ORIGIN } })
      if (!res.ok) {
        console.log(`    ${symbol}: HTTP ${res.status}`)
        continue
      }
      const json: unknown = await res.json()
      if (typeof json === "object" && json !== null && "risk" in json) {
        return json
      }
      console.log(`    ${symbol}: bad shape`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.log(`    ${symbol}: error ${msg}`)
    }
  }
  return null
}

interface SlimResp {
  score: number
  risk: string
  flags?: Array<{ severity: string; label: string; impact?: number }>
  safeBlockedReasons?: string[]
  lpBurned?: boolean | null
  lpLocked?: boolean | null
  holders?: number | null
  liquidity?: number | null
}

function slim(payload: unknown): SlimResp {
  const r = payload as Record<string, unknown>
  return {
    score: typeof r.score === "number" ? r.score : 0,
    risk: typeof r.risk === "string" ? r.risk : "CAUTION",
    flags: Array.isArray(r.flags) ? (r.flags as SlimResp["flags"]) : [],
    safeBlockedReasons: Array.isArray(r.safeBlockedReasons) ? r.safeBlockedReasons as string[] : [],
    lpBurned: r.lpBurned as boolean | null ?? null,
    lpLocked: r.lpLocked as boolean | null ?? null,
    holders: r.holders as number | null ?? null,
    liquidity: r.liquidity as number | null ?? null,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const max = Number(args.find(a => a.startsWith("--max="))?.split("=")[1] ?? Number.MAX_SAFE_INTEGER)

  await fs.mkdir(FIXTURES_DIR, { recursive: true })

  // Find entries without a fixture file
  const missing: typeof CORPUS = []
  for (const e of CORPUS) {
    const path = join(FIXTURES_DIR, `${e.symbol.toLowerCase()}.json`)
    try { await fs.access(path) } catch { missing.push(e) }
  }

  console.log(`${missing.length} entries missing fixtures (corpus=${CORPUS.length}).`)
  if (max === 0) {
    console.log("Dry-run; printing first 20 missing:")
    missing.slice(0, 20).forEach(e => console.log(`  ${e.symbol.padEnd(14)} ${e.ca}`))
    return
  }

  const target = missing.slice(0, max)
  console.log(`Capturing ${target.length} of them…`)
  console.log()

  let captured = 0
  let failed = 0
  for (const entry of target) {
    console.log(`  ${entry.symbol.padEnd(14)} capturing ${entry.ca.slice(0, 12)}…`)
    const payload = await captureOne(entry.ca, entry.symbol)
    if (payload) {
      const slimResp = slim(payload)
      const path = join(FIXTURES_DIR, `${entry.symbol.toLowerCase()}.json`)
      await fs.writeFile(path, JSON.stringify(slimResp, null, 2))
      console.log(`    -> ${slimResp.risk} ${slimResp.score} (expected ${entry.expectedVerdict})`)
      captured++
    } else {
      console.log(`    -> FAILED ${entry.symbol}`)
      failed++
    }
    await sleep(DELAY_MS)
  }

  console.log()
  console.log(`Done. captured=${captured} failed=${failed}`)
}

void main()
