// scripts/corpus-capture.ts
//
// Capture /api/scan responses for the corpus and write them as JSON
// fixtures under __tests__/backtest/fixtures/. The accuracy backtest
// reads these fixtures and asserts the verdict matches the expected
// label in corpus.ts.
//
// Usage:
//   npx tsx scripts/corpus-capture.ts             # capture all corpus tokens
//   npx tsx scripts/corpus-capture.ts USDC        # capture by symbol
//   npx tsx scripts/corpus-capture.ts <CA>        # capture by mint
//   npx tsx scripts/corpus-capture.ts --refresh   # re-capture all (skip-skip)
//
// Fixtures are checked into git so CI runs without HTTP. Refresh them
// when the on-chain state shifts and a token's expected verdict
// drifts (e.g. new whale enters, LP gets locked retroactively).

import { promises as fs } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CORPUS } from "../__tests__/backtest/corpus"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, "..", "__tests__", "backtest", "fixtures")
const SCAN_URL = "https://antares-extension.vercel.app/api/scan"
const ORIGIN = "https://antares-website.vercel.app"

// Per-call delay so we don't trip rate-limit on the corpus run.
// 30 req / 60s sliding (see api/_lib/middleware.ts) = ~2s between
// calls leaves headroom. We keep it conservative at 2.5s.
const DELAY_MS = 2500

// Per-call retry on cold-start timeouts. The first call after Vercel
// idle-shutdown often returns FUNCTION_INVOCATION_TIMEOUT; the second
// call almost always succeeds against a warm function pool.
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
      console.log(`    ${symbol}: bad shape`, JSON.stringify(json).slice(0, 100))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.log(`    ${symbol}: error ${msg}`)
    }
  }
  return null
}

async function writeFixture(symbol: string, payload: unknown) {
  await fs.mkdir(FIXTURES_DIR, { recursive: true })
  const path = join(FIXTURES_DIR, `${symbol.toLowerCase()}.json`)
  // Pretty-print for human-reviewable diffs, but truncate giant
  // arrays (candles, recentTransfers) so the corpus diff stays
  // focused on scoring-relevant fields.
  const slim = slimResponse(payload)
  await fs.writeFile(path, JSON.stringify(slim, null, 2))
  console.log(`    wrote ${path}`)
}

// Strip noisy fields from the captured response so fixtures stay
// small and diffable. The scoring-relevant fields (risk, score,
// flags, safeBlockedReasons, lpBurned, lpLocked, holders, …) all
// stay. Big arrays of candles/transfers are summarised, not stripped
// entirely, so any test that needs them later can still see shape.
function slimResponse(p: unknown): unknown {
  if (typeof p !== "object" || p === null) return p
  const r = { ...(p as Record<string, unknown>) }
  if (Array.isArray(r.candles)) {
    r.candles = `[${(r.candles as unknown[]).length} candles, redacted for fixture]`
  }
  if (Array.isArray(r.recentTransfers)) {
    r.recentTransfers = `[${(r.recentTransfers as unknown[]).length} transfers, redacted for fixture]`
  }
  return r
}

async function main() {
  const args = process.argv.slice(2)
  const refresh = args.includes("--refresh")
  const targets = args.filter(a => !a.startsWith("--"))

  let entries = CORPUS
  if (targets.length > 0) {
    // Explicit symbol target — capture even if marked skipFixture
    // (gives the user a way to retry the large-dataset tokens once
    // the underlying 504 is resolved).
    entries = CORPUS.filter(e =>
      targets.includes(e.symbol) ||
      targets.includes(e.symbol.toUpperCase()) ||
      targets.includes(e.ca),
    )
    if (entries.length === 0) {
      console.error(`No corpus entry matches: ${targets.join(", ")}`)
      process.exit(1)
    }
  } else {
    // Default capture run skips entries flagged skipFixture so the
    // bulk run doesn't always end with the same 3 known timeouts.
    // Explicit `npx tsx ... USDC` still works for retry attempts.
    entries = CORPUS.filter(e => !e.skipFixture)
  }

  console.log(`Capturing ${entries.length} corpus entries…`)
  console.log(`Endpoint: ${SCAN_URL}`)
  console.log(`Output:   ${FIXTURES_DIR}`)
  console.log()

  let captured = 0
  let skipped = 0
  let failed = 0

  for (const entry of entries) {
    const fixturePath = join(FIXTURES_DIR, `${entry.symbol.toLowerCase()}.json`)
    let exists = false
    try { await fs.access(fixturePath); exists = true } catch { /* ok */ }
    if (exists && !refresh) {
      console.log(`  ${entry.symbol.padEnd(10)} skipped (fixture exists, --refresh to overwrite)`)
      skipped++
      continue
    }

    console.log(`  ${entry.symbol.padEnd(10)} capturing ${entry.ca.slice(0, 10)}…`)
    const payload = await captureOne(entry.ca, entry.symbol)
    if (payload) {
      await writeFixture(entry.symbol, payload)
      const result = payload as Record<string, unknown>
      console.log(
        `    -> ${result.risk} ${result.score} (expected ${entry.expectedVerdict}` +
        (entry.expectedScore ? ` ${entry.expectedScore[0]}-${entry.expectedScore[1]}` : "") +
        `)`,
      )
      captured++
    } else {
      console.log(`    -> FAILED to capture ${entry.symbol} after retries`)
      failed++
    }

    await sleep(DELAY_MS)
  }

  console.log()
  console.log(`Done. captured=${captured} skipped=${skipped} failed=${failed}`)
  if (failed > 0) process.exit(1)
}

void main()
