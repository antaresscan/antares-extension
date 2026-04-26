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

// ── HARD BLOCK REASONS (single source of truth) ──────────────
export const HARD_BLOCK_REASONS = new Set([
  "lp", "deceptive_name", "honeypot", "mint", "freeze",
  "bundle", "rug_pattern", "wash_trading", "sniper", "pump", "chart", "low_holders",
]);

// ── EXTERNAL API BASE URLs ───────────────────────────────────
export const LP_UNVERIFIED_MIN_HOLDERS = 10000;
export const LP_UNVERIFIED_MIN_LIQUIDITY = 1000000;
export const LP_UNVERIFIED_MIN_AGE_HOURS = 720;

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
export const SCORING_VERSION = "7.3.0";

// ── SOFT REASONS (safe gate unlock) ───────────────────────────
export const SOFT_REASONS: Record<string, boolean> = { age: true, holders: true, lp_unverified: true };

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
