// api/_lib/goplus.ts — Reading GoPlus's Solana token_security answer.
//
// GET /api/v1/solana/token_security is not the EVM answer: it has `mintable`,
// `freezable`, `holders`, `dex`, `holder_count`, `total_supply`..., and none of
// `is_honeypot`, `mint_authority`, `sell_tax`... (checked on real answers for
// HAWK, USDG, TSLAx, ORCA and CASH, 2026-10-07). The engine already fetches this
// answer on every scan for `dex[].burn_percent` and `holder_count`; this module
// reads the rest of what it really contains.

import type { GoPlusTokenResult, HeliusHolder } from "./types";

const toNumber = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : NaN;
};

/** Total supply as a UI amount (decimals applied), 0 when GoPlus did not give one. */
export function goplusTotalSupply(goplus: GoPlusTokenResult | null | undefined): number {
  const n = toNumber(goplus?.total_supply);
  return n > 0 ? n : 0;
}

/** GoPlus's own holder count, null when absent or not a positive number. */
export function goplusHolderCount(goplus: GoPlusTokenResult | null | undefined): number | null {
  const raw = goplus?.holder_count;
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * GoPlus's top holders (2 to 10 of them), in the shape the holder layer reads
 * from Helius: `owner` is GoPlus's `account` (the wallet), `address` its
 * `token_account`, `uiAmount` the balance. Largest first.
 *
 * It is a fallback for when Helius returns no list. Same wallets, same amounts
 * as Helius on every token compared (HAWK 43.98%), and it costs no extra call.
 * A list that cannot be right is dropped rather than trusted: balances that add
 * up to more than the total supply.
 */
export function goplusHolderAccounts(goplus: GoPlusTokenResult | null | undefined): HeliusHolder[] {
  const list = goplus?.holders;
  if (!Array.isArray(list)) return [];

  const holders: HeliusHolder[] = [];
  for (const h of list) {
    const owner = typeof h?.account === "string" ? h.account : "";
    const uiAmount = toNumber(h?.balance);
    if (!owner || !(uiAmount > 0)) continue;
    const tokenAccount = typeof h?.token_account === "string" && h.token_account ? h.token_account : owner;
    holders.push({ address: tokenAccount, owner, uiAmount });
  }
  holders.sort((a, b) => b.uiAmount - a.uiAmount);

  const supply = goplusTotalSupply(goplus);
  if (supply > 0 && holders.reduce((sum, h) => sum + h.uiAmount, 0) > supply * 1.02) return [];
  return holders;
}
