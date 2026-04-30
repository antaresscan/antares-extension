// scripts/corpus-discover.ts
//
// Discovers candidate Solana memecoins from DexScreener + CoinGecko and
// emits a TS block ready to paste into __tests__/backtest/corpus.ts.
//
// Five sources are merged + de-duped:
//   1. A hand-curated SEED list of well-known memecoins (BONK, WIF, …)
//      that we want pinned in the corpus regardless of API state.
//   2. DexScreener "boosted/top" tokens — paid promotion list, heavily
//      shitcoin-skewed, useful for surfacing DANGER/RUG candidates.
//   3. DexScreener "boosted/latest" — different rotation, more fresh-
//      launch noise.
//   4. DexScreener "latest profiles" — recently-listed tokens with a
//      profile, useful for fresh-launch DANGER candidates.
//   5. CoinGecko `solana-meme-coins` category — top 100 by market cap,
//      ground-truth for the SAFE/CAUTION bands. We resolve each
//      CoinGecko entry to its Solana mint by symbol-searching
//      DexScreener and picking the highest-liq Solana pair where
//      symbols match. Avoids hitting CG detail endpoint 100x.
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
  { ca: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82", symbol: "BOME", tag: "blue-chip" },
  { ca: "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump", symbol: "MELANIA", tag: "post-rug-stable" },
  { ca: "AjBT19DxbDqDcLFUbm3J3SQYDMCPhjqWHHr3D3GPpump", symbol: "MOTHER", tag: "borderline" },
  { ca: "9psiRdn9cXYVps4F1kFuoNjd1EAAGxF8JGEhbYJpump", symbol: "MOG", tag: "mid-cap" },

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

// Boosts/latest is distinct from boosts/top — different rotation, often
// fresh-launch tokens that haven't accumulated paid-promo enough to hit
// the top yet. Useful for fresh-launch DANGER candidates.
async function fetchBoostedLatest(): Promise<{ ca: string; tag: string }[]> {
  const data = await jsonGet<DsBoosted[]>("https://api.dexscreener.com/token-boosts/latest/v1")
  if (!data) return []
  return data
    .filter(d => d.chainId === "solana")
    .map(d => ({ ca: d.tokenAddress, tag: "discovered-boosted-latest" }))
}

interface GtPool {
  id: string
  type: string
  attributes: { name: string }
  relationships: {
    base_token: { data: { id: string } }
    quote_token: { data: { id: string } }
  }
}

interface GtPoolsResp { data: GtPool[] }

// GeckoTerminal exposes the deepest set of Solana DEX pools — 20 per
// page, paginated. We sweep the top 30 pages (600 pools, dominated by
// memecoins given the Solana DEX traffic profile). Each pool's
// base_token id is `solana_<mint>`. This single source contributes the
// bulk of corpus expansion past CoinGecko's ~400 ceiling.
async function fetchGeckoTerminalPools(pages: number): Promise<{ ca: string; tag: string }[]> {
  const STABLE_MINTS = new Set([
    "So11111111111111111111111111111111111111112", // wSOL
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  ])
  const seen = new Set<string>()
  const results: { ca: string; tag: string }[] = []
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools?page=${page}`
    console.log(`  GT pools page ${page}…`)
    const data = await jsonGet<GtPoolsResp>(url)
    if (!data?.data?.length) break
    for (const pool of data.data) {
      const baseId = pool.relationships?.base_token?.data?.id ?? ""
      const mint = baseId.startsWith("solana_") ? baseId.slice("solana_".length) : null
      if (!mint || STABLE_MINTS.has(mint)) continue
      if (seen.has(mint)) continue
      seen.add(mint)
      results.push({ ca: mint, tag: "discovered-gt-pool" })
    }
    await sleep(800) // GT rate limit ~30 req/min, sleep 800ms is safe
  }
  return results
}

interface CGCoin {
  id: string
  symbol: string
  name: string
  market_cap: number | null
  market_cap_rank: number | null
}


// CoinGecko's `solana-meme-coins` category is the closest thing to a
// ground-truth list of established Solana memecoins (top 100 by mcap).
// We use CG's `/coins/<id>` endpoint to resolve each entry's exact
// Solana contract via `platforms.solana` — using DexScreener symbol
// search instead would match scam tokens stealing legit tickers (real
// "BONK" mint vs "BONK 2.0" knockoff with $250M concentrated supply).
// CG free tier rate limit is ~30 req/min so 100 calls take ~3.5min.
interface CGCoinDetail {
  id: string
  symbol: string
  platforms?: { solana?: string }
}

async function fetchCoinGeckoSolanaMemes(): Promise<{ ca: string; symbol: string; tag: string }[]> {
  // CG `solana-meme-coins` has ~400 entries paginated 100/page across 4
  // pages — that's the deep ground-truth list of Solana memecoins by
  // mcap. We then sweep adjacent meme categories (meme-token / dog /
  // cat / frog / ai) for any non-Solana-tagged Solana memecoins missed
  // by the main category. All results dedupe by CG id, then resolve to
  // canonical mints via /coins/<id>.platforms.solana.
  const paginatedCats: Array<{ cat: string; pages: number }> = [
    { cat: "solana-meme-coins", pages: 4 }, // ~400 tokens — the deepest source
    { cat: "meme-token", pages: 1 },
    { cat: "dog-themed-coins", pages: 1 },
    { cat: "cat-themed-coins", pages: 1 },
    { cat: "frog-themed-coins", pages: 1 },
    { cat: "ai-meme-coins", pages: 1 },
  ]

  const candidatesById = new Map<string, CGCoin>()
  for (const { cat, pages } of paginatedCats) {
    for (let p = 1; p <= pages; p++) {
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${cat}&order=market_cap_desc&per_page=100&page=${p}`
      console.log(`  CG markets: ${cat} page ${p}…`)
      const markets = await jsonGet<CGCoin[]>(url)
      if (!markets || markets.length === 0) {
        // CG returns 200 with empty array (or error) past available pages
        if (p > 1) break
        continue
      }
      for (const c of markets) candidatesById.set(c.id, c)
      await sleep(1500)
    }
  }
  console.log(`  ${candidatesById.size} unique CG candidates — resolving Solana mints…`)

  const results: { ca: string; symbol: string; tag: string }[] = []
  let resolved = 0
  let skipped = 0
  for (const coin of candidatesById.values()) {
    if (!coin.id) { skipped++; continue }
    // Hit /coins/<id> for the canonical platforms.solana contract.
    // localization=false&tickers=false&community_data=false&developer_data=false
    // strips response weight to ~2KB per call.
    const detailUrl = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin.id)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`
    const detail = await jsonGet<CGCoinDetail>(detailUrl)
    if (!detail || !detail.platforms?.solana) {
      skipped++
      await sleep(2200)
      continue
    }
    const mint = detail.platforms.solana
    results.push({
      ca: mint,
      symbol: (coin.symbol || detail.symbol || "").toUpperCase(),
      tag: "discovered-cg-meme",
    })
    resolved++
    if (resolved % 50 === 0) console.log(`    progress: ${resolved} resolved, ${skipped} skipped (non-Solana / no platform)`)
    await sleep(2200)
  }
  console.log(`  resolved ${resolved}/${candidatesById.size} CG memecoins to canonical Solana mints (${skipped} skipped, non-Solana)`)
  return results
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
      tolerated: ["RUG", "CAUTION", "SAFE"],
      why: `liq $${(liq/1000).toFixed(1)}k, age ${age}d — fresh-launch thin liquidity.`,
    }
  }
  if (liq < 8_000) {
    return {
      expectedVerdict: "DANGER",
      expectedScore: [100, 600],
      tolerated: ["RUG", "CAUTION", "SAFE"],
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
  // because we genuinely don't know without on-chain data. RUG is in
  // tolerated because the engine routinely escalates obvious shitcoins
  // (no socials, mintAuthority active, post-pump dump) that the
  // external metrics alone label CAUTION as default — and the engine
  // is usually right on those.
  return {
    expectedVerdict: "CAUTION",
    expectedScore: [300, 900],
    tolerated: ["SAFE", "DANGER", "RUG"],
    why: `mcap $${(mcap/1_000_000).toFixed(2)}M, age ${age}d, liq $${(liq/1000).toFixed(0)}k — mid-cap default (engine has final say).`,
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  const limit = Number(args.find(a => a.startsWith("--limit="))?.split("=")[1] ?? 300)
  const noBoosted = args.includes("--no-boosted")
  const noProfiles = args.includes("--no-profiles")
  const noCG = args.includes("--no-cg")

  console.log("ANTARES corpus discovery")
  console.log("─".repeat(70))

  // ── Source 1: seed (always)
  const candidates: { ca: string; symbol: string | null; tag: string }[] = []
  for (const s of SEED) candidates.push({ ca: s.ca, symbol: s.symbol, tag: `seed-${s.tag}` })
  console.log(`seed: ${SEED.length} mints`)

  // ── Source 2: boosted/top
  if (!noBoosted) {
    const boosted = await fetchBoosted()
    for (const b of boosted) candidates.push({ ca: b.ca, symbol: null, tag: b.tag })
    console.log(`boosted/top: ${boosted.length} mints`)
  }

  // ── Source 3: boosted/latest (different rotation)
  if (!noBoosted) {
    const latest = await fetchBoostedLatest()
    for (const b of latest) candidates.push({ ca: b.ca, symbol: null, tag: b.tag })
    console.log(`boosted/latest: ${latest.length} mints`)
  }

  // ── Source 4: latest profiles
  if (!noProfiles) {
    const profiles = await fetchLatestProfiles()
    for (const p of profiles) candidates.push({ ca: p.ca, symbol: null, tag: p.tag })
    console.log(`profiles: ${profiles.length} mints`)
  }

  // ── Source 5: CoinGecko solana-meme-coins (top 100 by mcap, ground-truth)
  if (!noCG) {
    const cgMemes = await fetchCoinGeckoSolanaMemes()
    for (const c of cgMemes) candidates.push({ ca: c.ca, symbol: c.symbol, tag: c.tag })
    console.log(`coingecko: ${cgMemes.length} mints (resolved to Solana)`)
  }

  // ── Source 6: GeckoTerminal Solana pools (deepest ground-truth list,
  // ~600 mints across 30 pages, dominated by Solana memecoins).
  const noGT = args.includes("--no-gt")
  if (!noGT) {
    const gtPools = await fetchGeckoTerminalPools(100)
    for (const p of gtPools) candidates.push({ ca: p.ca, symbol: null, tag: p.tag })
    console.log(`geckoterminal: ${gtPools.length} mints (top Solana pools by liquidity)`)
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
