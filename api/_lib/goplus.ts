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

export interface GoPlusHazards {
  /** Authorities still held by someone, in plain words: "mint", "freeze", "permanent delegate", "transfer fee", "transfer hook". */
  authorities: string[];
  /** A soulbound token: it cannot be transferred, so it cannot be sold. */
  nonTransferable: boolean;
  /** New token accounts are frozen by default: nobody can sell until the freeze authority thaws them. */
  defaultFrozen: boolean;
  /** Highest Token-2022 transfer fee, current or scheduled, in basis points (0 when there is none). */
  transferFeeBps: number;
  /** A transfer-hook program is set: it runs on every transfer. */
  transferHook: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** GoPlus's authority objects: { authority: [...], status: "1" } when held. */
const held = (v: unknown): boolean => isRecord(v) && String(v.status ?? "") === "1";

/** An authority object's state: true when held, false when revoked, null when it does not say. */
const heldOrNull = (v: unknown): boolean | null => {
  if (!isRecord(v)) return null;
  const status = String(v.status ?? "");
  return status === "1" ? true : status === "0" ? false : null;
};

/**
 * Mint and freeze authority the way the clients show them: held (true), revoked
 * (false), or null when GoPlus gave no answer or no such object. Not the same as
 * goplusHazards, where an absent answer reads as "nothing found": a Mint check mark
 * must never come from a token nobody looked at.
 */
export function goplusAuthorityState(goplus: GoPlusTokenResult | null | undefined): { mint: boolean | null; freeze: boolean | null } {
  return { mint: heldOrNull(goplus?.mintable), freeze: heldOrNull(goplus?.freezable) };
}

/**
 * What GoPlus says can still hurt a holder of a Solana token. Every field is read
 * defensively, since an unexpected shape must degrade to "nothing found", not throw.
 * The fields were checked on real answers (HAWK, USDG, TSLAx, ORCA, CASH): the
 * Token-2022 hazards (non-transferable, frozen by default, a transfer fee or hook)
 * did not occur in the 505 corpus tokens, so their handling is tested on
 * hand-built answers.
 */
export function goplusHazards(goplus: GoPlusTokenResult | null | undefined): GoPlusHazards {
  const g = goplus ?? {};
  const authorities: string[] = [];
  if (held(g.mintable)) authorities.push("mint");
  if (held(g.freezable)) authorities.push("freeze");
  if (held(g.balance_mutable_authority)) authorities.push("permanent delegate");

  const fee = isRecord(g.transfer_fee) ? g.transfer_fee : null;
  const rates: number[] = [];
  if (fee) {
    const current = isRecord(fee.current_fee_rate) ? toNumber(fee.current_fee_rate.fee_rate) : NaN;
    if (Number.isFinite(current)) rates.push(current);
    if (Array.isArray(fee.scheduled_fee_rate)) {
      for (const r of fee.scheduled_fee_rate) {
        const n = isRecord(r) ? toNumber(r.fee_rate) : NaN;
        if (Number.isFinite(n)) rates.push(n);
      }
    }
  }
  // Only a transfer fee someone can still change is an authority worth naming.
  if (fee && Object.keys(fee).length > 0 && held(g.transfer_fee_upgradable)) authorities.push("transfer fee");

  const hook = Array.isArray(g.transfer_hook) ? g.transfer_hook.length > 0 : isRecord(g.transfer_hook) && Object.keys(g.transfer_hook).length > 0;
  if (held(g.transfer_hook_upgradable)) authorities.push("transfer hook");

  return {
    authorities,
    nonTransferable: String(g.non_transferable ?? "") === "1",
    defaultFrozen: String(g.default_account_state ?? "") === "2",
    transferFeeBps: rates.length > 0 ? Math.max(0, ...rates) : 0,
    transferHook: hook,
  };
}
