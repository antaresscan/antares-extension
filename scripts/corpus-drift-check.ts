// scripts/corpus-drift-check.ts
//
// Nightly drift detection. Re-scans every captured fixture against
// the live engine and reports which tokens have drifted in verdict
// or score since the snapshot was taken.
//
// Why:
//   Captured fixtures are deterministic for CI but they freeze a
//   point-in-time view. Real on-chain state moves: a SAFE memecoin
//   gets rugged, a DANGER token matures into CAUTION. Without drift
//   detection the corpus silently goes stale and the accuracy report
//   stops reflecting reality.
//
// Behaviour:
//   - For each corpus entry with an existing fixture, fetch a fresh
//     scan and compare risk + score.
//   - Verdict change (e.g. SAFE → DANGER): flagged as critical.
//   - Score move > 150pts inside same verdict: flagged as warning.
//   - Outputs a markdown report so it can post directly to a GitHub
//     issue/PR comment from a nightly cron job.
//
// Usage:
//   npx tsx scripts/corpus-drift-check.ts                # full corpus
//   npx tsx scripts/corpus-drift-check.ts --limit=20     # quick smoke
//   npx tsx scripts/corpus-drift-check.ts --threshold=0.05  # CI gate
//                                                        # (exits 1 if
//                                                        #  drift % > 5%)

import { promises as fs } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CORPUS } from "../__tests__/backtest/corpus"
import type { Verdict } from "../api/_lib/types"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, "..", "__tests__", "backtest", "fixtures")
const SCAN_URL = "https://antares-extension.vercel.app/api/scan"
const ORIGIN = "https://antares-website.vercel.app"

const DELAY_MS = 2500
const SCORE_DRIFT_THRESHOLD = 150 // score points within same verdict

interface CapturedFixture {
  risk: Verdict
  score: number
}

interface DriftRow {
  symbol: string
  ca: string
  oldVerdict: Verdict | null
  oldScore: number | null
  newVerdict: Verdict | null
  newScore: number | null
  kind: "verdict-change" | "score-drift" | "unchanged" | "capture-failed" | "no-baseline"
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function captureLive(ca: string): Promise<CapturedFixture | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(3000 * attempt)
    try {
      const res = await fetch(`${SCAN_URL}?ca=${encodeURIComponent(ca)}&fresh=1`, {
        headers: { Origin: ORIGIN },
      })
      if (!res.ok) continue
      const json = await res.json() as { risk?: Verdict; score?: number }
      if (json.risk && typeof json.score === "number") {
        return { risk: json.risk, score: json.score }
      }
    } catch { /* retry */ }
  }
  return null
}

async function loadBaseline(symbol: string): Promise<CapturedFixture | null> {
  try {
    const path = join(FIXTURES_DIR, `${symbol.toLowerCase()}.json`)
    const raw = await fs.readFile(path, "utf-8")
    const data = JSON.parse(raw) as CapturedFixture
    return { risk: data.risk, score: data.score }
  } catch { return null }
}

function classifyDrift(
  baseline: CapturedFixture | null,
  live: CapturedFixture | null,
): DriftRow["kind"] {
  if (!live) return "capture-failed"
  if (!baseline) return "no-baseline"
  if (baseline.risk !== live.risk) return "verdict-change"
  if (Math.abs(baseline.score - live.score) > SCORE_DRIFT_THRESHOLD) return "score-drift"
  return "unchanged"
}

async function main() {
  const args = process.argv.slice(2)
  const limit = Number(args.find(a => a.startsWith("--limit="))?.split("=")[1] ?? CORPUS.length)
  const threshold = Number(args.find(a => a.startsWith("--threshold="))?.split("=")[1] ?? 0)

  const subset = CORPUS.filter(e => !e.skipFixture).slice(0, limit)
  console.log(`Drift check on ${subset.length} corpus entries…`)
  console.log()

  const rows: DriftRow[] = []
  for (const entry of subset) {
    const baseline = await loadBaseline(entry.symbol)
    if (!baseline) {
      rows.push({
        symbol: entry.symbol, ca: entry.ca,
        oldVerdict: null, oldScore: null,
        newVerdict: null, newScore: null,
        kind: "no-baseline",
      })
      continue
    }
    process.stdout.write(`  ${entry.symbol.padEnd(12)} `)
    const live = await captureLive(entry.ca)
    const kind = classifyDrift(baseline, live)
    rows.push({
      symbol: entry.symbol, ca: entry.ca,
      oldVerdict: baseline.risk, oldScore: baseline.score,
      newVerdict: live?.risk ?? null, newScore: live?.score ?? null,
      kind,
    })
    if (kind === "verdict-change") {
      console.log(`⚠ ${baseline.risk} ${baseline.score} → ${live!.risk} ${live!.score}`)
    } else if (kind === "score-drift") {
      console.log(`~ ${baseline.score} → ${live!.score} (${live!.score - baseline.score >= 0 ? "+" : ""}${live!.score - baseline.score})`)
    } else if (kind === "capture-failed") {
      console.log(`✗ capture failed`)
    } else {
      console.log(`✓ stable`)
    }
    await sleep(DELAY_MS)
  }

  // ── Summary
  const verdictChanges = rows.filter(r => r.kind === "verdict-change")
  const scoreDrifts = rows.filter(r => r.kind === "score-drift")
  const failures = rows.filter(r => r.kind === "capture-failed")
  const stable = rows.filter(r => r.kind === "unchanged")
  const noBaseline = rows.filter(r => r.kind === "no-baseline")

  const total = subset.length
  const driftedCount = verdictChanges.length + scoreDrifts.length
  const driftPct = total > 0 ? driftedCount / total : 0

  console.log()
  console.log("═".repeat(70))
  console.log("  ANTARES CORPUS DRIFT REPORT")
  console.log("═".repeat(70))
  console.log()
  console.log(`  Total checked      : ${total}`)
  console.log(`  Stable             : ${stable.length} (${((stable.length/total)*100).toFixed(1)}%)`)
  console.log(`  Verdict changes    : ${verdictChanges.length}  ← critical`)
  console.log(`  Score drifts >150  : ${scoreDrifts.length}     ← warning`)
  console.log(`  Capture failed     : ${failures.length}`)
  console.log(`  Missing baseline   : ${noBaseline.length}`)
  console.log()

  if (verdictChanges.length > 0) {
    console.log("  Verdict changes (snapshot → live):")
    for (const r of verdictChanges) {
      console.log(`    ${r.symbol.padEnd(12)} ${r.oldVerdict} ${r.oldScore} → ${r.newVerdict} ${r.newScore}`)
    }
    console.log()
  }
  if (scoreDrifts.length > 0) {
    console.log("  Score drifts >150pts (same verdict):")
    for (const r of scoreDrifts) {
      const delta = (r.newScore ?? 0) - (r.oldScore ?? 0)
      console.log(`    ${r.symbol.padEnd(12)} ${r.oldVerdict} ${r.oldScore} → ${r.newScore} (${delta > 0 ? "+" : ""}${delta})`)
    }
    console.log()
  }

  console.log("═".repeat(70))
  console.log()

  // CI gate
  if (threshold > 0 && driftPct > threshold) {
    console.error(`Drift ${(driftPct*100).toFixed(1)}% exceeds threshold ${(threshold*100).toFixed(1)}%`)
    process.exit(1)
  }
}

void main()
