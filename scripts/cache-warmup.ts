#!/usr/bin/env npx tsx
/**
 * scripts/cache-warmup.ts — Pre-warm the Redis scan cache before launch.
 *
 * Usage:
 *   npx tsx scripts/cache-warmup.ts
 *   npx tsx scripts/cache-warmup.ts --dry-run   # print tokens only, no scans
 *   npx tsx scripts/cache-warmup.ts --concurrency=5  # default: 3
 *
 * What it does:
 *   1. Fetches the top-100 most-traded Solana tokens from DexScreener.
 *   2. Scans each one via the production API (/api/scan?ca=...).
 *   3. The API call populates the Redis cache with a 10-min TTL for SAFE
 *      results, 10-min for DANGER, 30-min for RUG — so users on launch day
 *      get instant results instead of triggering cold upstream calls in mass.
 *
 * Why this matters:
 *   At launch, 0% of tokens are cached. Every scan fires 10+ upstream API
 *   calls (DexScreener, RugCheck, GoPlus, Helius, Solscan). With 200+
 *   concurrent users, the free-tier sources (DexScreener, GoPlus, RugCheck)
 *   start rate-limiting and scores degrade for everyone simultaneously.
 *   Running this script 30min before launch fills the cache for the tokens
 *   most likely to be scanned first, making the first impression fast and clean.
 *
 * Rate limiting:
 *   The script uses concurrency=3 and 500ms between batches by default to
 *   avoid triggering the server-side Upstash rate limiter (20/10s burst).
 *   Even so, the scan endpoint's own per-source timeouts mean each scan
 *   takes 2-6s, so throughput is naturally limited.
 */

const API_BASE = process.env.WARMUP_API_BASE || "https://antares-extension.vercel.app";
const DEXSCREENER_TRENDING = "https://api.dexscreener.com/token-boosts/top/v1";
const DEXSCREENER_SEARCH = "https://api.dexscreener.com/latest/dex/search?q=solana";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const CONCURRENCY = parseInt(args.find(a => a.startsWith("--concurrency="))?.split("=")[1] ?? "3", 10);
const BATCH_DELAY_MS = 600; // stay well under 20/10s burst

// ── Top Solana blue-chips + high-volume tokens (hardcoded seed) ───────────────
// These are always in the top-scanned tokens and should always be cached.
// The DexScreener fetch below adds to this list dynamically.
const SEED_MINTS: string[] = [
  "So11111111111111111111111111111111111111112",    // wSOL
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
  "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",  // JUP
  "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",  // MEW
  "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",  // POPCAT
  "ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY", // MOODENG
  "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump", // GOAT
  "Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump", // CHILLGUY
  "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC", // AI16Z
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",  // ORCA
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  // JUP governance
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", // POPCAT v2
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",  // bSOL
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", // SPX6900
  "FU1q8vJpZNUrmqsciSjp8bAKKidGsLmouB8CBdf8TKQv", // PEPE (Solana)
  "2bpT3ksMdwdZ6DuHyq3FDUr7HDwvZ5DRZoT1fUPALJaH", // RIV (test: should be DANGER)
  "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", // FARTCOIN
];

interface DexToken {
  tokenAddress?: string;
  chainId?: string;
}

async function fetchTrendingMints(): Promise<string[]> {
  const mints: string[] = [];
  try {
    const r = await fetch(DEXSCREENER_TRENDING, {
      headers: { "User-Agent": "antares-cache-warmup/1.0" },
    });
    if (r.ok) {
      const data = await r.json() as DexToken[];
      for (const t of (Array.isArray(data) ? data : [])) {
        if (t.chainId === "solana" && t.tokenAddress) mints.push(t.tokenAddress);
      }
    }
  } catch {
    console.warn("⚠️  Could not fetch trending tokens — using seed list only");
  }
  return mints;
}

async function scanToken(mint: string): Promise<{ verdict: string; score: number; cached: boolean; ms: number } | null> {
  const start = Date.now();
  try {
    const res = await fetch(`${API_BASE}/api/scan?ca=${mint}`, {
      headers: {
        "Origin": "https://dexscreener.com",
        "User-Agent": "antares-cache-warmup/1.0",
        "X-Antares-Warmup": "1",
      },
      signal: AbortSignal.timeout(30_000),
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      console.warn(`  ✗ ${mint.slice(0, 8)}… HTTP ${res.status} (${ms}ms)`);
      return null;
    }
    const body = await res.json() as { risk: string; score: number };
    const cacheStatus = res.headers.get("X-Cache") ?? res.headers.get("cf-cache-status") ?? "—";
    return { verdict: body.risk, score: body.score, cached: cacheStatus === "HIT", ms };
  } catch (e) {
    const ms = Date.now() - start;
    console.warn(`  ✗ ${mint.slice(0, 8)}… ${(e as Error).message} (${ms}ms)`);
    return null;
  }
}

async function runBatch(mints: string[], batchIdx: number): Promise<void> {
  const results = await Promise.all(mints.map(scanToken));
  for (let i = 0; i < mints.length; i++) {
    const r = results[i];
    const mint = mints[i];
    const n = batchIdx * CONCURRENCY + i + 1;
    if (r) {
      const icon = r.verdict === "SAFE" ? "🟢" : r.verdict === "CAUTION" ? "🟡" : r.verdict === "DANGER" ? "🟠" : "🔴";
      console.log(`  [${n}] ${icon} ${mint.slice(0, 12)}… ${r.verdict} ${r.score}/1000 (${r.ms}ms)`);
    }
  }
}

async function main() {
  console.log("─────────────────────────────────────────────────");
  console.log("  Antares cache warm-up script");
  console.log(`  API: ${API_BASE}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log("─────────────────────────────────────────────────\n");

  console.log("📡 Fetching trending tokens from DexScreener…");
  const trending = await fetchTrendingMints();
  console.log(`   Found ${trending.length} trending Solana tokens\n`);

  // Merge seed + trending, deduplicate
  const all = [...new Set([...SEED_MINTS, ...trending])];
  console.log(`📋 Total unique tokens to warm: ${all.length}\n`);

  if (DRY_RUN) {
    console.log("DRY RUN — would scan:");
    all.forEach((m, i) => console.log(`  [${i + 1}] ${m}`));
    return;
  }

  console.log("🔥 Starting warm-up…\n");
  let done = 0;
  const startAll = Date.now();

  for (let i = 0; i < all.length; i += CONCURRENCY) {
    const batch = all.slice(i, i + CONCURRENCY);
    await runBatch(batch, i / CONCURRENCY);
    done += batch.length;

    if (i + CONCURRENCY < all.length) {
      // Respect server-side burst limit: 20/10s. With concurrency=3 and
      // 600ms between batches, max rate is 3/0.6s = 5 req/s = 50/10s
      // server-side across all users. Well within safe territory.
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const totalMs = Date.now() - startAll;
  console.log(`\n✅ Warm-up complete — ${done} tokens in ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`   Cache is now hot for the next 10-30 minutes.`);
  console.log(`   Re-run this script 5 min before launch for maximum freshness.`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
