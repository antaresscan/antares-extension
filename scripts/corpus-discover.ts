// scripts/corpus-discover.ts
//
// Discovers candidate Solana memecoins from DexScreener and emits a
// TS block ready to paste into __tests__/backtest/corpus.ts.
//
// Three sources are merged + de-duped:
//   1. A hand-curated SEED list of well-known memecoins (BONK, WIF, …)
//      that we want pinned in the corpus regardless of API state.
//   2. DexScreener "boosted" tokens — paid promotion list, heavily
//      shitcoin-skewed, useful for surfacing DANGER/RUG candidates.
//   3. DexScreener "latest profiles" — recently-listed tokens with a
//      profile, useful for fresh-launch DANGER candidates.
//
// For each mint we hit `/latest/dex/tokens/<mint>` to enrich with
// mcap, liquidity, age, txns. Then we run a deterministic labeller
// to propose an expectedVerdict from purely external metrics — never
// from the engine's own verdict, otherwise the test is circular.
//
// Output:
//   - prints a CorpusEntry[] block to stdout
//   - writes scripts/corpus-discover.out.ts as a backup
//
// Usage:
//   npx tsx scripts/corpus-discover.ts                  # default 200 candidates
//   npx tsx scripts/corpus-discover.ts --limit=100      # cap to N
//   npx tsx scripts/corpus-discover.ts --no-boosted     # skip boosted source
//   npx tsx scripts/corpus-discover.ts --no-profiles    # skip profiles source

import { promises as fs } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(__dirname, "..", "__tests__", "backtest", "corpus-discovered.ts")

// ─── SEED LIST ───────────────────────────────────────────────────────
// Hand-curated list of well-known Solana memecoins, spanning the four
// verdict bands. We pin these regardless of what the discovery sources
// return — they're the spine of the corpus.
//
// Categories (informational, the labeller decides the actual verdict):
//   blue-chip       — top mcap, multi-month history, low risk
//   mid-cap         — established but with one or more soft risks
//   borderline      — mid-cap with concentration / age edge cases
//   post-rug-stable — was rugged, settled into a thin steady-state
//   confirmed-rug   — rug pattern confirmed
//   stable-anchor   — non-memecoin sanity check (USDC etc)
const SEED: { ca: string; symbol: string; tag: string }[] = [
  // Blue-chip memecoins
  { ca: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", tag: "blue-chip" },
  { ca: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", symbol: "WIF", tag: "blue-chip" },
  { ca: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv", symbol: "PENGU", tag: "blue-chip" },
  { ca: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", symbol: "POPCAT", tag: "blue-chip" },
  { ca: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5", symbol: "MEW", tag: "blue-chip" },
  { ca: "7tGwuFAyV3xQjYGdGDwXzxegx419WgE4WwtEbJq9x1Es", symbol: "GOAT", tag: "blue-chip" },
  { ca: "Dn3DFUNDKEyMJGrEsuzTiYrfEwtPo86iH5qTKzbbtiag", symbol: "PNUT", tag: "blue-chip" },
  { ca: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", symbol: "FARTCOIN", tag: "blue-chip" },
  { ca: "A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump", symbol: "FWOG", tag: "blue-chip" },
  { ca: "HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4", symbol: "USELESS", tag: "blue-chip" },

  // Mid-cap / borderline
  { ca: "Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump", symbol: "NEET", tag: "mid-cap" },
  { ca: "5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2", symbol: "TROLL", tag: "mid-cap" },
  { ca: "GJAFwWjJ3vnTsrQVabjBVK2TYB1YtRCQXRDfDgUnpump", symbol: "ACT", tag: "borderline" },
  { ca: "63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9", symbol: "GIGA", tag: "borderline" },

  // Established memecoins to expand the SAFE/CAUTION coverage
  { ca: "ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY", symbol: "MOODENG", tag: "blue-chip" },
  { ca: "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump", symbol: "GOAT2", tag: "mid-cap" }, // alt-GOAT
  { ca: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82", symbol: "BOME", tag: "blue-chip" },
  { ca: "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4", symbol: "JLP", tag: "stable-anchor" },
  { ca: "6ogzHhzdrQr9Pgv6hZ2MNze7UrzBMAFyBBWUYp1Fhitx", symbol: "RAY", tag: "stable-anchor" },
  { ca: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof", symbol: "RENDER", tag: "stable-anchor" },
  { ca: "AFbX8oGjGpmVFywbVouvhQSRmiW2aR1mohfahi4Y2AdB", symbol: "GST", tag: "mid-cap" },
  { ca: "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump", symbol: "MELANIA", tag: "post-rug-stable" },
  { ca: "GoLDYyyiVeXnVf9qgoK712N5esm1cCbHEK9aNJFx41nz", symbol: "GOLDY", tag: "mid-cap" },
  { ca: "xxxUWoBWAVMP49M7xT37ywCK3aQuhTmHXHXfA21pump", symbol: "RIZZ", tag: "mid-cap" },
  { ca: "AjBT19DxbDqDcLFUbm3J3SQYDMCPhjqWHHr3D3GPpump", symbol: "MOTHER", tag: "borderline" },
  { ca: "9psiRdn9cXYVps4F1kFuoNjd1EAAGxF8JGEhbYJpump", symbol: "MOG", tag: "mid-cap" },
  { ca: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", symbol: "PYTH", tag: "stable-anchor" },

  // Confirmed rugs / DANGER profiles
  { ca: "Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump", symbol: "PIPPIN", tag: "borderline" },
  { ca: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", symbol: "TRUMP", tag: "post-rug-stable" },
  { ca: "4GFe6MBDorSy5bLbiUMrgETr6pZcjyfxMDm5ehSgpump", symbol: "HAWK", tag: "confirmed-rug" },
  { ca: "69HZnSz3XDHyTeBrrsn5NFbjpiryhHbYJZUGDx3QXH69", symbol: "HORNY", tag: "confirmed-rug" },

  // Anchor (non-memecoin, sanity check)
  { ca: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", tag: "stable-anchor" },
]

// ─── DEXSCREENER TYPES (subset we use) ──────────────────────────────
interface DsPair {
  chainId: string
  dexId: string
  baseToken: { address: string; name: string; symbol: string }
  quoteToken: { address: string; symbol: string }
  priceUsd?: string
  liquidity?: { usd?: number }
  marketCap?: number
  fdv?: number
  pairCreatedAt?: number
  txns?: Record<string, { buys: number; sells: number }>
  volume?: Record<string, number>
  priceChange?: Record<string, number>
}

interface DsTokenResp { pairs: DsPair[] | null }

interface DsBoosted {
  chainId: string
  tokenAddress: string
  description?: string
}

interface DsProfile {
  chainId: string
  tokenAddress: string
}

// ─── ENRICHED TOKEN ──────────────────────────────────────────────────
interface Enriched {
  ca: string
  symbol: string
  name: string
  tag: string // seed tag or "discovered"
  mcapUsd: number | null
  liqUsd: number | null
  ageDays: number | null
  txnCount24h: number | null
  priceChange24h: number | null
}

// ─── HTTP HELPERS ────────────────────────────────────────────────────
async function jsonGet<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "antares-corpus-discover/1.0" },
    })
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

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── DISCOVERY SOURCES ───────────────────────────────────────────────
async function fetchBoosted(): Promise<{ ca: string; tag: string }[]> {
  const data = await jsonGet<DsBoosted[]>("https://api.dexscreener.com/token-boosts/top/v1")
  if (!data) return []
  return data
    .filter(d => d.chainId === "solana")
    .map(d => ({ ca: d.tokenAddress, tag: "discovered-boosted" }))
}

async function fetchLatestProfiles(): Promise<{ ca: string; tag: string }[]> {
  const data = await jsonGet<DsProfile[]>("https://api.dexscreener.com/token-profiles/latest/v1")
  if (!data) return []
  return data
    .filter(d => d.chainId === "solana")
    .map(d => ({ ca: d.tokenAddress, tag: "discovered-profile" }))
}

// ─── ENRICHMENT (one mint at a time, picks the best Solana pair) ────
function pickBestPair(pairs: DsPair[]): DsPair | null {
  const solPairs = pairs.filter(p => p.chainId === "solana")
  if (solPairs.length === 0) return null
  // Pick the one with biggest liquidity in USD
  return solPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
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
    symbol: symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12),
    name: pair.baseToken.name,
    tag,
    mcapUsd: pair.marketCap ?? pair.fdv ?? null,
    liqUsd: pair.liquidity?.usd ?? null,
    ageDays,
    txnCount24h,
    priceChange24h: pair.priceChange?.h24 ?? null,
  }
}

// ─── DETERMINISTIC LABELLER ──────────────────────────────────────────
type Verdict = "SAFE" | "CAUTION" | "DANGER" | "RUG"

interface Label {
  expectedVerdict: Verdict
  expectedScore: [number, number]
  tolerated?: Verdict[]
  why: string
}

// Rules are intentionally CONSERVATIVE: external data alone can't see
// concentration / honeypot / LP burn, so we bias toward CAUTION with
// wide tolerated bands and only commit to SAFE/RUG when the external
// signal is overwhelming.
//
// External signals available (DexScreener):
//   mcap, liq (USD), age (days), priceChange24h (%)
//
// Signals we DO NOT have (engine must see):
//   top wallet %, LP burned/locked, honeypot, GoPlus risks, recent
//   transfer pattern, holder count.
//
// Therefore: an external "looks SAFE" verdict can be overridden by
// the engine to CAUTION, but never to DANGER (would be a real bug).
function label(t: Enriched): Label {
  const mcap = t.mcapUsd ?? 0
  const liq = t.liqUsd ?? 0
  const age = t.ageDays ?? 0
  const pc24 = t.priceChange24h ?? 0

  // ── RUG: textbook dump pattern (overwhelming signal)
  // -85%+ drop in 24h with < $15k liquidity = the LP was pulled.
  if (pc24 < -85 && liq < 15_000) {
    return {
      expectedVerdict: "RUG",
      expectedScore: [0, 400],
      tolerated: ["DANGER"],
      why: `24h drop ${pc24.toFixed(0)}%, liq $${(liq/1000).toFixed(1)}k — textbook rug.`,
    }
  }

  // ── DANGER: thin liq + fresh launch (no time to mature, can't trust)
  // OR ultra-thin liq regardless of age (something pulled it down).
  if (liq < 15_000 && age < 7) {
    return {
      expectedVerdict: "DANGER",
      expectedScore: [100, 600],
      tolerated: ["RUG", "CAUTION"],
      why: `liq $${(liq/1000).toFixed(1)}k, age ${age}d — fresh-launch thin liquidity.`,
    }
  }
  if (liq < 8_000) {
    return {
      expectedVerdict: "DANGER",
      expectedScore: [100, 600],
      tolerated: ["RUG", "CAUTION"],
      why: `liq $${(liq/1000).toFixed(1)}k — ultra-thin liquidity, exit risk.`,
    }
  }

  // ── SAFE: only if external signals are overwhelmingly strong.
  // mcap > $30M AND age > 60d AND liq > $500k = a token that has
  // lasted, has real holders, and has deep liquidity.
  if (mcap >= 30_000_000 && age >= 60 && liq >= 500_000) {
    return {
      expectedVerdict: "SAFE",
      expectedScore: [750, 1000],
      tolerated: ["CAUTION"],
      why: `mcap $${(mcap/1_000_000).toFixed(0)}M, age ${age}d, liq $${(liq/1_000_000).toFixed(1)}M — established blue-chip.`,
    }
  }

  // ── SAFE-leaning: solid mcap + multi-month + decent liq.
  // Tolerated DANGER too because we genuinely can't see concentration.
  if (mcap >= 10_000_000 && age >= 90 && liq >= 200_000) {
    return {
      expectedVerdict: "SAFE",
      expectedScore: [650, 1000],
      tolerated: ["CAUTION", "DANGER"],
      why: `mcap $${(mcap/1_000_000).toFixed(1)}M, age ${age}d, liq $${(liq/1000).toFixed(0)}k — solid established profile.`,
    }
  }

  // ── CAUTION default: every mid-tier token. Wide tolerated band
  // because we genuinely don't know without on-chain data.
  return {
    expectedVerdict: "CAUTION",
    expectedScore: [300, 900],
    tolerated: ["SAFE", "DANGER"],
    why: `mcap $${(mcap/1_000_000).toFixed(2)}M, age ${age}d, liq $${(liq/1000).toFixed(0)}k — mid-cap default (engine has final say).`,
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  const limit = Number(args.find(a => a.startsWith("--limit="))?.split("=")[1] ?? 250)
  const noBoosted = args.includes("--no-boosted")
  const noProfiles = args.includes("--no-profiles")

  console.log("ANTARES corpus discovery")
  console.log("─".repeat(70))

  // ── Source 1: seed (always)
  const candidates: { ca: string; symbol: string | null; tag: string }[] = []
  for (const s of SEED) candidates.push({ ca: s.ca, symbol: s.symbol, tag: `seed-${s.tag}` })
  console.log(`seed: ${SEED.length} mints`)

  // ── Source 2: boosted
  if (!noBoosted) {
    const boosted = await fetchBoosted()
    for (const b of boosted) candidates.push({ ca: b.ca, symbol: null, tag: b.tag })
    console.log(`boosted: ${boosted.length} mints`)
  }

  // ── Source 3: latest profiles
  if (!noProfiles) {
    const profiles = await fetchLatestProfiles()
    for (const p of profiles) candidates.push({ ca: p.ca, symbol: null, tag: p.tag })
    console.log(`profiles: ${profiles.length} mints`)
  }

  // ── De-dupe by mint, prefer seed entries (they have known symbols)
  const byCa = new Map<string, { ca: string; symbol: string | null; tag: string }>()
  for (const c of candidates) {
    const existing = byCa.get(c.ca)
    if (!existing || (c.tag.startsWith("seed-") && !existing.tag.startsWith("seed-"))) {
      byCa.set(c.ca, c)
    }
  }
  const unique = [...byCa.values()].slice(0, limit)
  console.log(`unique: ${unique.length} mints (limit ${limit})`)
  console.log()

  // ── Enrichment
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
    await sleep(180) // gentle on DexScreener (~5 req/s)
  }

  // ── Emit corpus block (DISCOVERED only — seed stays in corpus.ts)
  const discovered = enriched.filter(e => !e.tag.startsWith("seed-"))

  // De-dupe symbols by appending mint suffix to collisions. Fixtures
  // are filename-keyed by symbol so collisions clobber each other.
  const seenSymbols = new Map<string, number>()
  for (const e of discovered) {
    const count = seenSymbols.get(e.symbol) ?? 0
    if (count > 0) {
      e.symbol = `${e.symbol}_${e.ca.slice(0, 4).toUpperCase()}`
    }
    seenSymbols.set(e.symbol.split("_")[0], count + 1)
  }

  const lines: string[] = []
  lines.push("// AUTO-GENERATED by scripts/corpus-discover.ts — review before merging")
  lines.push("// Auto-labels use external DexScreener signals only (mcap, liq, age,")
  lines.push("// 24h price change). They are intentionally CONSERVATIVE: SAFE only")
  lines.push("// when overwhelming, RUG only on textbook dumps, CAUTION default. The")
  lines.push("// engine sees on-chain data the labeller can't (top wallet %, LP burn,")
  lines.push("// honeypot, GoPlus) so it has the final say — divergence between this")
  lines.push("// label and the engine surfaces in the accuracy backtest.")
  lines.push("")
  lines.push("import type { CorpusEntry } from \"./corpus\"")
  lines.push("")
  lines.push("export const DISCOVERED: CorpusEntry[] = [")
  for (const e of discovered) {
    const lbl = label(e)
    const tolerated = lbl.tolerated
      ? `\n    tolerated: [${lbl.tolerated.map(v => `"${v}"`).join(", ")}],`
      : ""
    lines.push(`  {`)
    lines.push(`    ca: "${e.ca}",`)
    lines.push(`    symbol: "${e.symbol}",`)
    lines.push(`    expectedVerdict: "${lbl.expectedVerdict}",${tolerated}`)
    lines.push(`    expectedScore: [${lbl.expectedScore[0]}, ${lbl.expectedScore[1]}],`)
    lines.push(`    why: "${lbl.why.replace(/"/g, '\\"')}",`)
    lines.push(`    source: "external",`)
    // Auto-discovered entries start as skipFixture — they need a live
    // capture run after merge (to refresh against the deployed engine)
    // before they're CI-graded. Strip the flag once the fixture lands.
    lines.push(`    skipFixture: true, // pending first capture`)
    lines.push(`  },`)
  }
  lines.push("]")
  lines.push("")

  await fs.writeFile(OUT_PATH, lines.join("\n"))
  console.log()
  console.log("─".repeat(70))
  console.log(`Enriched: ${enriched.length} / ${unique.length}`)
  console.log(`Output:   ${OUT_PATH}`)

  // Distribution summary
  const dist = enriched.reduce((acc, e) => {
    const v = label(e).expectedVerdict
    acc[v] = (acc[v] ?? 0) + 1
    return acc
  }, {} as Record<Verdict, number>)
  console.log()
  console.log(`Verdict distribution (auto-labelled):`)
  for (const v of ["SAFE", "CAUTION", "DANGER", "RUG"] as Verdict[]) {
    console.log(`  ${v.padEnd(8)} ${(dist[v] ?? 0).toString().padStart(4)}`)
  }
}

void main()
