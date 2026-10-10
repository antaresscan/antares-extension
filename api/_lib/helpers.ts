// api/helpers.ts — Utility functions for Antares scan engine
// Re-exports split modules for backward compatibility

import type { VercelResponse } from "@vercel/node";
import type {
  Severity, ScanFlag,
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

export function makeFlag(label: string, severity: Severity, impact: number): ScanFlag {
  return { label, severity, impact };
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
