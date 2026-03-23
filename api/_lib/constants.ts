// api/constants.ts — All constants for Antares scan engine

export const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
export const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";
export const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
export const HELIUS_BASE = "https://mainnet.helius-rpc.com";
export const SOLSCAN_PUBLIC_BASE = "https://public-api.solscan.io";
export const SOLSCAN_BASE = "https://pro-api.solscan.io/v2.0";

// IMPORTANT: Keep in sync with shared/constants.ts
export const CA_RE = /^[A-Za-z0-9]{32,44}$/;

export const LP_PROGRAM_ADDRESSES = new Set([
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vAB",
]);

export const FOUNDATION_WALLETS = new Set([
  "B9n3tgBJ8f1K2VXrF5aTBNXXmj5V8sKXrk3GV5uPump",
  "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
  "9yrPkpCTBCqJmSmTtkMZoxFWMkrAPEQK6DkfaESMpump",
]);

export const OFFICIAL_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
  "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",
  "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",
]);

export const KNOWN_BRANDS = [
  "TRUMP","DOGE","PEPE","SHIB","BONK","WIF","BRETT",
  "FLOKI","MAGA","BIDEN","ELON","SOLANA","SOL","BTC",
  "ETH","SUI","APT","ARB","OP","MATIC","AVAX",
  "POPCAT","BOME","WEN","PONKE","NEIRO","MOODENG",
];

export const COPYCAT_SUFFIXES = ["2","V2","V3","OFFICIAL","REAL","NEW","PLUS","INU","AI","GPT","X","PRO","CLASSIC"];

export const LAYER_WEIGHTS: Record<string, number> = {
  dexscreener: 0.18,
  rugcheck: 0.18,
  goplus: 0.18,
  helius: 0.18,
  solscan: 0.10,
  chart: 0.10,
  identity: 0.08,
};
// crossvalidation n'a PAS de poids - c'est un multiplicateur post-score

// Cross-validation penalty multipliers (extracted from scoring.ts)
export const XV_PENALTY_LP_BURN = 0.85;
export const XV_PENALTY_MINT_AUTH = 0.70;
export const XV_PENALTY_AGE = 0.90;
export const XV_PENALTY_HOLDER_CONCENTRATION = 0.80;
export const ESTABLISHED_BONUS_MULTIPLIER = 1.15;
export const ESTABLISHED_AGE_THRESHOLD_HOURS = 720;
export const ESTABLISHED_HOLDERS_THRESHOLD = 1000;

// Trust floor for geometric mean — prevents single-layer nuking
export const TRUST_FLOOR = 0.001;

