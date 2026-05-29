// api/constants.ts — All constants for Antares scan engine

export const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
export const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";
export const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
export const HELIUS_BASE = "https://mainnet.helius-rpc.com";
// Free public Solana RPC pool — tried in order until one responds. Same
// JSON-RPC interface as Helius so the existing isHelius* type guards work
// on the result.
//
// IMPORTANT: only the cheap methods (`getTokenSupply`, `getAccountInfo`)
// reliably work on free tier. `getTokenLargestAccounts` is heavy and gets
// rate-limited (429) on Solana Foundation and explicitly BLOCKED on
// PublicNode. Top-holder concentration therefore still requires Helius
// in practice; the public-RPC fallback exists for the supply path only.
//
// Tested 2026-04-26:
//   - api.mainnet-beta.solana.com: Solana Foundation, getTokenSupply OK,
//     getTokenLargestAccounts 429 on real tokens
//   - solana-rpc.publicnode.com: getTokenSupply OK, getTokenLargestAccounts
//     blocked with -32602 "Request blocked"
//   - rpc.ankr.com/solana: now requires an API key (used to be free)
export const PUBLIC_SOLANA_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
] as const;
export const SOLSCAN_PUBLIC_BASE = "https://public-api.solscan.io";
export const SOLSCAN_BASE = "https://pro-api.solscan.io/v2.0";

// CA_RE — single source of truth from shared/constants.ts
export { CA_RE } from "../../shared/constants";

// ═══ LP PROGRAM ADDRESSES ═══════════════════════════════════════════════════════════════════
// These are DEX program / vault addresses that hold tokens on behalf of liquidity pools.
// They must NEVER be counted as real holder wallets in layerHelius.
export const LP_PROGRAM_ADDRESSES = new Set([
  // ── Raydium
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",  // Raydium Authority V4
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // Raydium LP V4
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",  // Raydium AMM v3
  // ── Orca
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   // Orca Whirlpool
  // ── Meteora (ALL programs — active + legacy)
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",  // Meteora DLMM (Dynamic Liquidity Market Maker)
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",  // Meteora DAMM v2
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",  // Meteora DBC (Dynamic Bonding Curve)
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vAB", // Meteora DAMM v1 (legacy)
  "24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi", // Meteora Dynamic Vault (legacy)
  "vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2",  // Meteora Alpha Vault
  "MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky",  // Mercurial Stable Swap (legacy Meteora)
  // ── PumpSwap / pump.fun
  "PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP",  // PumpSwap AMM
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  // pump.fun bonding curve program
  // ── Other
  "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN",  // Tensor Swap
  "CURVGoZn8zycx6FXwwevgBTB2gVvdbGTEpvMJDbgs2t4", // Saber/Curves
]);

// ═══ FOUNDATION WALLETS ═════════════════════════════════════════════════════════════════════
// CRITICAL: LP_PROGRAM_ADDRESSES and FOUNDATION_WALLETS MUST be kept in sync.
// Any address in LP_PROGRAM_ADDRESSES should also be in FOUNDATION_WALLETS.
// layerHelius filters holders using BOTH sets. Missing an address in FOUNDATION_WALLETS
// causes that LP vault to be counted as a real whale holder -> false concentration signal.
export const FOUNDATION_WALLETS = new Set([
  // ── Raydium
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",  // Raydium Authority V4
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // Raydium LP V4
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",  // Raydium AMM v3
  // ── Orca
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   // Orca Whirlpool
  // ── Meteora (ALL programs — active + legacy)
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",  // Meteora DLMM
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",  // Meteora DAMM v2
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",  // Meteora DBC
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vAB", // Meteora DAMM v1 (legacy)
  "24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi", // Meteora Dynamic Vault (legacy)
  "vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2",  // Meteora Alpha Vault
  "MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky",  // Mercurial Stable Swap (legacy Meteora)
  // ── PumpSwap / pump.fun
  "PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP",  // PumpSwap AMM
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  // pump.fun bonding curve
  // ── Other
  "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN",  // Tensor Swap
  "CURVGoZn8zycx6FXwwevgBTB2gVvdbGTEpvMJDbgs2t4", // Saber/Curves
]);

export const OFFICIAL_MINTS = new Set([
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
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  // USDT
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",  // ORCA
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  // JUP (governance)
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // WBTC (Wormhole)
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH (Wormhole)
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",  // bSOL
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", // stSOL
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", // SPX6900 (Wormhole)
]);

// ═══ LAYER WEIGHTS (identity layer removed) ════════════════════════════════════════════════════
export const LAYER_WEIGHTS: Record<string, number> = {
  dexscreener: 0.20,
  rugcheck:    0.20,
  goplus:      0.20,
  helius:      0.20,
  solscan:     0.10,
  chart:       0.10,
};
// crossvalidation has NO weight — it is a post-score multiplier

// Cross-validation penalty multipliers
export const XV_PENALTY_LP_BURN              = 0.85; // -15% if LP burn status conflicts between sources
export const XV_PENALTY_MINT_AUTH            = 0.70; // -30% if mint authority conflicts
export const XV_PENALTY_AGE                  = 0.90; // -10% if token age conflicts
export const XV_PENALTY_HOLDER_CONCENTRATION = 0.80; // -20% if holder concentration conflicts
export const ESTABLISHED_BONUS_MULTIPLIER    = 1.05; // HARDENED: +5% bonus (was +15%)
export const ESTABLISHED_AGE_THRESHOLD_HOURS = 720;  // 30 days — realistic for meme tokens
export const ESTABLISHED_HOLDERS_THRESHOLD    = 5000; // HARDENED: 5000 holders (was 1000)

// Trust floor for geometric mean — prevents single-layer nuking
export const TRUST_FLOOR = 0.001;

// ═══ SCORING ENGINE VERSION ════════════════════════════════════════════════
//
// Tied to the Redis scan cache key (`api/_lib/cache.ts`). The cache stores
// the *output* of the scoring pipeline; if any input weight, penalty or
// threshold changes, every cached score becomes stale and must be evicted.
// Without an engine version in the cache key, a deploy that retunes the
// weights would hand back the OLD score for any token still in cache —
// users see DANGER, refresh five minutes later, see SAFE. That happened
// once already (LP-burn weight bump in v14) and triggered a wave of
// "your scanner is broken, the verdict keeps flipping" support tickets.
//
// **Maintenance rule**: bump `ENGINE_VERSION_MANUAL` whenever you change
// any of these in this file:
//   - LAYER_WEIGHTS values
//   - XV_PENALTY_* multipliers
//   - TRUST_FLOOR
//   - ESTABLISHED_* thresholds / multiplier
//   - HARD_BLOCK_REASONS membership
//   - Any constant consumed by api/_lib/scoring.ts or api/_lib/layers.ts
//
// `ENGINE_VERSION` below combines the manual tag with a fingerprint of the
// numeric constants so accidental "I changed a weight but forgot to bump"
// is caught automatically — different fingerprint, different cache key,
// stale entries naturally expire on first read miss.
const ENGINE_VERSION_MANUAL = "v20"; // PR #527: hide "Positive signals" section in critical-flags panel when verdict is RUG or DANGER. Bonus checkmarks alongside a RUG verdict read as cognitive dissonance — keep them only for SAFE/CAUTION where they reinforce the verdict. Pure UI change but bumping the cache key keeps the response/UI in sync after deploy.

function fingerprint(): string {
  // Stable, order-independent stringify — JSON.stringify with sorted keys.
  const parts = {
    weights: Object.keys(LAYER_WEIGHTS)
      .sort()
      .map((k) => `${k}=${LAYER_WEIGHTS[k]}`)
      .join(","),
    xv: [
      `lp=${XV_PENALTY_LP_BURN}`,
      `mint=${XV_PENALTY_MINT_AUTH}`,
      `age=${XV_PENALTY_AGE}`,
      `holder=${XV_PENALTY_HOLDER_CONCENTRATION}`,
    ].join(","),
    bonus: [
      `mult=${ESTABLISHED_BONUS_MULTIPLIER}`,
      `age=${ESTABLISHED_AGE_THRESHOLD_HOURS}`,
      `holders=${ESTABLISHED_HOLDERS_THRESHOLD}`,
    ].join(","),
    floor: `${TRUST_FLOOR}`,
  };
  // FNV-1a 32-bit — deterministic, fast, no Node dependency. The result
  // is hex-encoded so it's URL/Redis-key safe.
  const input = JSON.stringify(parts);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export const ENGINE_VERSION = `${ENGINE_VERSION_MANUAL}-${fingerprint()}`;

// ── HARD BLOCK REASONS (single source of truth) ──────────────
export const HARD_BLOCK_REASONS = new Set([
  "lp", "deceptive_name", "honeypot", "mint", "freeze",
  "bundle", "rug_pattern", "wash_trading", "sniper", "pump", "chart", "low_holders",
  // High single-wallet concentration (>=15%) cannot be soft-unlocked
  // by the established-bonus. A wallet with that share can crash the
  // market irrespective of holder count or token age, so we never let
  // the verdict pass through to SAFE while concentration is severe.
  "concentration",
]);

// ── LP-UNVERIFIED MATURITY THRESHOLDS ────────────────────────
// A token that meets all three of these thresholds (plus no mint /
// freeze / honeypot) gets the soft "unverified LP" flag (CAUTION)
// instead of the hard "dev can rug" flag (DANGER) when its LP isn't
// burned or locked. Previous values (10k holders / $1M liq / 30d)
// were too strict — well-established mid-cap tokens like NEET
// (~16k holders, 30d+, $1.3M liq, clean contract, well-distributed)
// were collapsing straight to DANGER even though their operational
// profile is closer to "established memecoin with team-managed LP"
// than "fresh rug setup". The relaxed values pick up that mid-cap
// band while still gating fresh launches and tiny tokens.
export const LP_UNVERIFIED_MIN_HOLDERS   = 5000;
export const LP_UNVERIFIED_MIN_LIQUIDITY = 500_000;
export const LP_UNVERIFIED_MIN_AGE_HOURS = 336; // 14 days

// NOTE: LP-unverified scoring was rewritten in SCORING_VERSION 7.6.0 to
// use a 2-axis matrix (LP % of supply × token age). The legacy
// LP_UNVERIFIED_MIN_* constants above are kept only because some tests
// still reference the symbol names. The matrix thresholds live in
// api/_lib/lp-risk-matrix.ts and supersede this section for production
// scoring. Treat the constants above as legacy/dead for scoring decisions.

// ── EXTERNAL API BASE URLs ───────────────────────────────────

export const HELIUS_REST_BASE = "https://api.helius.xyz";

// ── LAYER THRESHOLDS (extracted from layers.ts) ─────────────────────────────
// DexScreener liquidity thresholds
export const LIQ_CRITICAL = 1000;       // <$1k = critical
export const LIQ_LOW = 5000;            // <$5k = warning
export const LIQ_MEDIUM = 20000;        // <$20k = info
// Wash trading
export const WASH_VOL_LIQ_RATIO = 20;   // vol/liq > 20 = wash trading
export const HIGH_VOL_LIQ_RATIO = 5;    // vol/liq > 5 = high ratio warning
// Holder thresholds (Helius)
export const TOP1_CRITICAL_PCT = 0.30;   // single wallet > 30% = forceRug
export const TOP1_HIGH_PCT = 0.20;       // single wallet > 20% = critical
export const TOP1_WARN_PCT = 0.10;       // single wallet > 10% = warning
export const TOP10_CRITICAL_PCT = 0.80;  // top 10 > 80% = critical
export const TOP10_WARN_PCT = 0.60;      // top 10 > 60% = warning
export const TOP10_GOOD_PCT = 0.30;      // top 10 < 30% = well distributed
// Solscan holder counts
export const HOLDERS_CRITICAL = 15;      // <15 = very few
export const HOLDERS_LOW = 50;           // <50 = low
export const HOLDERS_STRONG = 5000;      // >5000 = strong
// Chart pattern thresholds
export const DAMPENING_FACTOR = 0.3;     // applyDiminishingPenalties factor
// HTTP timeouts (ms)
export const API_TIMEOUT_DEFAULT = 5000;
export const API_TIMEOUT_HELIUS = 6000;

// ── SCORING VERSION (single source of truth) ─────────────────
// 7.4.0 — bumped 2026-05-20 to invalidate the Redis cache after the
// scoring changes in PRs #510 (TOCTOU + Sentry + safeUrl + scrub
// keys), #512 (PUMPED 24h warning flag in layerChart) and #513
// (Wash Volume donut wired to vol/liq ratio + Sniper Map labelling
// + Liquidity mirage label restoration). Without this bump the Redis
// cache keeps serving pre-merge scans so users never see the new
// PUMPED flag or the corrected Liquidity-mirage routing through the
// AI summary. Standard cache-invalidation step after any scoring or
// flag-label change.
//
// 7.7.0 bump (this commit): "holders" reclassified from SOFT → HARD
// in the safe-gate logic. Previously the override let mature tokens
// (LP burned + holders count ≥ ESTABLISHED_HOLDERS_THRESHOLD) unlock
// the SAFE verdict even when Helius was unavailable and the actual
// holder DISTRIBUTION was unknown. User-reported RIV case: token had
// 5,136 holder addresses (count) but a single wallet held 40% of
// supply — engine couldn't verify distribution (Helius down), but
// "holders" being soft let the count-based established check unlock
// SAFE. Count != distribution. Without verified concentration data
// we cannot honestly say SAFE — the gate now stays closed.
export const SCORING_VERSION = "7.7.0";

// ── SOFT REASONS (safe gate unlock) ───────────────────────────
// A reason listed here CAN be unlocked by applySafeGateOverride when
// the token meets the established-token criteria (LP burned, holders
// count threshold, GoPlus clean, sources count). Everything NOT here
// is a HARD reason — the safe gate stays closed regardless of how
// mature the token is.
//
// Why "holders" is NOT in this map any more (2026-05-28, RIV case):
// "holders" is added to safeBlockedReasons by classifySafeBlockedReasons
// whenever a holder-related flag fires — including the catastrophic
// "Helius unavailable — holder concentration unverified" flag. Marking
// it soft used to mean "if the token is mature enough, trust the
// distribution is OK". That's wrong: a token can have 100,000 holder
// addresses and still have one wallet holding 40% of supply. Count
// doesn't imply distribution. Without VERIFIED concentration data
// (Helius largestAccounts → topHolderPct + top10HolderPct), the gate
// must stay closed. CAUTION is the correct ceiling, not SAFE.
export const SOFT_REASONS: Record<string, boolean> = { age: true, lp_unverified: true, pump_imbalance: true };

// ── RUG DATABASE ───────────────────────────────────────────
export const MAX_RUG_INDEX = 5000;  // increased from 500 for production scale

// ── INSIDER GRAPH CONSTANTS ─────────────────────────────────────────
// Lowered from 100 → 20 in PR #294. Each top holder costs one Helius
// getSignaturesForAddress RPC call per uncached graph build. At 100 the
// graph endpoint was the audit's #1 Helius-quota risk on popular
// tokens (200 calls per request). Top-20 captures the meaningful
// concentration / coordination patterns; the long tail (#21–#100) was
// rarely participating in the clusters the engine actually surfaced.
export const INSIDER_MAX_HOLDERS = 20;
export const INSIDER_MAX_SIGNATURES = 50;
export const INSIDER_GRAPH_CACHE_TTL = 300; // 5 minutes
export const INSIDER_GRAPH_CACHE_PREFIX = "ig:";
// Per-wallet signature cache: same TTL as the graph, separate prefix.
// Lets repeat scans of overlapping holders skip the Helius round-trip.
export const INSIDER_SIG_CACHE_TTL = 300; // 5 minutes
export const INSIDER_SIG_CACHE_PREFIX = "igsig:";

// ═══ VERDICT HISTORY (per-token timeline) ═══════════════════════════════
// Each scan pushes one entry into a Redis ZSET keyed `vh:{ca}`. Score is
// the timestamp; member is a JSON-serialized {ts, verdict, score, event}.
// Cap retained entries to MAX so the ZSET stays bounded; older entries
// fall off via ZREMRANGEBYRANK after each push. TTL on the key itself is
// generous so a token that hasn't been scanned in a while still keeps
// some history when it is scanned again.
export const VERDICT_HISTORY_PREFIX = "vh:";
export const VERDICT_HISTORY_MAX_ENTRIES = 50;
export const VERDICT_HISTORY_TTL = 60 * 60 * 24 * 30; // 30 days
// How many entries to return on the API response. Frontend renders the
// last 6 (one per row of the v5 timeline).
export const VERDICT_HISTORY_RESPONSE_LIMIT = 6;
// Don't push a new entry if the same scan key was hit within this window —
// avoids polluting the timeline when the page is refreshed in a tight
// loop (auto-refresh, multiple tabs).
export const VERDICT_HISTORY_DEDUPE_WINDOW_MS = 60_000; // 1 minute
