// api/_lib/condemned.ts — A token that has rugged stays a RUG.
//
// The owner's rule (2026-10-12): "from the moment we have flagged a rug, the token is condemned". Until now every scan decided the verdict again
// from today's data alone, so a token whose pool was drained, or whose sells were blocked, could read SAFE again later: the liquidity came
// back, the honeypot was patched, the price flat for a while, the window of a rule ended. A rug does not stop being a rug because the
// numbers calmed down, and a user who sees SAFE on a token that already rugged is the worst thing this product can show.
//
// WHAT CONDEMNS: a scan whose verdict is RUG *and* confirmed by a fact (RugKind "confirmed": a drained pool, a collapse...)
// on complete data. A RUG that only comes from structure ("RUG RISK": concentration, authorities, a young token...) does NOT condemn: it is a
// risk, it can honestly go away (an authority renounced, a holder who sold), and an issuer's stablecoin must not be condemned for its
// authorities. A scan that ran out of time or had no source never condemns (the data was not there), and neither does a preview deployment
// (it shares the database with production, see deployment.ts).
//
// WHAT IT DOES: from then on, every fresh scan of that token reads the record and holds the verdict at RUG PULL, with a critical flag that says
// when it was flagged and why. The record is kept for good (no TTL): the first flag wins (SET NX), so the date never moves.
//
// A MISTAKE: delete the Redis key `condemned:<mint>` (and `rug:<mint>`, the public list): the next fresh scan decides from the data again.
// Redis being down never changes a verdict: reading fails open (no record), and writing fails silent.

import type { Redis } from "@upstash/redis";
import type { Decision } from "./decide";
import type { RugKind, Verdict } from "./types";
import { makeFlag } from "./helpers";
import { logger } from "./logger";

export interface CondemnedEntry {
  mint: string;
  symbol: string | null;
  /** When the token was first flagged (epoch ms). Never moves. */
  condemnedAt: number;
  /** The critical flags that said it, as the scan showed them (at most 3). */
  evidence: string[];
}

const CONDEMNED_PREFIX = "condemned:";
const MAX_EVIDENCE = 3;

let redis: Redis | null = null;

export function initCondemned(r: Redis): void {
  redis = r;
}

/** Whether this scan condemns the token: a RUG confirmed by a fact, on complete data, from production. */
export function shouldCondemn(input: { risk: Verdict; rugKind: RugKind | null; degraded: boolean; preview: boolean }): boolean {
  return input.risk === "RUG" && input.rugKind === "confirmed" && !input.degraded && !input.preview;
}

/** The record to keep for a scan that condemns. */
export function condemnedEntryOf(decision: Pick<Decision, "flags">, mint: string, symbol: string | null, now = Date.now()): CondemnedEntry {
  return {
    mint,
    symbol,
    condemnedAt: now,
    evidence: decision.flags.filter((f) => f.severity === "critical").slice(0, MAX_EVIDENCE).map((f) => f.label),
  };
}

/** The record of a condemned token, or null (never condemned, no Redis, or Redis failed: a failure never changes a verdict). */
export async function getCondemned(mint: string): Promise<CondemnedEntry | null> {
  if (!redis) return null;
  try {
    const entry = await redis.get<CondemnedEntry>(`${CONDEMNED_PREFIX}${mint}`);
    return entry && typeof entry.condemnedAt === "number" ? entry : null;
  } catch {
    return null;
  }
}

/** Condemn a token. Keeps the first record (the date of the first flag), with no expiry. */
export async function condemn(entry: CondemnedEntry): Promise<void> {
  if (!redis) return;
  try {
    const created = await redis.set(`${CONDEMNED_PREFIX}${entry.mint}`, entry, { nx: true });
    if (created) logger.warn("condemned", "token condemned", { mint: entry.mint, evidence: entry.evidence });
  } catch {
    // Non-critical: the next scan that sees the evidence tries again.
  }
}

/**
 * Hold a condemned token at RUG PULL, whatever today's data says. Pure: the decision in, the decision out.
 * A token that is not condemned, or whose decision is already a RUG PULL, comes back untouched.
 */
export function applyCondemnation(decision: Decision, entry: CondemnedEntry | null): Decision {
  if (!entry) return decision;
  if (decision.risk === "RUG" && decision.rugKind === "confirmed") return decision;

  const date = new Date(entry.condemnedAt).toISOString().slice(0, 10);
  const why = entry.evidence[0] ? ` (${entry.evidence[0]})` : "";
  const flag = makeFlag(`Flagged as a rug on ${date}${why} — a token that has rugged stays flagged`, "critical", 0);

  return {
    ...decision,
    risk: "RUG",
    rugKind: "confirmed",
    score: Math.min(decision.score, 100),
    safeBlocked: true,
    flags: [flag, ...decision.flags],
    notes: [
      ...decision.notes,
      { message: "condemned token held at RUG", data: { wasRisk: decision.risk, wasScore: decision.score, condemnedAt: entry.condemnedAt } },
    ],
  };
}
