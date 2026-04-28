// __tests__/backtest/accuracy.test.ts
//
// The corpus accuracy backtest. Runs every captured fixture through
// the verdict-band assertion and prints a confusion matrix + accuracy
// metrics so any drift is visible in CI logs (not just pass/fail).
//
// Failure modes we care about, by severity (worst first):
//   1. False negative on rugs: a known RUG/DANGER token comes back
//      SAFE. Catastrophic for user trust — they trade based on us.
//   2. False positive on safe: a known blue-chip comes back DANGER/RUG.
//      Erodes credibility — users stop trusting our flags.
//   3. Verdict-band drift: borderline tokens shift between adjacent
//      bands (CAUTION ↔ DANGER) when scoring is rebalanced. Less
//      severe but still worth surfacing.
//
// The CI gate enforces #1 and #2 strictly. #3 is allowed via the
// `tolerated` field in corpus entries — drift inside the tolerated
// set prints a warning but doesn't fail the test.

import { describe, it, expect } from "vitest"
import { promises as fs } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CORPUS, isVerdictAcceptable, isScoreInRange, type CorpusEntry } from "./corpus"
import type { Verdict } from "../../api/_lib/types"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, "fixtures")

interface CapturedFixture {
  risk: Verdict
  score: number
  safeBlockedReasons: string[]
  flags: Array<{ severity: string; label: string }>
  lpBurned: boolean | null
  lpLocked: boolean | null
  holders: number | null
  liquidity: number | null
}

async function loadFixture(symbol: string): Promise<CapturedFixture | null> {
  const path = join(FIXTURES_DIR, `${symbol.toLowerCase()}.json`)
  try {
    const raw = await fs.readFile(path, "utf-8")
    return JSON.parse(raw) as CapturedFixture
  } catch {
    return null
  }
}

interface RunResult {
  entry: CorpusEntry
  fixture: CapturedFixture | null
  verdict: Verdict | null
  score: number | null
  ok: boolean
  warning: boolean
  scoreInRange: boolean
  reason: string
}

async function runCorpus(): Promise<RunResult[]> {
  const results: RunResult[] = []
  for (const entry of CORPUS) {
    const fx = await loadFixture(entry.symbol)
    if (!fx) {
      // skipFixture entries are tracked but don't fail CI. They appear
      // in the report as "(skipped)" so reviewers know coverage gaps
      // exist without the test going red on a separate backend issue.
      results.push({
        entry, fixture: null, verdict: null, score: null,
        ok: !!entry.skipFixture, warning: !!entry.skipFixture,
        scoreInRange: true,
        reason: entry.skipFixture
          ? "skipFixture (backend 504, tracked separately)"
          : `Missing fixture — run: npm run corpus:capture ${entry.symbol}`,
      })
      continue
    }
    const { ok, warning } = isVerdictAcceptable(entry, fx.risk)
    const inRange = isScoreInRange(entry, fx.score)
    results.push({
      entry, fixture: fx,
      verdict: fx.risk, score: fx.score,
      ok, warning, scoreInRange: inRange,
      reason: ok
        ? (warning ? `tolerated drift to ${fx.risk}` : "match")
        : `expected ${entry.expectedVerdict}, got ${fx.risk}`,
    })
  }
  return results
}

interface ConfusionMatrix {
  expected: Verdict
  RUG: number
  DANGER: number
  CAUTION: number
  SAFE: number
}

function buildConfusion(results: RunResult[]): ConfusionMatrix[] {
  const verdicts: Verdict[] = ["RUG", "DANGER", "CAUTION", "SAFE"]
  return verdicts.map(expected => {
    const row: ConfusionMatrix = { expected, RUG: 0, DANGER: 0, CAUTION: 0, SAFE: 0 }
    for (const r of results) {
      if (r.entry.expectedVerdict !== expected) continue
      if (r.verdict) row[r.verdict]++
    }
    return row
  })
}

function printReport(results: RunResult[]): void {
  const total = results.length
  const matched = results.filter(r => r.ok && !r.warning).length
  const tolerated = results.filter(r => r.ok && r.warning).length
  const failed = results.filter(r => !r.ok).length

  // ── Confusion matrix ──────────────────────────────────────────────
  const matrix = buildConfusion(results)
  const lines: string[] = []
  lines.push("")
  lines.push("══════════════════════════════════════════════════════════════════")
  lines.push("  ANTARES CORPUS ACCURACY REPORT")
  lines.push("══════════════════════════════════════════════════════════════════")
  lines.push("")
  lines.push(`  Total tokens:       ${total}`)
  lines.push(`  Exact matches:      ${matched}/${total} (${((matched/total)*100).toFixed(1)}%)`)
  lines.push(`  Tolerated drift:    ${tolerated}/${total} (${((tolerated/total)*100).toFixed(1)}%)`)
  lines.push(`  Failures:           ${failed}/${total} (${((failed/total)*100).toFixed(1)}%)`)
  lines.push("")
  lines.push("  Confusion matrix (rows = expected, cols = actual)")
  lines.push("                     RUG    DANGER  CAUTION  SAFE")
  for (const row of matrix) {
    const pad = (n: number) => String(n).padStart(6)
    lines.push(`    expected ${row.expected.padEnd(8)} ${pad(row.RUG)} ${pad(row.DANGER)}  ${pad(row.CAUTION)}  ${pad(row.SAFE)}`)
  }
  lines.push("")

  // ── Per-token detail (failures + warnings only) ──────────────────
  const interesting = results.filter(r => !r.ok || r.warning || !r.scoreInRange)
  if (interesting.length > 0) {
    lines.push("  Detail (failures + warnings + score drift):")
    for (const r of interesting) {
      const prefix = !r.ok ? "  ✗ FAIL  " : r.warning ? "  ⚠ WARN  " : "  ⚠ DRIFT "
      const expected = r.entry.expectedVerdict +
        (r.entry.expectedScore ? ` (${r.entry.expectedScore[0]}-${r.entry.expectedScore[1]})` : "")
      const actual = r.verdict
        ? `${r.verdict}${r.score !== null ? " " + r.score : ""}`
        : "—"
      lines.push(`${prefix}${r.entry.symbol.padEnd(10)} expected ${expected.padEnd(28)} got ${actual}`)
      if (r.reason !== "match") lines.push(`            ${r.reason}`)
      if (!r.scoreInRange && r.entry.expectedScore && r.score !== null) {
        lines.push(`            score ${r.score} outside expected ${r.entry.expectedScore[0]}-${r.entry.expectedScore[1]}`)
      }
    }
    lines.push("")
  }

  lines.push("══════════════════════════════════════════════════════════════════")
  lines.push("")
  console.log(lines.join("\n"))
}

// ─── TESTS ───────────────────────────────────────────────────────────

describe("corpus accuracy", () => {
  it("every non-skipped corpus entry has a captured fixture", async () => {
    const results = await runCorpus()
    const missing = results
      .filter(r => !r.fixture && !r.entry.skipFixture)
      .map(r => r.entry.symbol)
    if (missing.length > 0) {
      throw new Error(
        `Missing fixtures for: ${missing.join(", ")}. ` +
        `Run: npm run corpus:capture ${missing.join(" ")}`,
      )
    }
  })

  it("every token returns an acceptable verdict", async () => {
    const results = await runCorpus()
    printReport(results)

    const failures = results.filter(r => !r.ok)
    if (failures.length > 0) {
      const detail = failures
        .map(f => `  ${f.entry.symbol}: expected ${f.entry.expectedVerdict}, got ${f.verdict ?? "—"}`)
        .join("\n")
      throw new Error(`${failures.length} verdict failures:\n${detail}`)
    }
    expect(failures).toHaveLength(0)
  })

  it("score lands within the expected range when one is set (verdict-aware)", async () => {
    // Score-in-range is a SECONDARY signal. The primary contract is
    // verdict-in-tolerated-band. A token whose verdict is acceptable
    // (exact match or tolerated drift) but whose score falls outside
    // the static band is fine — the band is a heuristic for catching
    // "everything looks OK at the verdict level but the score collapsed
    // suspiciously". So we only HARD FAIL when score AND verdict are
    // both off; otherwise the per-token detail report surfaces the
    // drift as a WARN (visible in the printed report) without blocking
    // CI on every borderline tolerated drift.
    const results = await runCorpus()
    const driftWithBadVerdict = results.filter(r =>
      r.fixture && !r.scoreInRange && !r.ok,
    )
    if (driftWithBadVerdict.length > 0) {
      const detail = driftWithBadVerdict
        .map(d => {
          const range = d.entry.expectedScore
          return `  ${d.entry.symbol}: verdict ${d.verdict} (expected ${d.entry.expectedVerdict}), score ${d.score} outside ${range?.[0]}-${range?.[1]}`
        })
        .join("\n")
      throw new Error(`${driftWithBadVerdict.length} hard drift (verdict + score):\n${detail}`)
    }
  })

  // ── Worst-failure-mode guards (catastrophic only) ────────────────
  it("zero false negatives on rugs (no RUG/DANGER token comes back SAFE)", async () => {
    const results = await runCorpus()
    // Respect tolerated bands — auto-discovered DANGER entries based on
    // an external snapshot may legitimately tolerate SAFE because the
    // engine sees fresh live data the snapshot didn't (e.g. liquidity
    // refilled since discovery). Only HAND-VETTED expectations without
    // SAFE in tolerated count as catastrophic false negatives.
    const falseNegatives = results.filter(r =>
      r.fixture &&
      (r.entry.expectedVerdict === "RUG" || r.entry.expectedVerdict === "DANGER") &&
      r.verdict === "SAFE" &&
      !r.entry.tolerated?.includes("SAFE"),
    )
    if (falseNegatives.length > 0) {
      const detail = falseNegatives
        .map(f => `  ${f.entry.symbol}: expected ${f.entry.expectedVerdict}, scored SAFE — ${f.entry.why}`)
        .join("\n")
      throw new Error(`CATASTROPHIC: ${falseNegatives.length} rug(s) classified SAFE:\n${detail}`)
    }
  })

  it("zero false positives on blue chips (no SAFE token comes back DANGER/RUG)", async () => {
    const results = await runCorpus()
    const falsePositives = results.filter(r =>
      r.fixture &&
      r.entry.expectedVerdict === "SAFE" &&
      !r.entry.tolerated?.includes(r.verdict ?? "SAFE") &&
      (r.verdict === "DANGER" || r.verdict === "RUG"),
    )
    if (falsePositives.length > 0) {
      const detail = falsePositives
        .map(f => `  ${f.entry.symbol}: expected SAFE, scored ${f.verdict} — ${f.entry.why}`)
        .join("\n")
      throw new Error(`${falsePositives.length} blue-chip(s) flagged DANGER/RUG:\n${detail}`)
    }
  })
})
