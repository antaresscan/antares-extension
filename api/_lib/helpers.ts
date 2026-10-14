// api/helpers.ts — Utility functions for Antares scan engine
// Re-exports split modules for backward compatibility

import type { VercelResponse } from "@vercel/node";
import type {
  Severity, ScanFlag, SafeBlockedReason, FlagTag, Verdict, RugKind,
  GoPlusTokenResult, GoPlusResponse,
  DexScreenerResponse, RugCheckSummary, RugCheckReport, RugCheckRisk,
} from "./types";
import {
  GoPlusTokenResultSchema,
  RugCheckSummarySchema,
  RugCheckReportSchema,
  HeliusLargestAccountsResponseSchema,
  HeliusSupplyResponseSchema,
} from "./upstream-schemas";

// Re-export split modules
export { asNumber, _mean, _std, _pct } from "./math";
export { withTimeout, fetchJson, fetchJsonPost } from "./http";

// Import for local use
import { asNumber } from "./math";

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function pickGoPlusResult(raw: unknown, ca: string): GoPlusTokenResult | null {
  if (!isObject(raw)) return null;
  const result = (raw as GoPlusResponse)?.result;
  if (!result || typeof result !== "object") return null;
  const picked = result[ca] || result[ca.toLowerCase()] || result[ca.toUpperCase()] || null;
  if (!picked) return null;
  // Validate shape at runtime — if upstream changes a type unexpectedly,
  // drop the result instead of feeding malformed data to the scoring layer.
  const parsed = GoPlusTokenResultSchema.safeParse(picked);
  return parsed.success ? parsed.data : null;
}

export function goPlusBool(val: unknown): boolean {
  return val === "1" || val === 1 || val === true;
}

/** The classification a flag carries, set by the layer that creates it (see ScanFlag.reasons). Empty lists are left out of the flag. */
export interface FlagCodes { reasons?: SafeBlockedReason[]; fallbackReasons?: SafeBlockedReason[]; tags?: FlagTag[]; pumpPct?: number }

export function makeFlag(label: string, severity: Severity, impact: number, codes?: FlagCodes): ScanFlag {
  const flag: ScanFlag = { label, severity, impact };
  if (codes?.reasons?.length) flag.reasons = codes.reasons;
  if (codes?.fallbackReasons?.length) flag.fallbackReasons = codes.fallbackReasons;
  if (codes?.tags?.length) flag.tags = codes.tags;
  if (typeof codes?.pumpPct === "number") flag.pumpPct = codes.pumpPct;
  return flag;
}

export function getLpLockDurationDays(rugData: RugCheckSummary): number {
  const raw = rugData?.lpLockDurationDays ?? rugData?.lpLockDuration ?? rugData?.lockDurationDays ?? 0;
  return asNumber(raw);
}

export function riskIncludes(data: RugCheckSummary | RugCheckReport | null | undefined, matcher: RegExp): boolean {
  if (!data || !Array.isArray(data.risks)) return false;
  return data.risks.some((r: RugCheckRisk) => matcher.test(String(r?.name || "")));
}

export function settled<T>(p: Promise<T>): Promise<T | null> {
  return p.then(v => v).catch(() => null);
}

// Cap a promise at a fixed duration. If it resolves within budget, returns its
// value (or null on rejection). If the timer fires first, returns null so the
// caller can proceed with partial data instead of hanging the whole pipeline.
//
// Used in scan.ts to bound each upstream fetch: when one source (e.g. Helius)
// is slow, the others still return real data and scoring can degrade
// gracefully instead of hitting the global 9s timeout and returning 504.
export function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.then(v => v).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Runs `run`; when it answers null FAST (an upstream that refuses at once: a rate limit, a shut breaker, a burst of scans that Helius could not
 * follow), waits `delayMs` and asks once more, provided `timeLeftMs()` still leaves `minLeftMs` for the second try. A SLOW null (a timeout) is not
 * asked again: it already spent the time the second try would need. At most two calls, never more.
 */
export async function retryOnFastNull<T>(
  run: () => Promise<T | null>,
  opts: {
    fastMs: number;
    delayMs: number;
    minLeftMs: number;
    timeLeftMs: () => number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T | null> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = now();
  let first: T | null = null;
  try { first = await run(); } catch { first = null; }
  if (first !== null) return first;
  if (now() - t0 > opts.fastMs) return null;
  if (opts.timeLeftMs() < opts.delayMs + opts.minLeftMs) return null;
  await sleep(opts.delayMs);
  try { return await run(); } catch { return null; }
}

/**
 * Cache TTL is asymmetric by verdict — that's deliberate, not a bug:
 *
 * Bad verdicts (RUG / DANGER) get a LONG TTL. The reasoning is one-sided:
 * if we serve a stale RUG verdict for the next 30 minutes, the worst case
 * is the user does not buy a possibly-now-fine token — annoying but safe.
 *
 * Good verdicts (SAFE / CAUTION) on a young token get a SHORT TTL.
 * If we serve a stale SAFE verdict for 10 minutes and the token rugs in
 * that window, the user buys based on the stale verdict and loses money.
 * Conservative bias here is non-negotiable for a security product.
 *
 * For SAFE / CAUTION on established tokens, age-based TTL kicks in: state
 * is empirically stable, so we save Helius / DexScreener quota by caching
 * longer. This is the only case where a long TTL is allowed for a "good"
 * verdict.
 *
 * The function never returns less than 20s — protecting upstream APIs
 * from a thundering herd if the same volatile token is scanned by many
 * users in seconds.
 */
export function computeCacheTTL(
  tokenAgeMinutes: number | null,
  verdict?: "SAFE" | "CAUTION" | "DANGER" | "RUG",
): number {
  // Bad verdicts get a long TTL irrespective of age. Stale-bad is safe;
  // stale-good is dangerous.
  if (verdict === "RUG") return 1800;     // 30 min — rug is permanent, conservative cache OK
  if (verdict === "DANGER") return 600;   // 10 min — danger is sticky

  // Good (or unknown) verdict: fall back to age-based TTL. Short TTL on
  // young tokens because a SAFE verdict on a 10-minute-old token can flip
  // to RUG within seconds — we must not serve that stale.
  if (tokenAgeMinutes === null) return 60;
  if (tokenAgeMinutes < 30) return 20;
  if (tokenAgeMinutes < 60) return 45;
  if (tokenAgeMinutes < 1440) return 120;     // < 1 day
  if (tokenAgeMinutes < 10080) return 300;    // < 1 week
  return 600;                                  // established
}

// ─── What the overlay may do with an answer it holds ───────────────────────────────────────────────────────────────
//
// Two questions, answered by the server (so they can be tuned without a new version of the extension):
//   - freshForSec: for how long may the overlay show this answer without asking again? 5 minutes, as it always did, but 30 s for a degraded
//     answer: it was born from data that was not there (a DexScreener outage, an upstream out of time), and the server itself keeps it 30 s.
//   - staleLeftSec: if the scanner cannot be reached later (an outage, no network), for how much longer may the overlay STILL show this answer,
//     marked as old, instead of an error screen? The same asymmetry as computeCacheTTL, pushed further: a stale bad verdict is safe (the worst
//     case is a token not bought), a stale good one is not (a token can rug in the window, and the user acts on the old SAFE).
//     - RUG confirmed by a fact: 24 h (a rug does not un-rug, and the server condemns it for life).  RUG as a risk: 2 h.  DANGER: 1 h.
//     - SAFE or CAUTION: by the age of the token, because a young token flips in minutes and an established one is stable:
//       under 1 h or unknown: never; under 1 day: 3 min; under 1 week: 10 min; under 30 days: 20 min; older: 45 min.
//       And never when the token was moving fast (1 h change of 25 % or more either way): the old word is the one that misleads.
//     - A degraded answer is never shown stale as SAFE or CAUTION, and a bad one at most 10 min (it may be a false alarm born from missing data).
//   The window counts from the moment the verdict was MADE (fetchedAt), not from when the overlay received it.

export const OVERLAY_FRESH_SEC = 300;
export const OVERLAY_FRESH_DEGRADED_SEC = 30;
/** A SAFE or CAUTION on a token that moved this much (percent, either way) in the last hour is not shown stale. */
export const STALE_MAX_MOVE_1H_PCT = 25;

export interface ServeWindowSource {
  risk: Verdict;
  rugKind?: RugKind | null;
  degraded?: boolean;
  pairCreatedAt: number | null;
  solscanTokenAgeHours: number | null;
  priceChange1h: number | null;
  fetchedAt: number;
  /** The verdict of the last time the market was read, served again: the answer says how old it is (scannedAgoSec). */
  servedFromMemory?: boolean;
}

/** The age of the token in minutes, at the time of the scan: the younger of what DexScreener (its pool) and Solscan (its creation) say. */
function tokenAgeMinutesAtScan(r: ServeWindowSource): number | null {
  const ages: number[] = [];
  if (typeof r.pairCreatedAt === "number" && Number.isFinite(r.pairCreatedAt) && Number.isFinite(r.fetchedAt)) ages.push((r.fetchedAt - r.pairCreatedAt) / 60000);
  if (typeof r.solscanTokenAgeHours === "number" && Number.isFinite(r.solscanTokenAgeHours)) ages.push(r.solscanTokenAgeHours * 60);
  return ages.length ? Math.max(0, Math.min(...ages)) : null;
}

/** How long, in seconds from the moment the verdict was made, this answer may be shown stale. */
export function staleWindowSec(r: ServeWindowSource): number {
  if (r.risk === "RUG" || r.risk === "DANGER") {
    const base = r.risk === "DANGER" ? 3600 : r.rugKind === "confirmed" ? 24 * 3600 : 2 * 3600;
    return r.degraded ? Math.min(base, 600) : base;
  }
  if (r.degraded) return 0;
  const move = r.priceChange1h;
  if (typeof move === "number" && Number.isFinite(move) && Math.abs(move) >= STALE_MAX_MOVE_1H_PCT) return 0;
  const age = tokenAgeMinutesAtScan(r);
  if (age === null || age < 60) return 0;
  if (age < 1440) return 180;
  if (age < 10080) return 600;
  if (age < 43200) return 1200;
  return 2700;
}

/** The two windows to send with an answer, at the moment it is sent. */
export function serveWindows(r: ServeWindowSource, nowMs: number = Date.now()): { freshForSec: number; staleLeftSec: number } {
  const ageSec = Number.isFinite(r.fetchedAt) ? Math.max(0, (nowMs - r.fetchedAt) / 1000) : Infinity;
  return {
    freshForSec: r.degraded ? OVERLAY_FRESH_DEGRADED_SEC : OVERLAY_FRESH_SEC,
    staleLeftSec: Math.max(0, Math.floor(staleWindowSec(r) - ageSec)),
  };
}

/** The answer as it is sent: the scan, plus its two windows. A copy: what is stored (Redis, memory) is never modified. */
export function withServeWindows<T extends ServeWindowSource>(r: T, nowMs: number = Date.now()): T & { freshForSec: number; staleLeftSec: number; scannedAgoSec?: number } {
  const out: T & { freshForSec: number; staleLeftSec: number; scannedAgoSec?: number } = { ...r, ...serveWindows(r, nowMs) };
  if (r.servedFromMemory === true && Number.isFinite(r.fetchedAt)) out.scannedAgoSec = Math.max(0, Math.floor((nowMs - r.fetchedAt) / 1000));
  return out;
}

/** From this age a token has traded long enough for GeckoTerminal to hold candles for it (the 5-minute window needs ~15 min). */
export const CHART_EXPECTED_AFTER_MINUTES = 30;

/**
 * A SAFE or CAUTION verdict born WITHOUT the chart layer, for a token old enough to have candles, is usually a GeckoTerminal rate
 * limit (429) and not a property of the token: the next try reaches the chart and may give another verdict (audit M11: the same
 * token flipped between SAFE and CAUTION depending on which instance answered). Such a result must not stick for the full TTL.
 * A bad verdict is not concerned: a stale RUG or DANGER is safe, and the chart can only make it worse (see computeCacheTTL).
 * `chartAvailable` is `undefined` when the response carries no chart layer at all: nothing is assumed then.
 */
export function isChartGapDegraded(
  verdict: "SAFE" | "CAUTION" | "DANGER" | "RUG",
  chartAvailable: boolean | undefined,
  tokenAgeMinutes: number | null,
): boolean {
  if (verdict !== "SAFE" && verdict !== "CAUTION") return false;
  if (chartAvailable !== false) return false;
  return tokenAgeMinutes !== null && tokenAgeMinutes >= CHART_EXPECTED_AFTER_MINUTES;
}

/**
 * A SAFE or CAUTION verdict reached from a PAIR address (the scan resolved the mint itself) WITHOUT the full RugCheck report is missing
 * four checks: bundle, snipers, rug history, creator sells (audit A-07). It is also written under the MINT's cache key, where it would
 * answer every later scan of that token for the full TTL. Such a result is kept only briefly, so the next try can read the report.
 * A bad verdict is not concerned (a stale RUG or DANGER is safe, and the missing checks can only make it worse), and neither is a scan
 * that started from the mint itself.
 */
export function isReportGapDegraded(
  verdict: "SAFE" | "CAUTION" | "DANGER" | "RUG",
  resolvedFromPair: boolean,
  reportAvailable: boolean,
): boolean {
  return resolvedFromPair && !reportAvailable && (verdict === "SAFE" || verdict === "CAUTION");
}

/**
 * The sources whose silence is an outage and not a property of the token. Measured on the 1 121 tokens of the replay corpus: Helius is
 * missing for 4, RugCheck for 4, GoPlus for 1 (DexScreener for 7, but "no pool" cannot be told from an outage, so it is not in this list).
 * Solscan is left out on purpose (it only gives the token's age and holder count, its layer is never available), and so is the chart,
 * which has its own rule by the age of the token (isChartGapDegraded).
 */
export const GAP_LAYERS = ["helius", "rugcheck", "goplus"] as const;

/**
 * The emergency switch of "Limited data". `LIMITED_DATA=off` (also "0", "false", "no") in the deployment's environment, then a redeploy (about a minute, no code
 * revert), and no scan is marked `sourceGap` any more: the overlay and the site show the engine's verdict again, as before. Everything else stays (a scan with a
 * silent source is still `degraded`, so it is cached 30 s only). For the day a source misbehaves for a whole class of tokens and "Limited data" shows where it should not.
 */
export function limitedDataEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !["off", "0", "false", "no"].includes(String(env.LIMITED_DATA ?? "").trim().toLowerCase());
}

/**
 * One of GAP_LAYERS did not answer, whatever the verdict. A missing source does not only close the door to SAFE: replayed on the 1 121 tokens
 * of the corpus with one source silent, Helius alone turned 172 SAFE into CAUTION, but also 132 RUG into DANGER and 22 RUG into CAUTION (the
 * concentration flags are gone), RugCheck turned 4 DANGER into SAFE. A verdict reached that way is not the token's: see holdLastVerdict.
 */
export function isLayerGap(layers: Partial<Record<string, { available?: boolean } | undefined>> | undefined): boolean {
  if (!layers) return false;
  return GAP_LAYERS.some((name) => layers[name]?.available === false);
}

/**
 * Was this scan made while a data source did not answer? Then it carries no verdict for the user (the overlay shows "Limited data", counts down and asks
 * again; the badge, the alerts, the history and the rug database ignore it), whatever the verdict it reached: replayed on the 1 121 tokens of the corpus
 * with one source silent, a SAFE read CAUTION, a DANGER read SAFE, a RUG read DANGER.
 *   - Helius, RugCheck, GoPlus: whatever the verdict (GAP_LAYERS, missing for under 1 % of tokens);
 *   - the chart of an old token and the RugCheck report of a pair address: for a SAFE or CAUTION only (isChartGapDegraded, isReportGapDegraded: a dead
 *     token has no candles, so for a bad verdict their absence says nothing), which the caller has already decided;
 *   - the scan ran out of time, or has no source at all.
 * Not in the list: DexScreener ("no pool" cannot be told from a token that has none) and Solscan (its layer is never available, it only gives the
 * token's age and holder count).
 */
export function isScanIncomplete(input: {
  layers: Partial<Record<string, { available?: boolean } | undefined>> | undefined;
  sourcesUsed: number;
  deadlineSpent: boolean;
  chartGap: boolean;
  reportGap: boolean;
}): boolean {
  return input.sourcesUsed === 0 || input.deadlineSpent || input.chartGap || input.reportGap || isLayerGap(input.layers);
}

export function apiError(res: VercelResponse, status: number, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: message, ...(details ? { details } : {}) });
}

/**
 * Match a hostname against the antares-website Vercel preview pattern.
 *
 * Vercel previews use predictable hostname shapes for branch builds:
 *   `<project>-git-<branch-hash>-<team>-projects.vercel.app`   (PR / branch)
 *   `<project>-<deploy-hash>-<team>-projects.vercel.app`       (one-off)
 *
 * We accept any host that ends in `.vercel.app` AND starts with
 * `antares-website-` (project slug + a separator).
 *
 * This is a *shape* check, NOT proof of ownership: anyone can create a
 * Vercel project called `antares-website-whatever` and get a matching
 * `*.vercel.app` hostname. A preview origin may therefore read public API
 * responses (QA, pre-merge testing) but must never be handed credentials;
 * see CREDENTIALED_ORIGINS in middleware.ts, which is an exact-match list.
 *
 * Production `antares-website.vercel.app` is matched via the explicit
 * ALLOWED_ORIGINS list (canonical, audit-friendly). This helper only adds
 * the *preview* deployments to the allowed set so QA and pre-merge testing
 * don't 403 with "Origin not allowed".
 */
function isAntaresWebsitePreview(hostname: string): boolean {
  return (
    hostname.endsWith(".vercel.app") &&
    hostname.startsWith("antares-website-")
  );
}

/**
 * Serialised origin (scheme + host + port) of an Origin header or URL, or
 * null when there is none to compare: opaque origins (`null`, `file://`,
 * `chrome-extension://…`) and anything unparseable.
 */
function originOf(value: string): string | null {
  try {
    const { origin } = new URL(value);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Exact origin match: scheme, host AND port must all agree. Comparing the
 * hostname alone let `http://antaresscan.com` (downgradable to a network
 * attacker) and `https://antaresscan.com:8443` through.
 */
export function isOriginInList(origin: string, list: readonly string[]): boolean {
  const o = originOf(origin);
  if (!o) return false;
  return list.some((entry) => originOf(entry) === o);
}

export function isCorsAllowed(origin: string, allowedOrigins: string[]): boolean {
  const o = originOf(origin);
  if (!o) return false;
  const { protocol, hostname } = new URL(o);
  if (protocol === "https:" && isAntaresWebsitePreview(hostname)) return true;
  return isOriginInList(o, allowedOrigins);
}
export function isValidDexScreenerResponse(data: unknown): data is DexScreenerResponse {
  if (!isObject(data)) return false;
  return Array.isArray(data.pairs) || data.pair !== undefined;
}

export function isValidRugCheckSummary(data: unknown): data is RugCheckSummary {
  if (!isObject(data)) return false;
  // Preserve the original "at least one of these keys is present" gate so
  // an empty response still fails fast. Zod adds the per-field type check.
  if (!("lpBurned" in data) && !("risks" in data) && !("error" in data)) return false;
  return RugCheckSummarySchema.safeParse(data).success;
}

// ─── RUNTIME TYPE GUARDS ─────────────────────────────────────────────────────

export function isHeliusLargestAccountsResponse(data: unknown): data is import("./types").HeliusLargestAccountsResponse {
  const parsed = HeliusLargestAccountsResponseSchema.safeParse(data);
  // The scoring layer expects `result.value` to be an array before it reads
  // holders from it. An empty/missing value is valid for Zod but useless to
  // us, so keep the stricter check here.
  return parsed.success && Array.isArray(parsed.data.result?.value);
}

export function isHeliusSupplyResponse(data: unknown): data is import("./types").HeliusSupplyResponse {
  const parsed = HeliusSupplyResponseSchema.safeParse(data);
  return parsed.success && parsed.data.result !== undefined;
}

export function isSolscanMarketsResponse(data: unknown): data is import("./types").SolscanMarketsResponse {
  if (!isObject(data)) return false;
  return Array.isArray(data.data);
}

export function isSolscanMeta(data: unknown): data is import("./types").SolscanMeta {
  if (!isObject(data)) return false;
  return "data" in data && isObject(data.data);
}

export function isSolscanTransfersResponse(data: unknown): data is import("./types").SolscanTransfersResponse {
  if (!isObject(data)) return false;
  return Array.isArray(data.data);
}

export function isRugCheckReport(data: unknown): data is import("./types").RugCheckReport {
  if (!isObject(data)) return false;
  if (!("risks" in data) && !("topHolders" in data) && !("totalHolders" in data)) return false;
  return RugCheckReportSchema.safeParse(data).success;
}

// ─── XSS SANITIZATION ────────────────────────────────────────────────────────
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function sanitizeString(val: string | null | undefined): string | null {
  if (val == null) return null;
  return String(val).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch] || ch);
}

export function sanitizeUrl(val: string | null | undefined): string | null {
  if (val == null) return null;
  const s = String(val).trim();
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}
