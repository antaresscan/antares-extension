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
const ENGINE_VERSION_MANUAL = "v43"; // 2026-10-07: the RugCheck layer reads RugCheck's real summary (creator history, mutable metadata, concentration fallback, LP locked share); flushes cached scans scored with the empty layer.

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

// ── RUGCHECK LP LOCK ─────────────────────────────────────────
// RugCheck's summary gives lpLockedPct (0-100): the share of LP tokens locked
// or burned. From this share the pool counts as secured for the "LP locked"
// state. Pools seen in real answers: MEW 99.6, PNUT 99.4, ACT 99.8, PIPPIN 97.8,
// MYRO 93.2 (burned or locked by design); HAWK 0, HORNY 0 (open). Mid-sized
// shares come from tokens with several pools (BONK 15, WIF 46) and say nothing.
export const RUGCHECK_LP_LOCKED_PCT_SECURE = 90;

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
export const LP_UNVERIFIED_MIN_LIQUIDITY = 250_000; // lowered 500k→250k: tokens with $250-500K liq were incorrectly treated as non-mature when on-chain holder sources (Helius/GoPlus/RugCheck) returned stale data, causing single chart-pattern warnings to route to DANGER instead of CAUTION (WOJAK case)
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
export const WASH_VOL_LIQ_RATIO = 15;   // vol/liq > 15 = wash trading (lowered from 20: DexScreener liq fluctuates ±20% between calls, old threshold caused DANGER↔CAUTION flips on borderline tokens)
export const HIGH_VOL_LIQ_RATIO = 5;    // vol/liq > 5 = high ratio warning
// Holder thresholds (Helius) — top-10 distribution bands (7.7.5+)
// Two tiers: FRESH (no context / <30d / <5k holders) vs ESTABLISHED (≥30d AND ≥5k).
// FRESH:       extreme ≥75%, high ≥55%, elevated ≥35%, moderate ≥20%, bonus <20%
// ESTABLISHED: extreme ≥80%, high ≥65%, elevated ≥45%, moderate ≥25%, bonus <25%
export const TOP10_FRESH_EXTREME_PCT      = 0.75;
export const TOP10_FRESH_HIGH_PCT         = 0.55;
export const TOP10_FRESH_ELEVATED_PCT     = 0.35;
export const TOP10_FRESH_MODERATE_PCT     = 0.20;
export const TOP10_EST_EXTREME_PCT        = 0.80;
export const TOP10_EST_HIGH_PCT           = 0.65;
export const TOP10_EST_ELEVATED_PCT       = 0.45;
export const TOP10_EST_MODERATE_PCT       = 0.25;
export const TOP10_GOOD_PCT               = 0.25;  // bonus threshold (established tier)
// Solscan holder counts
export const HOLDERS_CRITICAL = 15;      // <15 = very few
export const HOLDERS_LOW = 50;           // <50 = low
export const HOLDERS_STRONG = 5000;      // >5000 = strong
// Chart pattern thresholds
export const DAMPENING_FACTOR = 0.3;     // applyDiminishingPenalties factor
// Weekly / monthly pump thresholds.
// Tokens that have pumped heavily over 7 or 30 days carry elevated retrace
// risk — even if the contract is clean. These flags block SAFE so blue chips
// that pumped 500%+ show CAUTION rather than a false-positive green signal.
export const PUMP_7D_WARN_PCT  = 200;   // >200% in 7 days  → warning (blocks SAFE)
export const PUMP_7D_HIGH_PCT  = 500;   // >500% in 7 days  → stronger warning
export const PUMP_30D_WARN_PCT = 200;   // >200% in 30 days → warning (blocks SAFE)
export const PUMP_30D_HIGH_PCT = 500;   // >500% in 30 days → stronger warning
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
// 7.7.0 bump: "holders" reclassified from SOFT → not-soft in the
// safe-gate logic. Previously the override let mature tokens (LP
// burned + holders count ≥ ESTABLISHED_HOLDERS_THRESHOLD) unlock
// the SAFE verdict even when Helius was unavailable and the actual
// holder DISTRIBUTION was unknown. User-reported RIV case: token had
// 5,136 holder addresses (count) but a single wallet held 40% of
// supply — engine couldn't verify distribution (Helius down), but
// "holders" being soft let the count-based established check unlock
// SAFE. Count != distribution. Without verified concentration data
// we cannot honestly say SAFE — the gate now stays closed.
//
// 7.7.1 bump: single-wallet concentration threshold
// lowered from 15% → 10%. Founder rule: "si un wallet du top 10
// dépasse 10% c'est danger automatiquement". The 10-14% band that
// used to emit a soft-warning ("concentration_warning") is now folded
// into the hard "concentration" band — same verdict path as 15%+,
// no exceptions for blue-chips. layers.ts emits the flag as
// critical at this threshold; scoring.ts regex matches 10%+.
//
// 7.7.2 bump (this commit, 2026-05-29): tighten the Helius "broken
// upstream view" data-quality fallback. Previously any token where
// the engine could not confirm holder count (mc.holders < 200) and
// macro looked big (≥$250k liq, ≥30d) would have its concentration
// flag SILENTLY DROPPED — designed for GOAT/PNUT-style pump.fun
// bonding-curve artefacts (~99% top-1 on tokens that are actually
// blue-chips). The fallback misfired on RIV (40% top-1, $651k liq,
// 67d) because Solscan returned no holder count → mc.holders fell
// back to Helius top-20 list size → fallback fired → 40% wallet
// flag dropped → SAFE 795. The new gate also requires the
// concentration values themselves to be structurally impossible
// (top1 > 80% OR top10 > 95%) before treating the data as broken.
// Real-whale ranges (10–50%) stay flagged. SCORING_VERSION bump
// pairs with the ENGINE_VERSION_MANUAL v21 bump in this file to
// flush cached SAFE entries produced by the old fallback.
//
// 7.7.3 bump (2026-05-29): split concentration into two tiers.
// 10-14% → "concentration_light" (soft, max CAUTION, never SAFE).
// 15%+   → "concentration" (hard, DANGER or RUG, no exceptions).
// Previously all ≥10% were hard → FARTCOIN (11%) and WIF (12%) were
// landing DANGER 500 instead of CAUTION.
//
// 7.7.4 bump (2026-05-29): remove top-1 single-wallet concentration flag
// entirely. Replace with top-10 distribution ladder in layerHelius.
//
// 7.7.5 bump (2026-05-29): 2-tier concentration system.
// Fresh tokens (<30d OR <5k holders): 20%+ moderate, 35%+ soft CAUTION,
//   55%+ hard DANGER, 75%+ extreme DANGER/RUG.
// Established tokens (≥30d AND ≥5k holders): 25-44% info with exchange
//   context note (SAFE possible), 45%+ soft CAUTION, 65%+ hard DANGER,
//   80%+ extreme DANGER/RUG. Contextual labels in flag and Sniper Map
//   explain that top wallets likely include exchanges & long-term holders.
//
// 7.7.6 bump (2026-05-30): fix established-tier detection when holder-count
//   sources are simultaneously unavailable. isEstablishedToken now accepts
//   age >= 60d as an alternative to verified holders >= 5k — blue-chips
//   like FARTCOIN were landing CAUTION/fresh-tier when GoPlus was down.
// 7.7.7 bump (2026-05-30): LP risk matrix split at 10% threshold.
//   LP < 10% (buckets "<1%", "1-5%", "5-10%"): NEVER safeBlock regardless
//   of age. Price impact on full drain < 20% — survivable, not rug-zero.
//   LP 10-15% (new "10-15%" bucket): safeBlock only on fresh pairs (<14d).
//   After 2 weeks the time-based trust outweighs the LP risk.
//   LP >= 15%: unchanged (existing safeBlock calibration retained).
// 7.7.8 bump: SAFE requires zero warning/critical flags. ANY flag = CAUTION max.
// 7.7.9 bump: 4 flags demoted warning→info: Low 5m txns, Metadata mutable,
//   Trading cooldown, LP 1-10% on fresh tokens. These alone do not justify CAUTION.
// 7.7.10 bump: "Pumped +N% in 24h" mature 100-200% tier promoted info→warning
//   + safeBlock. Both pump tiers are now warnings; "(blue-chip)" suffix removed.
// 7.7.11 bump: single-wallet safety net. top-1 >40% → DANGER, >55% → RUG
//   (unless blue-chip ≥50k holders). Backstops the top-10 ladder for the
//   HAWK-class single-giant-wallet rug it missed. No blue-chip impact (40%
//   threshold sits above the exchange-cold-wallet range).
// 7.7.12 bump: young-token (<30d) single-wallet tiers added on top of the
//   7.7.11 net. top-1 >15% → hard DANGER; 10-15% → critical soft CAUTION max;
//   5-10% → warning. Scoped to <30d so blue-chips are untouched.
// 7.7.20 bump: GeckoTerminal token-pool fallback in fetchDexCandlesDaily.
//   When primary pool address returns <5 candles (GT doesn't know that pool),
//   query /tokens/{mint}/pools to get GT's own pool list → try top-3 by volume.
//   Covers PumpSwap, Meteora DBC, any AMM where DEXScreener pairAddr ≠ GT ID.
//   Zero additional API keys required.
// 7.7.21 bump (2026-10-07): restore the 7.7.0 rule that the no-flags SAFE
//   override in determineVerdict had bypassed since PR #607. When holder
//   concentration is unverified (the "holders" safe-block reason set by
//   layerHelius), the verdict is capped at CAUTION. Before this, a token with
//   no visible warning, score >= 750 and >= 4 sources came out SAFE with
//   Helius down, including HAWK (a rug), which scanned SAFE 893.
// 7.7.22 bump (2026-10-07): "No website / Twitter / Telegram" is info, not
//   critical. As a critical flag it forced DANGER on any token without a
//   DexScreener profile (determineVerdict: 1+ critical => DANGER), whatever
//   the on-chain layers said, and cost 0.60 of DexScreener trust plus a
//   safe-gate block. A clean token scanned SAFE 1000 with a link and DANGER
//   850 without; stablecoins, tokenized stocks and liquid-staking tokens
//   (no profile) were the usual victims. Real risks (mint/freeze, LP,
//   concentration, wash trading) are untouched; tokens under 6h old still
//   get the "Fresh token on-chain" warning (CAUTION).
// 7.7.23 bump (2026-10-07): the RugCheck layer reads what RugCheck really sends.
//   It used to read fields the summary never had (lpBurned, topHolders,
//   mintAuthorityEnabled...), so it was "available", scored 1.0 and said nothing
//   for every token; the full /report (up to 2.5 MB) was downloaded on every
//   scan and rejected by the validator. Now: a creator with a history of rugged
//   tokens is critical, mutable metadata is a real info flag (-10% layer trust),
//   RugCheck's concentration bands apply only while Helius has no holder list,
//   and lpLockedPct >= 90 counts as LP locked. The mint/freeze authority is
//   deliberately NOT flagged yet (issuer-controlled assets: USDG, CASH, ORCA,
//   tokenized stocks). See api/_lib/rugcheck.ts and layerRugCheck.
export const SCORING_VERSION = "7.7.23";

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
// "concentration_light" = top-10 wallets hold 60-74% of supply (7.7.4+).
// Blocks SAFE — collective 60%+ concentration means coordinated selling
// could crash the price — but allows CAUTION when the rest of the token
// looks clean. The verdict floors at CAUTION; SAFE is never appropriate.
export const SOFT_REASONS: Record<string, boolean> = { age: true, lp_unverified: true, pump_imbalance: true, concentration_light: true };

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
