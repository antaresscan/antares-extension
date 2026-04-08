// api/constants.ts — All constants for Antares scan engine

export const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
export const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";
export const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
export const HELIUS_BASE = "https://mainnet.helius-rpc.com";
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
export const ESTABLISHED_AGE_THRESHOLD_HOURS = 2160; // HARDENED: 90 days (was 30 days)
export const ESTABLISHED_HOLDERS_THRESHOLD    = 5000; // HARDENED: 5000 holders (was 1000)

// Trust floor for geometric mean — prevents single-layer nuking
export const TRUST_FLOOR = 0.001;

// ── HARD BLOCK REASONS ────────────────────────────────────────
// Single source of truth for reasons that force DANGER/RUG regardless of score
export const HARD_BLOCK_REASONS = new Set([
  "lp", "deceptive_name",
  "honeypot", "mint", "freeze", "bundle", "rug_pattern",
  "wash_trading", "sniper", "pump", "chart",
]);

// ── EXTERNAL API BASE URLs ───────────────────────────────────
export const HELIUS_REST_BASE = "https://api.helius.xyz";
