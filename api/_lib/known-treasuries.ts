// api/_lib/known-treasuries.ts
//
// Hardcoded allowlist of well-known Solana DAO / protocol tokens
// whose top-1 wallet is a known team multi-sig or DAO-governed
// treasury. The wallet COULD theoretically dump, but in practice the
// holdings are locked under DAO governance rules (timelock, multi-sig
// approval, vesting schedule) so flagging them as "concentration
// hard rug risk" is a credibility-killer false positive.
//
// This list is the data-quality fallback for Path 3 (blue-chip
// concentration exemption in pipeline.ts). The heuristic Path 3
// requires holders ≥ 50k AND lpBurned to fire — but when Solscan,
// RugCheck and GoPlus are simultaneously rate-limited / down, the
// holder count collapses to the Helius top-20 view (= 20) and the
// heuristic misses. This allowlist trips the same concentration
// exemption based on the mint address alone, immune to upstream
// data quality.
//
// CRITERIA for adding a token here:
//   1. Public DAO / protocol with multi-month track record
//   2. Top-holder concentration is documented (transparent multi-sig
//      / treasury / vesting), not a fresh-whale suspicion
//   3. Independent verification: at least one of CoinGecko top-200,
//      Solana Foundation grant recipient, or Phantom / Backpack
//      surfaced project
//
// REVIEW DISCIPLINE:
//   - Anyone adding a mint here must include a one-line justification
//     and a link to the DAO governance source.
//   - The list is intentionally short — a token that's borderline
//     should NOT land here. If we're not sure, we don't allowlist.
//   - Removed tokens stay in this file commented out, with a date,
//     so we can audit allowlist churn.

export const KNOWN_DAO_TREASURY_MINTS = new Set<string>([
  // ─── Liquid staking / validator tokens ─────────────────────────────
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", // JTO — Jito DAO. Validator-staking infrastructure, multi-year on-chain governance.

  // ─── DEX / AMM tokens ─────────────────────────────────────────────
  // ORCA, RAY pass the Path 3 heuristic naturally (50k+ holders) so
  // they don't need to be allowlisted. Keep them out unless data-
  // quality issues start making them miss.
  // "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", // ORCA — passes Path 3 heuristic
  // "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY  — passes Path 3 heuristic

  // ─── Aggregator / infra ───────────────────────────────────────────
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP — Jupiter aggregator DAO. Top-10 Solana market cap.

  // ─── Stablecoins (defensive — they hit the holders=20 fallback rarely) ─
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC — Circle. Reserve-backed, contract is non-rugable.
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT — Tether on Solana.

  // ─── DeFi protocol tokens ──────────────────────────────────────────
  "MangoCxNYY3AaAEqhxSQrbfnzLG4z6X9XwxYYeF9w8d", // MNGO — Mango Markets DAO.
])

/**
 * Returns true if the mint is a well-known DAO/protocol token whose
 * concentration should be treated as a soft concern (CAUTION ceiling)
 * rather than a hard rug-pull signal.
 *
 * Used by pipeline.ts applySafeGateOverride to bypass the heuristic
 * Path 3 holder/LP gates when we already KNOW the wallet structure
 * is benign.
 */
export function isKnownDaoTreasury(mint: string | null | undefined): boolean {
  if (!mint) return false
  return KNOWN_DAO_TREASURY_MINTS.has(mint)
}
