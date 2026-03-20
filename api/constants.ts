// api/constants.ts — All constants for Antares scan engine

export const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
export const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";
export const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
export const HELIUS_BASE = "https://mainnet.helius-rpc.com";
export const SOLSCAN_PUBLIC_BASE = "https://public-api.solscan.io";
export const SOLSCAN_BASE = "https://pro-api.solscan.io/v2.0";

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
  dexscreener: 0.20,
  rugcheck: 0.20,
  goplus: 0.25,
  helius: 0.20,
  solscan: 0.10,
  chart: 0.05,
};

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
