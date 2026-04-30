// scripts/corpus-discover-birdeye.ts
//
// Fallback corpus discovery from Birdeye's public token list. Used when
// CoinGecko free tier rate-limits us out and we need additional unique
// Solana mints to push the corpus toward 500.
//
// Birdeye public API exposes /defi/tokenlist sorted by 24h volume in USD.
// Free tier allows ~100 req/min which is plenty for our use case.
//
// Each candidate gets enriched via DexScreener and labelled by the same
// conservative heuristic as corpus-discover.ts. Output written to
// /tmp/corpus-birdeye-extra.ts ready to merge with merge-corpus.ts.
//
// Usage:
//   npx tsx scripts/corpus-discover-birdeye.ts --limit=500
//   npx tsx scripts/corpus-discover-birdeye.ts --offset=200 --limit=300

import { promises as fs } from "node:fs"

const OUT_PATH = "/tmp/corpus-birdeye-extra.ts"

interface BirdeyeToken {
  address: string
  symbol: string
  name: string
  liquidity?: number
  v24hUSD?: number
  mc?: number
}

interface DsPair {
  chainId: string
  baseToken: { address: string; symbol: string; name: string }
  liquidity?: { usd: number }
  marketCap?: number
  fdv?: number
  pairCreatedAt?: number
  txns?: { h24?: { buys: number; sells: number } }
  priceChange?: { h24?: number }
}
interface DsTokenResp { pairs: DsPair[] }

interface Enriched {
  ca: string
  symbol: string
  tag: string
  mcapUsd: number | null
  liqUsd: number | null
  ageDays: number | null
  txnCount24h: number | null
  priceChange24h: number | null
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

async function jsonGet<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "antares-corpus-discover/1.0", ...headers } })
    if (!res.ok) {
      console.error(`  ${url} -> HTTP ${res.status}`)
      return null
    }
    return await res.json() as T
  } catch (e) {
    console.error(`  ${url} -> error`, e instanceof Error ? e.message : e)
    return null
  }
}

async function fetchBirdeye(offset: number, limit: number): Promise<{ ca: string; symbol: string; tag: string }[]> {
  // Birdeye /defi/tokenlist max page size is 50; paginate via offset.
  const results: { ca: string; symbol: string; tag: string }[] = []
  const pageSize = 50
  for (let off = offset; off < offset + limit; off += pageSize) {
    const url = `https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=${off}&limit=${pageSize}`
    console.log(`  Birdeye: offset=${off}…`)
    const data = await jsonGet<{ data?: { tokens?: BirdeyeToken[] } }>(url, { "x-chain": "solana" })
    const tokens = data?.data?.tokens
    if (!tokens || tokens.length === 0) break
    for (const t of tokens) {
      if (!t.address) continue
      results.push({ ca: t.address, symbol: (t.symbol || "UNKNOWN").toUpperCase(), tag: "discovered-birdeye-vol" })
    }
    await sleep(800)
  }
  return results
}

function pickBestPair(pairs: DsPair[]): DsPair | null {
  const sol = pairs.filter(p => p.chainId === "solana")
  if (sol.length === 0) return null
  return sol.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
}

async function enrich(ca: string, knownSymbol: string | null, tag: string): Promise<Enriched | null> {
  const data = await jsonGet<DsTokenResp>(`https://api.dexscreener.com/latest/dex/tokens/${ca}`)
  if (!data || !data.pairs || data.pairs.length === 0) return null
  const pair = pickBestPair(data.pairs)
  if (!pair) return null
  const symbol = knownSymbol ?? pair.baseToken.symbol ?? "UNKNOWN"
  const ageDays = pair.pairCreatedAt
    ? Math.floor((Date.now() - pair.pairCreatedAt) / 86_400_000)
    : null
  const txn24 = pair.txns?.h24
  const txnCount24h = txn24 ? txn24.buys + txn24.sells : null
  return {
    ca,
    symbol: symbol.toUpperCase(),
    tag,
    mcapUsd: pair.marketCap ?? pair.fdv ?? null,
    liqUsd: pair.liquidity?.usd ?? null,
    ageDays,
    txnCount24h,
    priceChange24h: pair.priceChange?.h24 ?? null,
  }
}

interface Label {
  expectedVerdict: string
  expectedScore: [number, number]
  tolerated?: string[]
  why: string
}

function label(e: Enriched): Label {
  const mcap = e.mcapUsd ?? 0
  const liq = e.liqUsd ?? 0
  const age = e.ageDays ?? 0
  const drop24h = e.priceChange24h ?? 0

  // Textbook rug: deep dump in 24h with thin liquidity
  if (drop24h <= -80 && liq < 10_000) {
    return {
      expectedVerdict: "RUG",
      expectedScore: [0, 400],
      tolerated: ["DANGER"],
      why: `24h drop ${drop24h.toFixed(0)}%, liq $${(liq/1000).toFixed(1)}k — textbook rug.`,
    }
  }
  // High-mcap, deep liq, multi-month → SAFE
  if (mcap >= 50_000_000 && liq >= 1_000_000 && age >= 90) {
    return {
      expectedVerdict: "SAFE",
      expectedScore: [700, 1000],
      tolerated: ["CAUTION"],
      why: `mcap $${(mcap/1_000_000).toFixed(0)}M, liq $${(liq/1_000_000).toFixed(1)}M, age ${age}d — established Solana memecoin.`,
    }
  }
  // Zero/near-zero liq + zero age → DANGER (untradable / fresh launch)
  if (liq < 5_000 && age <= 1) {
    return {
      expectedVerdict: "DANGER",
      expectedScore: [100, 600],
      tolerated: ["RUG", "CAUTION"],
      why: `liq $${(liq/1000).toFixed(1)}k, age ${age}d — high-risk fresh launch.`,
    }
  }
  // Default: CAUTION with wide tolerated band (engine has final say)
  return {
    expectedVerdict: "CAUTION",
    expectedScore: [300, 900],
    tolerated: ["SAFE", "DANGER", "RUG"],
    why: `mcap $${(mcap/1_000_000).toFixed(2)}M, age ${age}d, liq $${(liq/1000).toFixed(0)}k — mid-cap default (engine has final say).`,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const limit = Number(args.find(a => a.startsWith("--limit="))?.split("=")[1] ?? 500)
  const offset = Number(args.find(a => a.startsWith("--offset="))?.split("=")[1] ?? 0)

  console.log(`Birdeye corpus discovery — offset=${offset} limit=${limit}`)
  console.log("─".repeat(70))

  const candidates = await fetchBirdeye(offset, limit)
  console.log(`birdeye: ${candidates.length} candidates`)

  // Dedup by CA
  const byCa = new Map<string, { ca: string; symbol: string; tag: string }>()
  for (const c of candidates) byCa.set(c.ca, c)
  const unique = [...byCa.values()]
  console.log(`unique: ${unique.length} mints`)
  console.log()

  // Enrichment
  console.log("Enriching with DexScreener metadata…")
  const enriched: Enriched[] = []
  for (const c of unique) {
    const e = await enrich(c.ca, c.symbol, c.tag)
    if (e) {
      enriched.push(e)
      const lbl = label(e)
      console.log(
        `  ${e.symbol.padEnd(12)} ` +
        `mcap=$${((e.mcapUsd ?? 0)/1_000_000).toFixed(2).padStart(8)}M  ` +
        `liq=$${((e.liqUsd ?? 0)/1000).toFixed(0).padStart(6)}k  ` +
        `age=${(e.ageDays ?? 0).toString().padStart(4)}d  ` +
        `→ ${lbl.expectedVerdict}`,
      )
    } else {
      console.log(`  ${c.ca.slice(0, 10)}… skipped (no Solana pair)`)
    }
    await sleep(180)
  }

  // De-dupe symbols by appending mint suffix to collisions
  const seenSymbols = new Map<string, number>()
  for (const e of enriched) {
    const count = seenSymbols.get(e.symbol) ?? 0
    if (count > 0) e.symbol = `${e.symbol}_${e.ca.slice(0, 4).toUpperCase()}`
    seenSymbols.set(e.symbol.split("_")[0], count + 1)
  }

  const lines: string[] = []
  lines.push("// AUTO-GENERATED by scripts/corpus-discover-birdeye.ts")
  lines.push("// Birdeye-sourced Solana memecoins, sorted by 24h USD volume.")
  lines.push("// Conservative auto-labels (engine has final say).")
  lines.push("")
  lines.push("import type { CorpusEntry } from \"./corpus\"")
  lines.push("")
  lines.push("export const DISCOVERED: CorpusEntry[] = [")
  for (const e of enriched) {
    const lbl = label(e)
    const tolerated = lbl.tolerated
      ? `\n    tolerated: [${lbl.tolerated.map(v => `"${v}"`).join(", ")}],`
      : ""
    lines.push(`  {`)
    lines.push(`    ca: "${e.ca}",`)
    lines.push(`    symbol: "${e.symbol}",`)
    lines.push(`    expectedVerdict: "${lbl.expectedVerdict}",${tolerated}`)
    lines.push(`    expectedScore: [${lbl.expectedScore[0]}, ${lbl.expectedScore[1]}],`)
    lines.push(`    why: ${JSON.stringify(lbl.why)},`)
    lines.push(`    source: "external",`)
    lines.push(`    skipFixture: true, // pending first capture`)
    lines.push(`  } as CorpusEntry,`)
  }
  lines.push("]")
  lines.push("")

  await fs.writeFile(OUT_PATH, lines.join("\n"))
  console.log()
  console.log("─".repeat(70))
  console.log(`Enriched: ${enriched.length} / ${unique.length}`)
  console.log(`Output:   ${OUT_PATH}`)
}

void main()
