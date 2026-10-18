// api/_lib/holders-memory.ts — the biggest holders of a token when Helius does not give them (and how long an old list may stand in).
//
// Why it exists (measured on 2026-10-18, real Helius answers from Vercel): `getTokenLargestAccounts` answers the tokens with the most holders (TRUMP, RAY, JUP, PENGU, BONK) with
// {"error":{"code":-32603,"message":"account index service overloaded, please try again."}} and an HTTP 200, about nine times out of ten; the tokens with fewer holders
// (WIF, HAWK, SNKRZ, PNUT) never get it. The scan read `result.value ?? []` from that, found nothing, and the whole Helius layer went missing for the very tokens that are scanned most:
// no concentration flag at all on TRUMP (DANGER 893 instead of DANGER 525 with its "Top 10 hold 88 %"), no SAFE possible for PENGU, a score that moved from one scan to the next.
//
// Three steps, in this order (the first that gives a list wins; the layer is only missing when none does):
//   1. ask again (fetchers.ts heliusGetLargestAccounts: two short attempts, the error is transient). Not even asked when the last list is under half an hour old: a list that is given takes
//      2 to 6 s on these tokens, and the scan of a token that was scanned a minute ago has no reason to pay it again;
//   2. the last list Helius gave for this token, kept ABOUT A DAY, served only for a token that is not new (the 20 biggest wallets of an established token move slowly, a launch's do not);
//   3. the 20 biggest holders that RugCheck already gives in its report (same chain state, the same first account and the same 88 % for TRUMP, measured): the concentration is then read,
//      but it was not verified by a second source, so the SAFE verdict stays blocked (decide.ts) and a line says so.
// Same rules as the organic score (jupiter.ts) and the all-time high (ath.ts): Redis missing or failing never stops a scan, a preview deployment keeps its own entries.
import type { HeliusHolder } from "./types";
import { getCacheRedis } from "./cache";
import { deploymentNamespace } from "./deployment";
import { logger } from "./logger";

/** How long the last list stays in Redis. */
export const HOLDERS_KEEP_S = 3 * 24 * 3600;
/** How old the last list may be to be served instead of nothing. The top 20 of an established token moves slowly; after a day it is no longer a picture of today. */
export const HOLDERS_STALE_MAX_S = 24 * 3600;
/** A list younger than this is served without asking Helius again (see step 1 above), unless the scan was asked to be fresh. */
export const HOLDERS_FRESH_S = 30 * 60;
/** A token younger than this (minutes, the age of its pool) never gets an old list: its holders change in minutes, and the layer saying "unverified" is the honest answer. */
export const HOLDERS_STALE_MIN_AGE_MIN = 3 * 24 * 60;

/** Where the list a scan reads came from. "helius": live. "helius-last": Helius, a few hours ago. "public-rpc": the free RPC pool. "rugcheck": RugCheck's report (not verified by a second source). */
export type HoldersSource = "helius" | "helius-last" | "public-rpc" | "rugcheck";

export const holdersLastKey = (mint: string): string => `antares:holders-last:${deploymentNamespace()}${mint}`;

interface Kept {
  at: number;
  holders: HeliusHolder[];
}

const isHolder = (h: unknown): h is HeliusHolder => {
  const x = h as Partial<HeliusHolder> | null;
  return !!x && typeof x.address === "string" && x.address.length > 0 && typeof x.uiAmount === "number" && Number.isFinite(x.uiAmount) && x.uiAmount >= 0;
};

/** Keep the list Helius just gave (a few lines of Redis, once per scan that got one). Never throws. */
export async function rememberHolders(mint: string, holders: HeliusHolder[]): Promise<void> {
  const redis = getCacheRedis();
  if (!redis || holders.length === 0) return;
  try {
    await redis.set(holdersLastKey(mint), { at: Date.now(), holders: holders.filter(isHolder) } satisfies Kept, { ex: HOLDERS_KEEP_S });
  } catch (e: unknown) {
    logger.warn("holders-memory", "the list was not kept", { error: String(e) });
  }
}

/**
 * The last list Helius gave for this token, with its age in seconds, when it may be served: not older than HOLDERS_STALE_MAX_S, and the token is not new (an unknown age is not "not new").
 * Never throws. `now` is a parameter for the tests.
 */
export async function lastKnownHolders(mint: string, tokenAgeMinutes: number | null, now: number = Date.now()): Promise<{ holders: HeliusHolder[]; ageS: number } | null> {
  if (tokenAgeMinutes === null || !Number.isFinite(tokenAgeMinutes) || tokenAgeMinutes < HOLDERS_STALE_MIN_AGE_MIN) return null;
  const redis = getCacheRedis();
  if (!redis) return null;
  try {
    const kept = await redis.get<Kept>(holdersLastKey(mint));
    if (!kept || typeof kept !== "object" || typeof kept.at !== "number" || !Array.isArray(kept.holders)) return null;
    if (now - kept.at > HOLDERS_STALE_MAX_S * 1000 || kept.at > now + 60_000) return null;
    const holders = kept.holders.filter(isHolder);
    return holders.length > 0 ? { holders, ageS: Math.max(0, Math.round((now - kept.at) / 1000)) } : null;
  } catch (e: unknown) {
    logger.warn("holders-memory", "the last list was not read", { error: String(e) });
    return null;
  }
}

/**
 * May RugCheck's list stand in for Helius's? RugCheck counts the pool and vault accounts as holders: the layer tells them apart with the DEXScreener pair addresses and the known pool programs
 * (and, for Helius's list, with a call that finds the program that owns each owner). So only a token that is not new (its pools are AMM pools, whose address DEXScreener gives; a launch's bonding
 * curve is not one: a new token keeps the honest "unverified") and whose pools are known (DEXScreener answered) may use it. Without that, the vault of a pool would be read as a whale.
 */
export function rugCheckListMayStandIn(tokenAgeMinutes: number | null, dexPairCount: number): boolean {
  return tokenAgeMinutes !== null && Number.isFinite(tokenAgeMinutes) && tokenAgeMinutes >= HOLDERS_STALE_MIN_AGE_MIN && dexPairCount > 0;
}

/** One holder of the RugCheck report (the fields the engine reads). */
interface RugCheckHolder {
  address?: unknown;
  owner?: unknown;
  uiAmount?: unknown;
}

/**
 * The 20 biggest holders of the RugCheck report, in the shape the Helius layer reads (token account, its owner, amount). [] when the report has none (topHolders absent or null: 9 of the
 * 1 117 recorded reports) or when an entry is unusable: an incomplete list would be a wrong concentration, so it is all or nothing.
 */
export function holdersFromRugCheck(topHolders: unknown): HeliusHolder[] {
  if (!Array.isArray(topHolders) || topHolders.length === 0) return [];
  const out: HeliusHolder[] = [];
  for (const raw of topHolders as RugCheckHolder[]) {
    if (!raw || typeof raw.address !== "string" || raw.address.length === 0) return [];
    const amount = typeof raw.uiAmount === "number" ? raw.uiAmount : Number(raw.uiAmount);
    if (!Number.isFinite(amount) || amount < 0) return [];
    out.push({ address: raw.address, owner: typeof raw.owner === "string" && raw.owner.length > 0 ? raw.owner : raw.address, uiAmount: amount });
  }
  // Largest first, as getTokenLargestAccounts gives them (the layer reads the first as the top holder).
  return out.sort((a, b) => b.uiAmount - a.uiAmount);
}
