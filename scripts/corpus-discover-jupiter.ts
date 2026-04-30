// scripts/corpus-discover-jupiter.ts
//
// Corpus discovery from Jupiter's verified token list (lite-api.jup.ag).
// Used as a complement to DexScreener + GeckoTerminal when CoinGecko's
// free tier rate-limits us.
//
// Jupiter exposes ~4,800 verified Solana tokens with mcap, liquidity,
// holder count and USD price embedded in the response. No per-token
// enrichment call needed — we can label directly from the Jupiter data.
//
// Usage:
//   npx tsx scripts/corpus-discover-jupiter.ts --limit=300 --min-mcap=100000

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const OUT_PATH = join(homedir(), "AppData", "Local", "Temp", "corpus-jup-extra.ts")
const JUP_URL = "https://lite-api.jup.ag/tokens/v2/tag?query=verified"

// Tokens we never want in the corpus: stablecoins, top-cap majors that
// aren't memecoins, wrapped versions of larger assets, governance tokens.
const EXCLUDE_SYMBOLS = new Set([
  "SOL", "WSOL", "USDC", "USDT", "USDS", "USDH", "PYUSD", "FDUSD",
  "BTC", "WBTC", "ETH", "WETH", "LTC", "BNB", "AVAX", "MATIC", "DOT",
  "RAY", "ORCA", "JTO", "JUP", "JLP", "MNGO", "MSOL", "BSOL", "JITOSOL",
  "STSOL", "WSOL", "INF", "RAY", "FIDA", "STEP", "ATLAS", "POLIS",
])

interface JupToken {
  id: string
  name: string
  symbol: string
  decimals?: number
  circSupply?: number
  totalSupply?: number
  fdv?: number
  mcap?: number
  usdPrice?: number
  liquidity?: number
  holderCount?: number
  stats5m?: { priceChange?: number }
  stats24h?: { priceChange?: number }
}

interface CorpusEntry {
  ca: string
  symbol: string
  expectedVerdict: string
  expectedScore: [number, number]
  tolerated?: string[]
  why: string
  source: string
  skipFixture?: boolean
}

interface Label {
  expectedVerdict: string
  expectedScore: [number, number]
  tolerated?: string[]
  why: string
}

function label(t: JupToken): Label {
  const mcap = t.mcap ?? t.fdv ?? 0
  const liq = t.liquidity ?? 0
  const holders = t.holderCount ?? 0
  const drop24h = t.stats24h?.priceChange ?? 0

  // Textbook rug: deep dump in 24h with thin liquidity
  if (drop24h <= -80 && liq < 10_000) {
    return {
      expectedVerdict: "RUG",
      expectedScore: [0, 400],
      tolerated: ["DANGER"],
      why: `24h drop ${drop24h.toFixed(0)}%, liq $${(liq/1000).toFixed(1)}k — textbook rug.`,
    }
  }
  // Big-mcap + deep liq + many holders → SAFE-leaning (auto-label heuristic;
  // engine has final say since the labeler can't distinguish memecoins
  // from tokenized stocks / LSDs / stablecoins which all pass the threshold
  // but score very differently in the engine).
  if (mcap >= 30_000_000 && liq >= 500_000 && holders >= 5_000) {
    return {
      expectedVerdict: "SAFE",
      expectedScore: [700, 1000],
      tolerated: ["CAUTION", "DANGER", "RUG"],
      why: `mcap $${(mcap/1_000_000).toFixed(0)}M, liq $${(liq/1_000_000).toFixed(1)}M, ${holders.toLocaleString()} holders — Jupiter-verified mid/large-cap (engine has final say).`,
    }
  }
  // Mid-cap with thin liq → DANGER
  if (mcap < 2_000_000 && liq < 30_000) {
    return {
      expectedVerdict: "DANGER",
      expectedScore: [100, 600],
      tolerated: ["RUG", "CAUTION"],
      why: `mcap $${(mcap/1_000).toFixed(0)}k, liq $${(liq/1_000).toFixed(1)}k — high-risk thin liquidity.`,
    }
  }
  // Default CAUTION (engine has final say)
  return {
    expectedVerdict: "CAUTION",
    expectedScore: [300, 900],
    tolerated: ["SAFE", "DANGER", "RUG"],
    why: `mcap $${(mcap/1_000_000).toFixed(2)}M, liq $${(liq/1000).toFixed(0)}k — Jupiter-verified mid-cap (engine has final say).`,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const limit = Number(args.find(a => a.startsWith("--limit="))?.split("=")[1] ?? 300)
  const minMcap = Number(args.find(a => a.startsWith("--min-mcap="))?.split("=")[1] ?? 50_000)

  console.log(`Jupiter corpus discovery — limit=${limit}, min-mcap=$${(minMcap/1000).toFixed(0)}k`)
  console.log("─".repeat(70))

  console.log(`Fetching ${JUP_URL}…`)
  const res = await fetch(JUP_URL, { headers: { "User-Agent": "antares-corpus-discover/1.0" } })
  if (!res.ok) {
    console.error(`HTTP ${res.status}`)
    process.exit(1)
  }
  const tokens = await res.json() as JupToken[]
  console.log(`Got ${tokens.length} verified tokens.`)

  // Filter: skip excluded symbols, require mcap >= threshold
  const filtered = tokens.filter(t =>
    t.id &&
    t.symbol &&
    !EXCLUDE_SYMBOLS.has(t.symbol.toUpperCase()) &&
    (t.mcap ?? t.fdv ?? 0) >= minMcap,
  )
  console.log(`After filter (mcap >= $${(minMcap/1000).toFixed(0)}k, no majors): ${filtered.length}`)

  // Sort by mcap desc, take limit
  filtered.sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0))
  const picked = filtered.slice(0, limit)
  console.log(`Picked top ${picked.length} by mcap.`)
  console.log()

  // Dedup symbols (Jupiter sometimes has multiple tokens with same symbol)
  const seenSymbols = new Map<string, number>()
  const entries: CorpusEntry[] = []
  for (const t of picked) {
    let symbol = t.symbol.toUpperCase()
    const base = symbol.split("_")[0]
    const count = seenSymbols.get(base) ?? 0
    if (count > 0) symbol = `${base}_${t.id.slice(0, 4).toUpperCase()}`
    seenSymbols.set(base, count + 1)

    const lbl = label(t)
    entries.push({
      ca: t.id,
      symbol,
      expectedVerdict: lbl.expectedVerdict,
      expectedScore: lbl.expectedScore,
      tolerated: lbl.tolerated,
      why: lbl.why,
      source: "external",
      skipFixture: true,
    })

    console.log(
      `  ${symbol.padEnd(14)} ` +
      `mcap=$${((t.mcap ?? 0)/1_000_000).toFixed(2).padStart(8)}M  ` +
      `liq=$${((t.liquidity ?? 0)/1000).toFixed(0).padStart(7)}k  ` +
      `holders=${(t.holderCount ?? 0).toString().padStart(7)}  ` +
      `→ ${lbl.expectedVerdict}`,
    )
  }

  // Render
  const lines: string[] = []
  lines.push("// AUTO-GENERATED by scripts/corpus-discover-jupiter.ts")
  lines.push("// Jupiter-verified Solana tokens, sorted by market cap.")
  lines.push("// Conservative auto-labels based on mcap/liq/holders/drop-24h.")
  lines.push("")
  lines.push("import type { CorpusEntry } from \"./corpus\"")
  lines.push("")
  lines.push("export const DISCOVERED: CorpusEntry[] = [")
  for (const e of entries) {
    const tolerated = e.tolerated && e.tolerated.length > 0
      ? `\n    tolerated: [${e.tolerated.map(v => `"${v}"`).join(", ")}],`
      : ""
    lines.push(`  {`)
    lines.push(`    ca: "${e.ca}",`)
    lines.push(`    symbol: "${e.symbol}",`)
    lines.push(`    expectedVerdict: "${e.expectedVerdict}",${tolerated}`)
    lines.push(`    expectedScore: [${e.expectedScore[0]}, ${e.expectedScore[1]}],`)
    lines.push(`    why: ${JSON.stringify(e.why)},`)
    lines.push(`    source: "${e.source}",`)
    lines.push(`    skipFixture: true, // pending first capture`)
    lines.push(`  },`)
  }
  lines.push("]")
  lines.push("")

  await fs.writeFile(OUT_PATH, lines.join("\n"))
  console.log()
  console.log("─".repeat(70))
  console.log(`Generated: ${entries.length} entries`)
  console.log(`Output:    ${OUT_PATH}`)
}

void main()
