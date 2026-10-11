// api/_lib/pro-gate.ts — what a Free caller of /api/scan is given. The Pro/Free line is drawn HERE, on the server.
//
// Until now the line was only a button: the overlay greyed out "Critical Flags", "Full Analysis" and "AI Summary" for a Free tier, but
// /api/scan sent every caller the full analysis (all the layers, the text of every flag, the AI summary, the critical actors...), and
// token.html displayed it to anyone who opened the URL. A paywall that lives in the client is not a paywall.
//
// Free keeps what the Free overlay shows: the verdict and the score, the Sell/Mint/Freeze/LP/Liquidity line, and the public market
// data (price, liquidity, the DexScreener pair, the chart). Pro adds the analysis: the layers and sources, the text of the flags, the
// AI summary, the holders, the critical actors, the verdict history.
//
// It is an ALLOWLIST, on purpose: a field added to the scan tomorrow is Pro until someone decides otherwise here, never Free by
// accident. Verdicts and scores are computed from the full scan before this runs; nothing here can change them.
import type { VercelResponse } from "@vercel/node";
import { countsInOverlaySummary } from "../../shared/flag-summary";
import type { Tier } from "./user";

/** The fields of a scan a Free caller receives, as they are. */
export const FREE_SCAN_FIELDS = [
  // The verdict and what the overlay prints around it.
  "risk",
  "score",
  "resolvedMint",
  "tokenName",
  "tokenSymbol",
  "tokenLogo",
  // The Sell / Mint / Freeze / LP line of the overlay.
  "honeypot",
  "mintAuthority",
  "freezeAuthority",
  "lpBurned",
  "lpLocked",
  "lpLockedPct",
  "lpLockDurationDays",
  // Public market data (DexScreener, GeckoTerminal): anybody can read it on those sites.
  "pair",
  "priceUsd",
  "marketCap",
  "liquidity",
  "volume24h",
  "volume1h",
  "priceChange5m",
  "priceChange1h",
  "priceChange24h",
  "pairCreatedAt",
  "candles",
  // Plumbing, no analysis in it.
  "scoring_version",
  "fetchedAt",
  "requestId",
] as const;

/** What the placeholder flags say. The overlay counts them; it never prints them (the panel that does is Pro). */
export const PRO_FLAG_PLACEHOLDER = "Part of Antares Pro";

interface ScanLike {
  risk: string;
  score: number;
  flags: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** True for the body of a scan answer (not for an error body, a health check...). */
export function isScanBody(body: unknown): body is ScanLike {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.risk === "string" && typeof b.score === "number" && Array.isArray(b.flags);
}

/**
 * The Free view of a scan.
 *
 * `flags` is the delicate one. The Free overlay prints "N flags — M critical", counted from the array: dropping it would make a DANGER
 * token read "No issues found". So every flag the overlay counts becomes a placeholder that keeps its severity (that is what the
 * count reads) and loses its text and its weight; the flags the overlay never counts (bonuses, notes, plumbing) are dropped.
 */
export function redactScanForFree(scan: ScanLike): Record<string, unknown> {
  if (scan.proLocked === true) return scan;
  const view: Record<string, unknown> = { proLocked: true };
  for (const key of FREE_SCAN_FIELDS) {
    if (scan[key] !== undefined) view[key] = scan[key];
  }
  view.flags = scan.flags
    .filter((f) => countsInOverlaySummary(f))
    .map((f) => ({ label: PRO_FLAG_PLACEHOLDER, severity: f.severity, impact: 0 }));
  return view;
}

/**
 * Makes every scan this response sends the Free view, when the caller is on the Free tier. It wraps `res.json`, so no answer path of
 * the handler (cache hit, coalesced scan, cold scan...) can forget it, and a path added later is covered too. Error bodies pass
 * through untouched.
 */
export function enforceProGate(res: VercelResponse, tier: Tier): void {
  if (tier !== "free") return;
  const send = res.json.bind(res);
  res.json = ((body: unknown) => send(isScanBody(body) ? redactScanForFree(body) : body)) as VercelResponse["json"];
}
