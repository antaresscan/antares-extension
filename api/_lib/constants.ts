// api/_lib/constants.ts — All constants for Antares scan engine

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
export const SOLSCAN_BASE = "https://pro-api.solscan.io/v2.0";
/**
 * The longest the scan WAITS for one RugCheck answer (its summary, its full report), in milliseconds.
 *
 * RugCheck answers in well under a second for almost every token (1,117 of the 1,121 recorded scans), but for the very largest tokens it does not:
 * measured live on 2026-10-14, BONK's report answered an error after 5.6 s and WIF's after 14.4 s, and both summaries did not answer within 30 s.
 * The scan used to wait for each call up to its own 5 s timeout AND a retry (10.5 s), then ask again for the resolved mint: BONK took 23 s of the 24 s
 * the scan has, WIF and JitoSOL 17 s, for a source that never came. Past this budget the scan goes on without RugCheck, as it does when RugCheck is
 * down: the call is not cancelled (a quick 429 retried after 500 ms still counts), it is no longer waited for.
 */
export const RUGCHECK_WAIT_MS = 4000;
/**
 * Solscan is read for TWO things: the real age of the token (`token/meta`, created_time) and its holder count (the same call, `holder`). One call per scan.
 *
 * The age: the older of Solscan's mint time and the chosen pool's age (#881). The holder count: as exact as the chain (on 40 real tokens, a median
 * difference of 0.0 % against Helius' count) and the only cheap source that is: once page 1 of Helius' token accounts is full (1,000 holders or more),
 * Solscan's count replaces the pages that followed (up to 9 more calls, 59 % of all the Helius calls of a scan), and it ranks before GoPlus and
 * RugCheck (GoPlus counts 1.03x the chain at the median, RugCheck 2-3x too many).
 *
 * The rest of what the scan can read from Solscan stays OFF. The plan is back (2026-10-13) after months of 401s during which none of it reached the
 * engine; letting it all in at once would wake code that no scan or replay has run in that time and change verdicts nobody measured: the Solscan layer
 * counted as a source (one more source makes a SAFE possible), wash-trading flags from the markets endpoint (which has never worked: it answers 400,
 * the token must be sent as an array), the creator's history (one more Helius call per scan), the Holder Activity transfers, and a -10 % trust on the
 * "age conflict" between Solscan's mint time and DexScreener's pool time (two different events, so they differ for most tokens).
 * Turning it off is a decision to measure, not a refactor.
 */
export const SOLSCAN_AGE_AND_HOLDERS_ONLY = true;

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

// Three labels below were wrong until the audit of 2026-10-17 (checked against the DexScreener answers of the replay corpus): the
// mints are those of TRUMP, BOME and PYTH, not of JUP, POPCAT and SPX6900 as written. Only the LABELS were corrected: what the set
// holds decides verdicts (layers.ts: the LP branch of RugCheck; facts.ts: "trusted" when GoPlus is silent), so which mints belong
// here is the owner's decision. POPCAT (7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr) and SPX6900 (J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr)
// are NOT in the set.
export const OFFICIAL_MINTS = new Set([
  "So11111111111111111111111111111111111111112",    // wSOL
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
  "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",  // TRUMP (OFFICIAL TRUMP) — was labelled "JUP"; JUP is JUPyiw... below
  "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",  // MEW
  "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",  // BOME (BOOK OF MEME) — was labelled "POPCAT"
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
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", // PYTH (Pyth Network) — was labelled "SPX6900 (Wormhole)"
]);

// Mint authorities that are a BRIDGE, not a person. Wormhole's Token Bridge mints a wrapped token on Solana when the original is locked on its own chain, and the
// authority of every wrapped mint is one program-derived address: PDA(["mint_signer"], wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb). No key exists for it, so no
// developer can inflate the supply on Solana. What it leaves is the risk of the ORIGINAL token and of the bridge, which is why the flag is a warning (never SAFE).
// __tests__/bridge-mint-authority.test.ts derives the address from the program, so the constant cannot be a typo.
export const BRIDGE_MINT_AUTHORITIES: ReadonlyMap<string, string> = new Map<string, string>([
  ["BCD75RNBHrJJpW4dXVagL5mPjzRLnVZq4YirJdjEYMV7", "Wormhole"],
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
const ENGINE_VERSION_MANUAL = "v69"; // 2026-10-21: a collapse of 75 % or more from a high 15 to 90 days old that is the ONLY risky flag of a token whose Sell, Mint, Freeze, LP and Liq cells are all green is a CAUTION (the flag shown as a warning), no longer a DANGER. v68 (2026-10-18): the biggest holders of the tokens with the most holders are no longer lost when Helius answers its transient "account index service overloaded" error (about nine scans in ten for TRUMP, RAY, JUP, PENGU, BONK): the call is asked again, then Helius's last list (a day, not for a new token), then RugCheck's own list (SAFE stays blocked, one line says it). The concentration flags (TRUMP: top 10 hold 88 %) and the SAFE of PENGU no longer depend on which scan Helius answered. Flushes the CAUTION / DANGER cached for these tokens. v67 (2026-10-16): the history of a token comes from Solscan alone (token/price, one price a day, line read at 89 %/84 %) and the relief of a concentrated top 10 and the softening of a bridge-held mint authority also need a LIVING market (Jupiter organic score >= 30), line kept at 90 %/85 % on Solscan's numbers: BAN, JELLYJELLY, ALCH, NST, UNI wrapped (score 0) go back to DANGER/RUG. v66 (2026-10-16): the all-time high read from a second source. v65 (2026-10-16): SAFE needs a market of $100k, all the pools added up (SAFE_MIN_MARKET_DEPTH_USD): under it a token with nothing else against it is CAUTION, with one warning that says why (40 dead memecoins of the corpus were SAFE). Flushes the SAFE cached for these tokens. v64 (2026-10-16): a token of 90 days and $5M of cap or more that has collapsed (lost 90 % or more from its all-time high, CoinGecko) carries a warning (ATH_FLAG_*): never SAFE, and a DANGER with two other warnings (GRIFFAIN, LION). Flushes the SAFE and CAUTION cached for these tokens. v63 (2026-10-16): a token the market has proven is not condemned for who holds its supply unless it has collapsed (lost 90 % or more from its all-time high, ATH_COLLAPSE_PCT): a concentrated top 10 or one big wallet is a warning (TOP10_RELIEF_*, depth read on all its pools), and a mint authority held by the Wormhole bridge (BRIDGE_MINT_AUTHORITIES) is a warning that keeps it out of SAFE and no longer makes the contract "not clean" for the LP rule. RugCheck's concentration risks are counted once on such a token. Flushes the DANGER / RUG cached for CARDS, MET, BC, DBR, HUMA, ANSEM, SPX, JUP, RAY. v62 (2026-10-14): an issuer-backed token of the registry (stablecoin, tokenized stock, LST, wrapped, yield, vault) whose market cannot be read (DexScreener silent or no pool) keeps its verdict (SAFE on enough sources, one information line), and the verdict of the last time its market WAS read is served again with its age (scannedAgoSec). Flushes the CAUTION cached for these tokens during an outage.

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

// ── CLEAN TOKEN = SAFE ───────────────────────────────────────────────────────────────────────────
// A token with no visible warning or critical flag, no hard block reason, verified holders and no price-pump notice is SAFE (the
// "no-flags override" of determineVerdict): the overlay prints "No issues found" for it, so the verdict must say SAFE. It used to need 4
// answering sources, and a scan where a source was slow or down (typically GoPlus or RugCheck) came back CAUTION with "No issues found"
// next to it, then flipped to SAFE on the next scan. 3 sources: DexScreener plus two of Helius / GoPlus / RugCheck / the chart.
export const MIN_SOURCES_FOR_CLEAN_SAFE = 3;

// ── HARD BLOCK REASONS (single source of truth) ──────────────
export const HARD_BLOCK_REASONS = new Set([
  "lp", "deceptive_name", "honeypot", "mint", "freeze",
  "bundle", "rug_pattern", "wash_trading", "sniper", "pump", "chart", "low_holders", "token_extension",
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
// Helius getTokenAccounts page size. A page that comes back with FEWER accounts than this holds every holder, so the
// count is exact; a full page only proves "at least this many" (the cursor is sent either way, it is not a signal).
export const HOLDER_PAGE_LIMIT = 1000;
// Pages read for the holder count (page 1, then 2..N in parallel only when page 1 is full): exact up to N x 1000 holders.
// Measured live: about 65 ms a page, 12 parallel pages all answered in 400 ms. Above the cap GoPlus is used, with the
// pages read so far as a floor. Each call is a DAS request (10 credits per Helius' pricing page, plan limit 10 req/s).
export const HOLDER_MAX_PAGES = 10;
// Pages 2..N are asked in WAVES of growing size (2, 3, 4... pages), each wave only when the previous one did not already reach the end
// of the list: pages after the end of the list (or after a failed page) can never change the count, and at 10 credits a page they were
// 24 % of all the DAS calls of 365 real scans.
// A token whose holders another source (GoPlus) already counts at this many or more is not changed by the pages either: with the pages
// capped at HOLDER_PAGE_LIMIT x HOLDER_MAX_PAGES holders, the count shown is that source's (see pickHolderCount). Twice the cap, and not
// just above it, because GoPlus is NOT exact: on the 167 recorded tokens where both are known it counts 1.03x the chain at the median,
// 1.16x at the 95th percentile and up to 1.80x at the worst (BURNIE: chain 9,818, GoPlus 11,186, which a threshold at 1.1x would have
// changed). Twice the cap leaves room above the worst case seen; the full replay of the 365 tokens must stay identical.
export const HOLDER_COUNT_KNOWN_ABOVE = HOLDER_PAGE_LIMIT * HOLDER_MAX_PAGES * 2;
// How long the holder pages wait for that other count once page 1 is full. It is asked in parallel (GoPlus answers in ~450 ms).
export const HOLDER_COUNT_WAIT_MS = 800;
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
// A token that has lost almost all its value since its recent high has COLLAPSED, whatever the last 24 hours look like. The short-term
// rules read 5 min / 1 h / 6 h / 24 h only, and the 7 / 30-day reading only looked for pumps: a crash older than a day was invisible
// (GOIF, -98 % from its high two days earlier, was shown CAUTION).
export const COLLAPSE_DROP_PCT    = 75; // down 75 % or more from the highest close of the last COLLAPSE_WINDOW_DAYS → critical (the owner's rule: a token that lost 75 % has rugged)
export const COLLAPSE_RECENT_DAYS = 14; // ... from a high of the LAST 14 DAYS: a collapse in progress → forced RUG and "RUG PULL"
// The owner's rule (2026-10-21; TripleT, -77 % from a high 89 days old, LP burned, authorities cut, a $539k pool, was DANGER on that flag alone): a collapse from a high 15 to 90 days old that is the ONLY risky flag of
// a token whose Sell, Mint, Freeze, LP and Liq cells are ALL green is a CAUTION, the flag shown as a warning. Never SAFE (a visible warning blocks it); a collapse from a high of the last 14 days stays a RUG.
export const COLLAPSE_SOFT_MIN_LIQUIDITY_USD = 50_000; // the overlay's green line for the Liq cell (components.ts: > $50k): under it the structure is not "all green"
export const COLLAPSE_SOFT_MIN_SCORE = 700; // the floor of a CAUTION on the soft path of determineVerdict: a softened collapse reads at least this score
export const COLLAPSE_WINDOW_DAYS = 90; // ... from a high 15 to 90 days old: critical alone, the verdict follows the other flags (DANGER, or RUG when they force it), EXCEPT when it is the only risky flag and the five cells of the overlay are green (CAUTION: see COLLAPSE_SOFT_*). Older highs are not read: a blue chip can lose 75 % over a year
// A blue chip, by the market alone (the owner's bar, 2026-10-12): three numbers the scan already has, no holders, no authority, no LP.
// A price crash on such a token is a violent market move to watch (critical, so DANGER at least), not a forced RUG.
export const BLUECHIP_MIN_AGE_DAYS      = 60;        // traded for at least 2 months
export const BLUECHIP_MIN_LIQUIDITY_USD = 100_000;   // in the pool whose price is falling. The load-bearing number: without it a collapsed token (NEON, -61 % on 24 h, $73k) passes. Not lower: no blue chip has a pool under $100k. Not higher: W, ZBCN, PHY... are real tokens with a thin DEX pool.
export const BLUECHIP_MIN_MARKET_CAP_USD = 5_000_000;
// SAFE is the top verdict: it needs a market a holder can leave. The owner's own bar for a blue chip is a $100k pool ("no blue chip has a pool under $100k"), read here on ALL the pools
// of the token added up (its liquidity is split between pools). Under it a token that has nothing else against it is CAUTION. Measured on the 1 121 recorded tokens: 5 days later, the
// SAFE or CAUTION tokens with a pool under $100k were gone or drained 5 times in 94, those above 1 time in 173; 12 of the 13 tokens that the weak labels call dumped and the engine calls SAFE are there.
export const SAFE_MIN_MARKET_DEPTH_USD = 100_000;
// A token that lost 90 % or more from its highest price has COLLAPSED (the owner's rule, 2026-10-16: a token that lost more than 90 % has rugged). ONE line, shared by everything
// that reads the all-time high: such a token gets no relief and no softening (the top-10 relief below, a mint authority held by a bridge), and carries a warning (the flag).
// Measured on the 642 recorded tokens whose highest price is known (intraday): SPX (-84.6 %), JUP (-84.3 %) and RAY (-89.0 %), which the owner names as real tokens, are under the line; YZY (-90.2 %),
// ZEREBRO (-93.6 %), TRUNK (-96.3 %), LUNA (-98.4 %) and MELANIA (-99.3 %) are over it. A line at 80 % would refuse SPX, JUP and RAY too. Next to the line (RAY 89.0, YZY 90.2,
// CLOUD 89.96) a token would change side with a few percent of price, and a verdict that flips from one scan to the next is not credible. So the line has a memory (api/_lib/ath.ts,
// judgeHistory): a token ENTERS "collapsed" at ATH_COLLAPSE_PCT and LEAVES it only when it stands less than ATH_COLLAPSE_EXIT_PCT below its high (a rally of a third of its price
// from the line), whatever its price does in between.
export const ATH_COLLAPSE_PCT = 90;
export const ATH_COLLAPSE_EXIT_PCT = 85;
// The owner's rule is "a token that lost more than 90 % from its highest price has rugged", and it is read as it is on the highest price Solscan gives (token/price: ONE price per day, so a
// little under an intraday high: PYTH, measured live on 2026-10-16, 1.10 against 1.20). A LOWER line to make up for it was tried (89 %) and refused by the market: RAY, which the owner names
// as a real token, stands at -89.3 % today and a line at 89 % made it a DANGER again on the first live scan; a daily high is never above the intraday one, so the daily fall is never above
// the intraday one and 90 % on the daily numbers leaves RAY a point of margin. A token that spiked and dumped within hours (YZY, GRIFFAIN) has a daily high far under its intraday one and
// stands under the line: that is NOT repaired by a lower line (JUP -84 %, SPX -85 % and RAY -89 %, which the owner names as real tokens, would be refused too), it is repaired by asking
// whether the market is alive (LIVING_MARKET_MIN_ORGANIC_SCORE below).
// Top-10 relief (the owner's idea, 2026-10-15). A token the MARKET has proven keeps a concentrated top 10 and one big wallet as a WARNING (CAUTION at most) instead of a CRITICAL
// (DANGER / RUG): on such a token the top 10 is exchanges, treasuries and vaults. The market cap alone is not a proof (a thin pool fakes it: WLFI "$5.7B" with $28k of pools), so the
// market must also be deep, the holders many and the authorities cut, and its history must not be a collapse (ATH_COLLAPSE_PCT). An unknown all-time high (Solscan silent, or
// without the token) is no relief.
export const TOP10_RELIEF_MIN_MARKET_CAP_USD = 25_000_000;
// Depth of the market: ALL the pools the token is the base of (its liquidity is split between pools: RAY 30, BONK 30, CARDS 22), in dollars AND in proportion to the cap. The proportion
// alone refused JUP ($4.6M of pools for a $1.2B cap, 0.38 %: it trades on exchanges, the pools follow the price); the dollars alone let a faked cap through. A faked cap sits under
// 0.05 % (WLFI 0.0005 %); the real tokens measured sit between 0.1 % (PYTH) and 3 % (RAY).
export const TOP10_RELIEF_MIN_POOL_DEPTH_USD = 1_000_000;
export const TOP10_RELIEF_MIN_POOL_PCT_OF_CAP = 0.001;
export const TOP10_RELIEF_MIN_HOLDERS = 10_000;
export const TOP10_RELIEF_MAX_TOP10 = 0.90;   // from this share the top 10 is control whatever the market says
export const TOP10_RELIEF_MAX_SINGLE = 0.60;  // one wallet above this share is a control risk whatever the market says
// The all-time high is read from Solscan Pro (token/price: one USD price per day, the plan we already pay for) and from nothing else. How far back it looks: Solana tokens that matter all
// date from 2021 or later. A day whose price is more than SOLSCAN_PRICE_SPIKE_FACTOR times that of BOTH its neighbours is a glitch of the feed, not a price (a daily close does not rise
// tenfold and fall back tenfold in the days around it), and it is replaced by the higher of its neighbours so that one bad point cannot fake a collapse on a serious token.
export const SOLSCAN_PRICE_FROM = "20210101";
export const SOLSCAN_PRICE_SPIKE_FACTOR = 10;
// A LIVING market. The relief of a concentrated top 10 and the softening of a bridge-held mint authority are for a token whose market is alive, not for a token that only has a pool and a
// cap: Jupiter's organic score (real activity, not wash trading or a single bot) is 0 for the tokens that the owner doubts (BAN, JELLYJELLY, ALCH, NST, UNI wrapped: 0) and 49 or more for
// every other token the engine relieves (BC 49, HUMA 54, DBR 62, NPC 62, SPX 73, MET 82, JUP 95: measured on the 19 relieved tokens of the 1 121 recorded). Nothing lies between 1 and
// 48, and 30 is the middle of the empty gap. It does what the all-time high cannot do for a launch that spiked and dumped within hours (a daily price misses the spike): YZY, MELANIA,
// LUNA and TRUNK are at 0 whatever their history says.
export const LIVING_MARKET_MIN_ORGANIC_SCORE = 30;
// The all-time-high flag: a token that has collapsed (ATH_COLLAPSE_PCT, 90 %) says so, in a WARNING: it is never SAFE, and with two other warnings it is a DANGER; it is never a
// critical on its own, because the same fall describes BONK (-95 %), WIF (-96 %), PYTH (-92 %) and JTO (-92 %), real tokens that a critical would send to DANGER. It is read for a token
// of 90 days or more (a younger one is read by the 90-day collapse rule) and $5M of cap or more: below it there are thousands of tokens that nobody scans twice, and measured on
// the 1 121 recorded tokens the flag without that floor moved 136 verdicts (128 SAFE to CAUTION, 108 of them under $5M) against 21 with it.
export const ATH_FLAG_MIN_AGE_DAYS = 90;
export const ATH_FLAG_MIN_MARKET_CAP_USD = 5_000_000;
// Below these moves it is no longer a market-wide sell-off, whatever the token: the RUG stays forced (the -75 % collapse rule, from a
// 90-day high, needs the chart source; these two numbers do not).
export const BLUECHIP_CRASH_FLOOR_6H  = -70; // %
export const BLUECHIP_CRASH_FLOOR_24H = -75; // %
export const COLLAPSE_MIN_CANDLES = 6;  // 6 x 4 h = 24 h of history: before that, the 1 h / 6 h / 24 h rules already see the whole life
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
export const SCORING_VERSION = "7.7.21";

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
export const SOFT_REASONS: Record<string, boolean> = { age: true, lp_unverified: true, pump_imbalance: true, concentration_light: true, bridge_mint: true };

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
