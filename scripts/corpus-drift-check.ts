// scripts/corpus-drift-check.ts
//
// Drift detection. Re-scans captured fixtures against the live engine
// and reports which tokens have drifted in verdict or score since the
// snapshot was taken.
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
//   - Drift is measured over the entries that were actually compared;
//     failed captures are reported, not counted as stable.
//   - --sample=N re-scans a window of N entries that moves with
//     --rotation (default: ISO week), so a weekly run covers the whole
//     corpus over several weeks. Every scan is a fresh, full pipeline run
//     on production (Helius, RugCheck, GoPlus, Solscan, the AI summary),
//     which is why a full-corpus run is not something to do daily.
//
// Exit codes (the workflow tells them apart):
//   0  within threshold
//   1  drift above --threshold: findings to triage
//   2  the check itself is unreliable (too many failed captures, nothing
//      to compare, unexpected crash): not a drift result
//
// Usage:
//   npx tsx scripts/corpus-drift-check.ts                   # full corpus
//   npx tsx scripts/corpus-drift-check.ts --limit=20        # quick smoke
//   npx tsx scripts/corpus-drift-check.ts --sample=100      # weekly window
//   npx tsx scripts/corpus-drift-check.ts --threshold=0.05  # CI gate

import { promises as fs } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CORPUS, type CorpusEntry } from "../__tests__/backtest/corpus"
import type { Verdict } from "../api/_lib/types"
import { EXIT_DRIFT, EXIT_UNRELIABLE, evaluateDrift, isoWeek, pickSample } from "./corpus-drift-lib"

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
  kind: "verdict-change" | "score-drift" | "unchanged" | "capture-failed"
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
  baseline: CapturedFixture,
  live: CapturedFixture | null,
): DriftRow["kind"] {
  if (!live) return "capture-failed"
  if (baseline.risk !== live.risk) return "verdict-change"
  if (Math.abs(baseline.score - live.score) > SCORE_DRIFT_THRESHOLD) return "score-drift"
  return "unchanged"
}

function numberArg(args: string[], name: string): number | null {
  const raw = args.find(a => a.startsWith(`--${name}=`))?.split("=")[1]
  if (raw === undefined) return null
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    console.error(`--${name} must be a number, got "${raw}"`)
    process.exit(EXIT_UNRELIABLE)
  }
  return value
}

async function main() {
  const args = process.argv.slice(2)
  const limit = numberArg(args, "limit")
  const threshold = numberArg(args, "threshold") ?? 0
  const sample = numberArg(args, "sample")
  const rotation = numberArg(args, "rotation") ?? isoWeek(new Date())

  // Only entries with a fixture can be compared, and only those cost a scan:
  // sample among them so --sample=N means N live scans.
  const eligible = CORPUS.filter(e => !e.skipFixture)
  const withBaseline: Array<{ entry: CorpusEntry; baseline: CapturedFixture }> = []
  let noBaseline = 0
  for (const entry of eligible) {
    const baseline = await loadBaseline(entry.symbol)
    if (baseline) withBaseline.push({ entry, baseline })
    else noBaseline++
  }
  let subset = pickSample(withBaseline, sample, rotation)
  if (limit !== null) subset = subset.slice(0, limit)

  console.log(`Drift check on ${subset.length} of ${withBaseline.length} corpus entries with a fixture` +
    (sample !== null && sample < withBaseline.length ? ` (window ${rotation}, ${sample} per run)` : "") + "…")
  console.log()

  const rows: DriftRow[] = []
  for (const { entry, baseline } of subset) {
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

  const outcome = evaluateDrift({
    stable: stable.length,
    verdictChanges: verdictChanges.length,
    scoreDrifts: scoreDrifts.length,
    failures: failures.length,
    noBaseline,
  }, threshold)

  console.log()
  console.log("═".repeat(70))
  console.log("  ANTARES CORPUS DRIFT REPORT")
  console.log("═".repeat(70))
  console.log()
  console.log(`  Re-scanned         : ${rows.length}`)
  console.log(`  Compared           : ${outcome.comparable}`)
  console.log(`  Stable             : ${stable.length}`)
  console.log(`  Verdict changes    : ${verdictChanges.length}  ← critical`)
  console.log(`  Score drifts >150  : ${scoreDrifts.length}     ← warning`)
  console.log(`  Capture failed     : ${failures.length}`)
  console.log(`  Missing baseline   : ${noBaseline} (not re-scanned)`)
  console.log(`  Drift              : ${(outcome.driftPct * 100).toFixed(1)}% of the compared entries`)
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
  if (failures.length > 0) {
    console.log("  Failed captures (not counted as stable):")
    for (const r of failures.slice(0, 20)) console.log(`    ${r.symbol.padEnd(12)} ${r.ca}`)
    if (failures.length > 20) console.log(`    … and ${failures.length - 20} more`)
    console.log()
  }

  console.log("═".repeat(70))
  console.log()

  // CI gate
  if (outcome.unreliableReason !== null) {
    console.error(`Drift check unreliable: ${outcome.unreliableReason}. This is not a drift result.`)
    process.exit(outcome.exitCode)
  }
  if (outcome.exitCode === EXIT_DRIFT) {
    console.error(`Drift ${(outcome.driftPct * 100).toFixed(1)}% exceeds threshold ${(threshold * 100).toFixed(1)}%`)
    process.exit(outcome.exitCode)
  }
}

main().catch((err: unknown) => {
  // A crash is a broken check, never a drift finding.
  console.error(err)
  process.exit(EXIT_UNRELIABLE)
})
